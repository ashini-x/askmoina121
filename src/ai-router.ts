import type { Env, ModeKey, ProviderName } from "./types";
import { auditSystemPrompt, buildAuditPrompt, buildPrimaryPrompt, primarySystemPrompt, trimHistory } from "./prompts";

export interface ProviderContext {
  provider: ProviderName;
  model: string;
}

export interface StreamOptions {
  mode: ModeKey;
  systemPrompt: string;
  messages: ReturnType<typeof trimHistory>;
  signal: AbortSignal;
  onText: (text: string) => void;
}

interface ProviderFailure extends Error {
  status?: number;
  provider: ProviderName;
  retryAfterMs?: number;
  dailyQuota?: boolean;
}

const cooldowns = new Map<ProviderName, number>();

const MODEL_CONFIG: Record<ProviderName, { model: string; label: string }> = {
  gemini: { model: "gemini-3.8-flash", label: "Moina" },
  groq: { model: "openai/gpt-oss-120b", label: "Moina" },
  cloudflare: { model: "@cf/nvidia/nemotron-3-120b-a12b", label: "Moina" },
};

function modeThinkingLevel(mode: ModeKey): "low" | "medium" | "high" {
  if (mode === "logical") return "high";
  if (mode === "creative") return "medium";
  return "high";
}

function providerAvailable(provider: ProviderName, env: Env): boolean {
  if (provider === "gemini") return Boolean(env.GEMINI_API_KEY);
  if (provider === "groq") return Boolean(env.GROQ_API_KEY);
  return Boolean(env.AI?.run);
}

function isCoolingDown(provider: ProviderName): boolean {
  return (cooldowns.get(provider) || 0) > Date.now();
}

function setCooldown(provider: ProviderName, ms: number): void {
  const until = Date.now() + Math.max(1_000, Math.min(ms, 24 * 60 * 60 * 1000));
  cooldowns.set(provider, until);
}

function parseRetryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(1000, date - Date.now());
  return undefined;
}

function failure(provider: ProviderName, response: Response, message: string): ProviderFailure {
  const retryAfterMs = parseRetryAfter(response);
  const lower = message.toLowerCase();
  const dailyQuota = /rpd|per day|daily|quota|tokens per day|tpd/.test(lower);
  const error = new Error(message) as ProviderFailure;
  error.provider = provider;
  error.status = response.status;
  error.retryAfterMs = retryAfterMs;
  error.dailyQuota = dailyQuota;
  return error;
}

function genericFailure(provider: ProviderName, errorValue: unknown): ProviderFailure {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  const error = new Error(message) as ProviderFailure;
  error.provider = provider;
  error.status = Number((errorValue as { status?: number })?.status || 0) || undefined;
  return error;
}

async function consumeSSE(
  stream: ReadableStream<Uint8Array> | ReadableStream<string>,
  onEvent: (data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array | string>;
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Request cancelled.", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = typeof value === "string" ? value : decoder.decode(value, { stream: true });
      buffer += chunk.replace(/\r/g, "");

      let boundary = -1;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
          .trim();
        if (data) onEvent(data);
      }
    }

    const tail = buffer.trim();
    if (tail) {
      const data = tail
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (data) onEvent(data);
    }
  } finally {
    try { await reader.cancel(); } catch { /* best effort */ }
  }
}

function parseProviderText(data: string): string {
  try {
    const parsed = JSON.parse(data);
    if (parsed?.choices?.[0]?.delta?.content) return String(parsed.choices[0].delta.content);
    if (parsed?.choices?.[0]?.message?.content) return String(parsed.choices[0].message.content);
    const parts = parsed?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      return parts
        .filter((part: { text?: unknown; thought?: boolean }) => typeof part?.text === "string" && !part?.thought)
        .map((part: { text: string }) => part.text)
        .join("");
    }
    if (typeof parsed?.response === "string") return parsed.response;
    if (typeof parsed?.text === "string") return parsed.text;
  } catch {
    // Ignore non-JSON keep-alive events.
  }
  return "";
}

async function streamGemini(options: StreamOptions, env: Env): Promise<ProviderContext> {
  const provider: ProviderName = "gemini";
  if (!env.GEMINI_API_KEY) throw genericFailure(provider, "Gemini is not configured.");
  const model = MODEL_CONFIG[provider].model;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const contents = [
    ...options.messages.slice(0, -1).map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    })),
    {
      role: "user",
      parts: [{ text: options.messages.at(-1)?.content || "" }],
    },
  ];
  const body = {
    systemInstruction: { parts: [{ text: options.systemPrompt }] },
    contents,
    generationConfig: {
      temperature: options.mode === "creative" ? 0.7 : 0.2,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingLevel: modeThinkingLevel(options.mode) },
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw failure(provider, response, `Gemini request failed (${response.status}): ${text.slice(0, 500)}`);
  }
  if (!response.body) throw genericFailure(provider, "Gemini returned no stream.");

  let emitted = false;
  await consumeSSE(response.body, (data) => {
    if (data === "[DONE]") return;
    const text = parseProviderText(data);
    if (text) {
      emitted = true;
      options.onText(text);
    }
  }, options.signal);
  if (!emitted) throw genericFailure(provider, "Gemini returned no answer text.");

  return { provider, model };
}

async function streamGroq(options: StreamOptions, env: Env): Promise<ProviderContext> {
  const provider: ProviderName = "groq";
  if (!env.GROQ_API_KEY) throw genericFailure(provider, "Groq is not configured.");
  const model = MODEL_CONFIG[provider].model;
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: options.systemPrompt }, ...options.messages],
      stream: true,
      temperature: options.mode === "creative" ? 0.65 : 0.15,
      top_p: 0.9,
      reasoning_effort: "high",
      max_completion_tokens: 8192,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw failure(provider, response, `Groq request failed (${response.status}): ${text.slice(0, 500)}`);
  }
  if (!response.body) throw genericFailure(provider, "Groq returned no stream.");

  let emitted = false;
  await consumeSSE(response.body, (data) => {
    if (data === "[DONE]") return;
    const text = parseProviderText(data);
    if (text) {
      emitted = true;
      options.onText(text);
    }
  }, options.signal);
  if (!emitted) throw genericFailure(provider, "Groq returned no answer text.");

  return { provider, model };
}

async function streamCloudflare(options: StreamOptions, env: Env): Promise<ProviderContext> {
  const provider: ProviderName = "cloudflare";
  if (!env.AI?.run) throw genericFailure(provider, "Cloudflare AI is not configured.");
  const model = MODEL_CONFIG[provider].model;
  const result = await env.AI.run(model, {
    messages: [{ role: "system", content: options.systemPrompt }, ...options.messages],
    stream: true,
    temperature: options.mode === "creative" ? 0.65 : 0.15,
    top_p: 0.9,
    max_tokens: 8192,
    chat_template_kwargs: {
      enable_thinking: true,
      force_nonempty_content: true,
    },
  });

  if (result && typeof (result as ReadableStream<Uint8Array>).getReader === "function") {
    let emitted = false;
    await consumeSSE(result as ReadableStream<Uint8Array>, (data) => {
      if (data === "[DONE]") return;
      const text = parseProviderText(data);
      if (text) {
        emitted = true;
        options.onText(text);
      }
    }, options.signal);
    if (!emitted) throw genericFailure(provider, "Cloudflare AI returned no answer text.");
    return { provider, model };
  }

  const text = parseProviderText(JSON.stringify(result));
  if (!text) throw genericFailure(provider, "Cloudflare AI returned no answer text.");
  options.onText(text);
  return { provider, model };
}

async function streamFromProvider(provider: ProviderName, options: StreamOptions, env: Env): Promise<ProviderContext> {
  if (provider === "gemini") return streamGemini(options, env);
  if (provider === "groq") return streamGroq(options, env);
  return streamCloudflare(options, env);
}

export function availableProviders(env: Env): ProviderName[] {
  return (["gemini", "groq", "cloudflare"] as ProviderName[]).filter((provider) => providerAvailable(provider, env));
}

export async function streamWithFallback(options: StreamOptions, env: Env, preferred: ProviderName[] = ["gemini", "groq", "cloudflare"]): Promise<ProviderContext> {
  const candidates = preferred.filter((provider) => providerAvailable(provider, env) && !isCoolingDown(provider));
  if (!candidates.length) {
    throw new Error("Moina is temporarily at capacity. Please try again later.");
  }

  let lastError: unknown = null;
  for (const provider of candidates) {
    let emittedAny = false;
    const guardedOptions: StreamOptions = {
      ...options,
      onText: (text) => {
        emittedAny = true;
        options.onText(text);
      },
    };

    try {
      const ctx = await streamFromProvider(provider, guardedOptions, env);
      cooldowns.delete(provider);
      return ctx;
    } catch (error) {
      if (options.signal.aborted) throw new DOMException("Request cancelled.", "AbortError");
      if (emittedAny) {
        // Never splice a second provider into an already-visible partial answer.
        // For hard requests, callers keep the draft server-side, so fallback remains safe.
        throw error;
      }
      const typed = (error as ProviderFailure);
      lastError = typed;
      const status = Number(typed?.status || 0);
      const message = String(typed?.message || error).toLowerCase();
      const retry = typed?.retryAfterMs;
      const isTemporary = [408, 409, 429, 500, 502, 503, 504].includes(status)
        || /rate.?limit|quota|capacity|temporar|unavailable|insufficient|timeout|overload/.test(message);
      if (!isTemporary) throw error;

      if (typed?.dailyQuota || /rpd|per day|daily|tokens per day|tpd/.test(message)) {
        setCooldown(provider, 6 * 60 * 60 * 1000);
      } else {
        setCooldown(provider, retry || 30_000);
      }
    }
  }

  const typed = lastError as ProviderFailure | null;
  if (typed?.dailyQuota) {
    throw new Error("Moina is temporarily at capacity. Please try again later.");
  }
  throw new Error("Moina could not complete that request. Please try again.");
}

export async function runPrimary(
  messages: ReturnType<typeof trimHistory>,
  mode: ModeKey,
  searchContext: string,
  env: Env,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<ProviderContext> {
  return streamWithFallback({
    mode,
    systemPrompt: primarySystemPrompt(mode),
    messages: buildPrimaryPrompt(messages, searchContext),
    signal,
    onText,
  }, env);
}

export async function runAudit(
  messages: ReturnType<typeof trimHistory>,
  mode: ModeKey,
  draft: string,
  sandboxFeedback: string,
  searchContext: string,
  env: Env,
  signal: AbortSignal,
  excludeProvider?: ProviderName,
  onText?: (text: string) => void,
): Promise<ProviderContext> {
  const preferred = availableProviders(env).filter((provider) => provider !== excludeProvider);
  if (!preferred.length) throw new Error("No independent verification path is currently available.");

  return streamWithFallback({
    mode,
    systemPrompt: auditSystemPrompt(mode),
    messages: buildAuditPrompt(messages, draft, sandboxFeedback, searchContext),
    signal,
    onText: onText || (() => undefined),
  }, env, preferred);
}

export function shouldSearch(prompt: string): boolean {
  const clean = prompt.trim();
  if (!clean) return false;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|good morning|good evening|good night)\W*$/i.test(clean)) return false;
  if (/^\d+(?:\s*[+\-*/x×÷]\s*\d+)+\s*\??$/i.test(clean)) return false;
  return clean.length >= 80
    || /\b(latest|today|current|recent|news|research|source|sources|cite|citation|price|stock|weather|who is|what happened|as of|this week|this month|2026|2027)\b/i.test(clean);
}

export function shouldAudit(prompt: string, draft: string, sandboxFeedback: string): boolean {
  const hardSignal = /\b(prove|derive|calculate|debug|review|audit|analy[sz]e|compare|contrast|design|architect|research|verify|validate|critique|evaluate|refactor|optimi[sz]e|code|equation|algorithm|legal|medical|financial)\b/i.test(prompt);
  const codeSignal = /```|\b(function|class|typescript|javascript|python|sql|regex)\b/i.test(prompt);
  return Boolean(sandboxFeedback) || hardSignal || codeSignal || prompt.length > 700 || draft.length > 7000;
}
