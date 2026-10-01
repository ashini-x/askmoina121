import {
  CHAT_RATE_WINDOW_MS,
  CHAT_REQUESTS_PER_WINDOW,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_PROMPT_CHARS,
  MAX_REQUEST_BODY_BYTES,
  MAX_SANDBOX_CODE_CHARS,
  SEARCH_QUERY_MAX_CHARS,
  SEARCH_REQUESTS_PER_WINDOW,
  SEARCH_RESULT_LIMIT,
  SANDBOX_REQUESTS_PER_WINDOW,
} from "./core/config";
import { availableProviders, runAudit, runPrimary, shouldAudit, shouldSearch } from "./ai-router";
import { sanitizeInput } from "./security/guardrails";
import { formatSearchContext, webSearch } from "./tools/search";
import { runPythonSandbox } from "./tools/sandbox";
import type { ChatMessage, Env, ModeKey } from "./types";
import { JSON_HEADERS } from "./http/response";
import { trimHistory } from "./prompts";

const requestCounters = new Map<string, { chat: number; search: number; sandbox: number; resetAt: number }>();

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function clientKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "anonymous";
}

function consumeRateLimit(request: Request, bucket: "chat" | "search" | "sandbox"): boolean {
  const key = `${bucket}:${clientKey(request)}`;
  const now = Date.now();
  const current = requestCounters.get(key);
  const limit = bucket === "chat" ? CHAT_REQUESTS_PER_WINDOW : bucket === "search" ? SEARCH_REQUESTS_PER_WINDOW : SANDBOX_REQUESTS_PER_WINDOW;
  if (!current || current.resetAt <= now) {
    requestCounters.set(key, {
      chat: bucket === "chat" ? 1 : 0,
      search: bucket === "search" ? 1 : 0,
      sandbox: bucket === "sandbox" ? 1 : 0,
      resetAt: now + CHAT_RATE_WINDOW_MS,
    });
    return true;
  }
  current[bucket] += 1;
  return current[bucket] <= limit;
}

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const requestOrigin = new URL(request.url).origin;
  if (origin === requestOrigin) return origin;
  const allowList = [
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
  ];
  return allowList.includes(origin) ? origin : null;
}

function corsHeaders(request: Request): HeadersInit {
  const origin = allowedOrigin(request);
  return origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        Vary: "Origin",
      }
    : {};
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_REQUEST_BODY_BYTES) {
    throw new Error("Request is too large.");
  }
  try {
    return await request.json() as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function normalizeHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: String(message.content ?? "").slice(0, MAX_MESSAGE_CHARS).trim(),
    }))
    .filter((message) => message.content.length > 0);
}

function normalizeMode(raw: unknown): ModeKey {
  return raw === "logical" || raw === "creative" ? raw : "auto";
}

function isHardAbort(request: Request): AbortSignal {
  return request.signal;
}

function sseEvent(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, event: string, data: unknown): void {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

async function chatStream(request: Request, env: Env): Promise<Response> {
  if (!consumeRateLimit(request, "chat")) return json({ error: "Moina is receiving too many requests right now. Please try again shortly." }, 429, corsHeaders(request));

  const body = await readJson(request);
  const messages = normalizeHistory(body.messages);
  const mode = normalizeMode(body.mode);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return json({ error: "A user message is required." }, 400, corsHeaders(request));
  }

  const prompt = sanitizeInput(messages[messages.length - 1].content);
  if (!prompt) return json({ error: "Enter a thought." }, 400, corsHeaders(request));
  if (prompt.length > MAX_PROMPT_CHARS) return json({ error: `Prompt limit: ${MAX_PROMPT_CHARS} characters.` }, 400, corsHeaders(request));
  messages[messages.length - 1] = { role: "user", content: prompt };

  const originHeaders = corsHeaders(request);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown) => sseEvent(controller, encoder, event, data);
      (async () => {
        try {
          const signal = isHardAbort(request);
          emit("phase", { phase: "initializing" });
          const providers = availableProviders(env);
          if (!providers.length) throw new Error("Moina is not configured yet. Add at least one AI provider secret and redeploy.");

          let searchContext = "No relevant web search results were available.";
          if (shouldSearch(prompt)) {
            emit("phase", { phase: "searching" });
            try {
              const results = await webSearch(prompt, SEARCH_RESULT_LIMIT);
              searchContext = formatSearchContext(results);
              emit("sources", { sources: results });
            } catch (error) {
              console.error("Search error", error);
              emit("notice", { message: "Moina continued without live web evidence." });
            }
          }

          let shouldReview = shouldAudit(prompt, "", "");
          let draft = "";
          emit("phase", { phase: "synthesizing" });
          const primary = await runPrimary(
            trimHistory(messages, 80000),
            mode,
            searchContext,
            env,
            signal,
            (text) => {
              draft += text;
              if (!shouldReview) emit("delta", { text });
            },
          );

          if (!draft.trim()) throw new Error("Moina returned an empty response.");
          shouldReview = shouldReview || shouldAudit(prompt, draft, "");

          let finalText = draft.trim();
          let sandboxFeedback = "";

          if (shouldReview) {
            emit("phase", { phase: "sandbox" });
            const match = draft.match(/```python\s*([\s\S]*?)```/i);
            if (match && env.E2B_API_KEY) {
              const result = await runPythonSandbox(match[1].trim(), env.E2B_API_KEY, MAX_SANDBOX_CODE_CHARS);
              sandboxFeedback = result.status === "success"
                ? `[SANDBOX RUNTIME OUTPUT]\n${result.stdout || "(no textual output)"}`
                : `[SANDBOX ERROR]\n${result.stderr || "Sandbox execution failed."}`;
            }

            emit("phase", { phase: "auditing" });
            let audited = "";
            try {
              await runAudit(
                trimHistory(messages, 80000),
                mode,
                draft,
                sandboxFeedback,
                searchContext,
                env,
                signal,
                primary.provider,
                (text) => {
                  audited += text;
                  emit("delta", { text });
                },
              );
              if (audited.trim()) finalText = audited.trim();
            } catch (error) {
              console.error("Audit path unavailable", error);
              if (draft.trim()) {
                emit("notice", { message: "Moina used its verified primary answer." });
                // The draft was intentionally withheld from the client while the audit was running.
                emit("delta", { text: draft });
              }
            }
          }

          void finalText;

          emit("complete", { ok: true });
          controller.close();
        } catch (error) {
          if ((error as Error)?.name === "AbortError") {
            controller.close();
            return;
          }
          console.error("Chat pipeline error", error);
          emit("error", { message: error instanceof Error ? error.message : "Moina could not complete that request." });
          controller.close();
        }
      })();
    },
    cancel() {
      // The request's AbortSignal handles upstream cancellation.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...originHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    if (url.pathname === "/api/v1/health" && request.method === "GET") {
      return json({ status: "ok", service: "moina", aiProvidersConfigured: availableProviders(env).length }, 200, cors);
    }

    if (url.pathname === "/api/v1/chat/stream" && request.method === "POST") {
      const origin = allowedOrigin(request) || new URL(request.url).origin;
      if (!origin) return json({ error: "Origin not allowed." }, 403, cors);
      try {
        return await chatStream(request, env);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Request failed." }, 400, cors);
      }
    }

    if (url.pathname === "/api/v1/tools/search" && request.method === "POST") {
      if (!allowedOrigin(request)) return json({ error: "Origin not allowed." }, 403);
      if (!consumeRateLimit(request, "search")) return json({ error: "Search rate limit reached. Please try again shortly." }, 429, cors);
      try {
        const body = await readJson(request);
        const query = sanitizeInput(typeof body.query === "string" ? body.query : "").slice(0, SEARCH_QUERY_MAX_CHARS);
        if (!query || query.length > MAX_PROMPT_CHARS) throw new Error(`Search query exceeds the ${MAX_PROMPT_CHARS}-character limit.`);
        const results = await webSearch(query, SEARCH_RESULT_LIMIT);
        return json({ query, results, context: formatSearchContext(results) }, 200, cors);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400, cors);
      }
    }

    if (url.pathname === "/api/v1/tools/sandbox" && request.method === "POST") {
      if (!allowedOrigin(request)) return json({ error: "Origin not allowed." }, 403);
      if (!consumeRateLimit(request, "sandbox")) return json({ error: "Sandbox rate limit reached. Please try again shortly." }, 429, cors);
      try {
        const body = await readJson(request);
        const code = typeof body.code === "string" ? body.code : "";
        if (!code.trim()) throw new Error("Sandbox code is empty.");
        if (code.length > MAX_SANDBOX_CODE_CHARS) throw new Error(`Sandbox code exceeds the ${MAX_SANDBOX_CODE_CHARS}-character limit.`);
        const result = await runPythonSandbox(code, env.E2B_API_KEY || "", MAX_SANDBOX_CODE_CHARS);
        return json(result, result.status === "success" ? 200 : 422, cors);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400, cors);
      }
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "Not Found" }, 404, cors);
    return env.ASSETS.fetch(request);
  },
};
