import {
  CHAT_RATE_WINDOW_MS,
  CHAT_REQUESTS_PER_WINDOW,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_MODEL_HISTORY_CHARS,
  MAX_PROMPT_CHARS,
  MAX_REQUEST_BODY_BYTES,
  MAX_SANDBOX_CODE_CHARS,
  SEARCH_QUERY_MAX_CHARS,
  SEARCH_REQUESTS_PER_WINDOW,
  SEARCH_RESULT_LIMIT,
  SANDBOX_REQUESTS_PER_WINDOW,
} from "./core/config";
import {
  availableProviders,
  runFinalReview,
  runIndependentVerification,
  runPrimary,
  shouldAudit,
  shouldSearch,
} from "./ai-router";
import { sanitizeInput } from "./security/guardrails";
import { formatSearchContext, webSearch } from "./tools/search";
import { runPythonSandbox } from "./tools/sandbox";
import type { ChatMessage, Env, ModeKey } from "./types";
import { handleAdminRequest } from "./admin";
import { beginRequest, finishRequest, errorClassFrom, type OpsExecutionContext } from "./telemetry";
import { JSON_HEADERS } from "./http/response";
import { classifySpecialPrompt, specialPromptResponse, trimHistory } from "./prompts";

const requestCounters = new Map<string, { chat: number; search: number; sandbox: number; resetAt: number }>();

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function clientKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "anonymous";
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
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BODY_BYTES) throw new Error("Request is too large.");
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object.");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === "JSON body must be an object.") throw error;
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

function sseEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: string,
  data: unknown,
): void {
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function safeCodeBlock(draft: string): string | null {
  const match = String(draft).match(/```(?:python|py)\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() || null;
}

function sandboxContext(result: Awaited<ReturnType<typeof runPythonSandbox>>): string {
  return result.status === "success"
    ? `[SANDBOX RUNTIME OUTPUT]\n${result.stdout || "(no textual output)"}`
    : `[SANDBOX ERROR]\n${result.stderr || "Sandbox execution failed."}`;
}

function publicErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "");
  const lower = raw.toLowerCase();
  if (/quota|rpd|tpd|daily limit|rate.?limit|\b429\b|capacity|overload|at capacity/.test(lower)) {
    return "Moina is temporarily at capacity. Please try again in a moment.";
  }
  if (/timeout|timed out|exceeded 45s/.test(lower)) {
    return "Moina took too long to respond. Please try again.";
  }
  if (/not configured|api key|unauthori[sz]|forbidden|\b401\b|\b403\b/.test(lower)) {
    return "Moina is temporarily unavailable. Please try again later.";
  }
  if (/empty response|no answer text|invalid json|malformed/.test(lower)) {
    return "Moina could not produce a response this time. Please try again.";
  }
  if (error instanceof DOMException && error.name === "AbortError") return "Request cancelled.";
  return "Moina could not complete that request. Please try again.";
}

async function chatStream(request: Request, env: Env, ctx: OpsExecutionContext): Promise<Response> {
  if (!consumeRateLimit(request, "chat")) {
    return json({ error: "Moina is receiving too many requests right now. Please try again shortly." }, 429, corsHeaders(request));
  }

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

  const requestId = crypto.randomUUID();
  const requestStartedAt = Date.now();
  await beginRequest(ctx, env, {
    requestId,
    mode,
    audited: shouldAudit(prompt),
    searchUsed: shouldSearch(prompt),
    sandboxUsed: false,
  });

  const originHeaders = corsHeaders(request);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown) => sseEvent(controller, encoder, event, data);

      (async () => {
        let searchUsed = shouldSearch(prompt);
        let sandboxUsed = false;
        let draft = "";
        try {
          const signal = request.signal;
          emit("phase", { phase: "initializing" });

          const special = classifySpecialPrompt(prompt);
          if (special) {
            emit("phase", { phase: "finalizing" });
            emit("delta", { text: specialPromptResponse(special) });
            emit("complete", { ok: true });
            finishRequest(ctx, env, { requestId, finalStatus: "success_unverified", verificationStatus: "not_requested", durationMs: Date.now() - requestStartedAt, audited: false, searchUsed: false, sandboxUsed: false });
            controller.close();
            return;
          }

          const providers = availableProviders(env);
          if (!providers.length) { finishRequest(ctx, env, { requestId, finalStatus: "error", verificationStatus: "not_requested", durationMs: Date.now() - requestStartedAt, audited: shouldAudit(prompt), searchUsed: shouldSearch(prompt), sandboxUsed: false, errorClass: "not_configured" }); throw new Error("Moina is not configured yet. Add at least one AI provider secret and redeploy."); }

          let searchContext = "No relevant web search results were available.";
          if (searchUsed) {
            emit("phase", { phase: "searching" });
            try {
              const results = await webSearch(prompt, SEARCH_RESULT_LIMIT, signal);
              searchContext = formatSearchContext(results);
              emit("sources", { sources: results });
            } catch (error) {
              if (signal.aborted) throw new DOMException("Request cancelled.", "AbortError");
              console.error("Search error", error);
              emit("notice", { message: "Moina continued without live web evidence." });
            }
          }

          const history = trimHistory(messages, MAX_MODEL_HISTORY_CHARS);
          emit("phase", { phase: "synthesizing" });

          const primary = await runPrimary(history, mode, searchContext, env, signal, (text) => {
            draft += text;
            // Simple requests can stream immediately. Reviewed requests remain
            // buffered so the user never sees an answer that is later replaced.
            if (!shouldAudit(prompt)) emit("delta", { text });
          }, requestId, ctx);

          if (!draft.trim()) throw new Error("Moina returned an empty response.");

          const needsReview = shouldAudit(prompt, draft, "");
          if (!needsReview) {
            emit("complete", { ok: true });
            finishRequest(ctx, env, {
              requestId,
              finalStatus: "success_unverified",
              verificationStatus: "not_requested",
              durationMs: Date.now() - requestStartedAt,
              primaryProvider: primary.provider,
              audited: false,
              searchUsed,
              sandboxUsed: false,
            });
            controller.close();
            return;
          }

          let sandboxFeedback = "";
          const code = safeCodeBlock(draft);
          sandboxUsed = Boolean(code && env.E2B_API_KEY);
          if (sandboxUsed && code && env.E2B_API_KEY) {
            emit("phase", { phase: "sandbox" });
            const result = await runPythonSandbox(code, env.E2B_API_KEY, MAX_SANDBOX_CODE_CHARS);
            sandboxFeedback = sandboxContext(result);
          }

          emit("phase", { phase: "verifying" });
          let referenceAnswer = "";
          let verifierProvider = primary.provider;
          try {
            const independent = await runIndependentVerification(
              history,
              mode,
              sandboxFeedback,
              searchContext,
              env,
              signal,
              primary.provider,
              requestId,
              ctx,
            );
            referenceAnswer = independent.text;
            verifierProvider = independent.context.provider;
          } catch (error) {
            console.error("Independent verification unavailable", error);
          }

          // If no independent pass is available, the primary answer is still
          // useful. We do not pretend it was independently verified.
          if (!referenceAnswer.trim()) {
            emit("notice", { message: "Moina completed the answer without an independent verification pass." });
            emit("delta", { text: draft });
            emit("complete", { ok: true });
            finishRequest(ctx, env, { requestId, finalStatus: "success_unverified", verificationStatus: "unavailable", durationMs: Date.now() - requestStartedAt, primaryProvider: primary.provider, audited: true, searchUsed, sandboxUsed });
            controller.close();
            return;
          }

          emit("phase", { phase: "finalizing" });
          let finalText = "";
          try {
            const preferredFinalProviders = [
              ...(["cloudflare", "gemini", "groq"] as const),
              primary.provider,
              verifierProvider,
            ].filter((value, index, list) => list.indexOf(value) === index && value !== verifierProvider);

            const reviewed = await runFinalReview(
              history,
              mode,
              draft,
              referenceAnswer,
              sandboxFeedback,
              searchContext,
              env,
              signal,
              preferredFinalProviders,
              requestId,
              ctx,
            );
            finalText = reviewed.text;
          } catch (error) {
            console.error("Final review unavailable", error);
          }

          const usedFallbackFinal = !finalText.trim();
          if (usedFallbackFinal) finalText = referenceAnswer.trim() || draft.trim();
          if (!finalText.trim()) throw new Error("Moina returned an empty response.");

          emit("delta", { text: finalText });
          emit("complete", { ok: true });
          finishRequest(ctx, env, {
            requestId,
            finalStatus: usedFallbackFinal ? "success_degraded" : "success",
            verificationStatus: "completed",
            durationMs: Date.now() - requestStartedAt,
            primaryProvider: primary.provider,
            verifierProvider,
            audited: true,
            searchUsed,
            sandboxUsed,
          });
          controller.close();
        } catch (error) {
          if ((error as Error)?.name === "AbortError") {
            controller.close();
            return;
          }
          console.error("Chat pipeline error", error);
          finishRequest(ctx, env, { requestId, finalStatus: "error", verificationStatus: "unavailable", durationMs: Date.now() - requestStartedAt, audited: shouldAudit(prompt), searchUsed: shouldSearch(prompt), sandboxUsed: Boolean(/```(?:python|py)\s*[\s\S]*```/i.test(draft) && env.E2B_API_KEY), errorClass: errorClassFrom(error instanceof Error ? error.message : error) });
          emit("error", { message: publicErrorMessage(error) });
          controller.close();
        }
      })();
    },
    cancel() {
      // The request AbortSignal handles upstream cancellation.
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
      "X-Moina-Request-ID": requestId,
    },
  });
}

export default {
  async scheduled(_controller: { cron: string; scheduledTime: number; noRetry?: () => void }, env: Env): Promise<void> {
    if (!env.OPS_DB) return;
    try {
      // Keep operational telemetry bounded. User prompts and model outputs are not stored.
      await env.OPS_DB.prepare(`DELETE FROM provider_events WHERE timestamp < datetime('now', '-30 days')`).run();
      await env.OPS_DB.prepare(`DELETE FROM request_sessions WHERE started_at < datetime('now', '-30 days')`).run();
      await env.OPS_DB.prepare(`DELETE FROM admin_sessions WHERE expires_at < datetime('now') OR revoked_at < datetime('now', '-7 days')`).run();
      await env.OPS_DB.prepare(`DELETE FROM admin_oauth_states WHERE expires_at < datetime('now')`).run();
    } catch (error) {
      console.error('[ops] telemetry cleanup failed', error);
    }
  },

  async fetch(request: Request, env: Env, ctx: OpsExecutionContext): Promise<Response> {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    if (url.pathname === "/admin.html") {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/api/v1/admin/")) {
      const adminResponse = await handleAdminRequest(request, env);
      if (adminResponse) return adminResponse;
    }

    if (url.pathname === "/api/v1/health" && request.method === "GET") {
      return json({ status: "ok", service: "moina" }, 200, cors);
    }

    if (url.pathname === "/api/v1/chat/stream" && request.method === "POST") {
      if (request.headers.get("Origin") && !allowedOrigin(request)) {
        return json({ error: "Origin not allowed." }, 403, cors);
      }
      try {
        return await chatStream(request, env, ctx);
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
        if (!query) throw new Error("Search query is empty.");
        const results = await webSearch(query, SEARCH_RESULT_LIMIT, request.signal);
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
