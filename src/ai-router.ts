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

function extractText(value: unknown): string {
  if (!value) return "";

  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === "string")
      .join("");
  }

  if (typeof value !== "object") return "";

  const obj = value as Record<string, unknown>;

  if (typeof obj.response === "string") return obj.response;
  if (typeof obj.text === "string") return obj.text;

  const candidates = obj.candidates;
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const content = (candidate as Record<string, unknown>)?.content;
      const parts = (content as Record<string, unknown> | undefined)?.parts;
      if (Array.isArray(parts)) {
        const text = parts
          .filter((part) => {
            if (!part || typeof part !== "object") return false;
            const item = part as Record<string, unknown>;
            return typeof item.text === "string" && item.thought !== true;
          })
          .map((part) => String((part as Record<string, unknown>).text))
          .join("");
        if (text) return text;
      }
    }
  }

  const choices = obj.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const item = choice as Record<string, unknown>;
      const message = item.message as Record<string, unknown> | undefined;
      const delta = item.delta as Record<string, unknown> | undefined;
      const messageText = extractText(message?.content);
      if (messageText) return messageText;
      const deltaText = extractText(delta?.content);
      if (deltaText) return deltaText;
      const direct = typeof item.text === "string" ? item.text : "";
      if (direct) return direct;
    }
  }

  const outputText = obj.output_text;
  if (typeof outputText === "string") return outputText;

  const output = obj.output;
  if (Array.isArray(output)) {
    const text = output
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const record = item as Record<string, unknown>;
        return typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("");
    if (text) return text;
  }

  return "";
}

/**
 * Emit a complete provider answer in chunks to keep the client UI responsive.
 * We intentionally use non-streaming provider calls here until every provider
 * adapter is proven against its current response format. The browser still
 * receives incremental SSE deltas from Moina.
 */
function emitInChunks(text: string, onText: (text: string) => void): void {
  const value = String(text || "");
  if (!value) return;
  const chunkSize = 700;
  for (let i = 0; i < value.length; i += chunkSize) {
    onText(value.slice(i, i + chunkSize));
  }
}

async function generateGemini(options: StreamOptions, env: Env): Promise<ProviderContext> {
  const provider: ProviderName = "gemini";
  if (!env.GEMINI_API_KEY) throw genericFailure(provider, "Gemini is not configured.");
  const model = MODEL_CONFIG[provider].model;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const contents = options.messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));

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
    throw failure(provider, response, `Gemini request failed (${response.status}): ${text.slice(0, 600)}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw genericFailure(provider, "Gemini returned invalid JSON.");
  }

  const text = extractText(payload).trim();
  if (!text) {
    const reason = (payload as { promptFeedback?: { blockReason?: string } })?.promptFeedback?.blockReason;
    throw genericFailure(provider, reason ? `Gemini blocked the request: ${reason}.` : "Gemini returned no answer text.");
  }

  emitInChunks(text, options.onText);
  return { provider, model };
}

async function generateGroq(options: StreamOptions, env: Env): Promise<ProviderContext> {
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
      stream: false,
      temperature: options.mode === "creative" ? 0.65 : 0.15,
      top_p: 0.9,
      reasoning_effort: "high",
      include_reasoning: false,
      max_completion_tokens: 8192,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw failure(provider, response, `Groq request failed (${response.status}): ${text.slice(0, 600)}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw genericFailure(provider, "Groq returned invalid JSON.");
  }

  const text = extractText(payload).trim();
  if (!text) throw genericFailure(provider, "Groq returned no answer text.");

  emitInChunks(text, options.onText);
  return { provider, model };
}

async function generateCloudflare(options: StreamOptions, env: Env): Promise<ProviderContext> {
  const provider: ProviderName = "cloudflare";
  if (!env.AI?.run) throw genericFailure(provider, "Cloudflare AI is not configured.");
  const model = MODEL_CONFIG[provider].model;

  const result = await env.AI.run(model, {
    messages: [{ role: "system", content: options.systemPrompt }, ...options.messages],
    stream: false,
    temperature: options.mode === "creative" ? 0.65 : 0.15,
    top_p: 0.9,
    max_tokens: 8192,
    chat_template_kwargs: {
      enable_thinking: true,
      force_nonempty_content: true,
    },
  });

  const text = extractText(result).trim();
  if (!text) throw genericFailure(provider, "Cloudflare AI returned no answer text.");

  emitInChunks(text, options.onText);
  return { provider, model };
}

async function generateFromProvider(provider: ProviderName, options: StreamOptions, env: Env): Promise<ProviderContext> {
  if (provider === "gemini") return generateGemini(options, env);
  if (provider === "groq") return generateGroq(options, env);
  return generateCloudflare(options, env);
}

export function availableProviders(env: Env): ProviderName[] {
  return (["gemini", "groq", "cloudflare"] as ProviderName[]).filter((provider) => providerAvailable(provider, env));
}

export async function streamWithFallback(
  options: StreamOptions,
  env: Env,
  preferred: ProviderName[] = ["gemini", "groq", "cloudflare"],
): Promise<ProviderContext> {
  const candidates = preferred.filter((provider) => providerAvailable(provider, env) && !isCoolingDown(provider));
  if (!candidates.length) throw new Error("Moina is temporarily at capacity. Please try again later.");

  let lastError: unknown = null;

  for (const provider of candidates) {
    try {
      const ctx = await generateFromProvider(provider, options, env);
      cooldowns.delete(provider);
      return ctx;
    } catch (error) {
      if (options.signal.aborted) throw new DOMException("Request cancelled.", "AbortError");

      const typed = genericFailure(provider, error);
      lastError = typed;
      const status = Number(typed.status || 0);
      const message = typed.message.toLowerCase();
      const isTemporary = [408, 409, 429, 500, 502, 503, 504].includes(status)
        || /rate.?limit|quota|capacity|temporar|unavailable|insufficient|timeout|overload/.test(message);

      if (!isTemporary) {
        // Configuration or semantic errors should not prevent a later fallback
        // provider from being tried, but we record the failure.
        continue;
      }

      if (typed.dailyQuota || /rpd|per day|daily|tokens per day|tpd/.test(message)) {
        setCooldown(provider, 6 * 60 * 60 * 1000);
      } else {
        setCooldown(provider, typed.retryAfterMs || 30_000);
      }
    }
  }

  const typed = lastError as ProviderFailure | null;
  if (typed?.dailyQuota) throw new Error("Moina is temporarily at capacity. Please try again later.");
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
