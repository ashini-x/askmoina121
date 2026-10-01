import type { Env, ModeKey, ProviderName } from "./types";
import {
  buildFinalReviewPrompt,
  buildPrimaryPrompt,
  buildVerificationPrompt,
  isIdentityPrompt,
  finalReviewSystemPrompt,
  primarySystemPrompt,
  trimHistory,
  verificationSystemPrompt,
} from "./prompts";

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
const PROVIDER_TIMEOUT_MS = 45_000;

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
  const dailyQuota = /rpd|per day|daily|quota|tokens per day|tpd|daily limit/.test(lower);
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

async function withTimeout<T>(promiseFactory: () => Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("Request cancelled.", "AbortError");

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Provider request exceeded ${Math.ceil(timeoutMs / 1000)}s.`)), timeoutMs);
  });

  try {
    return await Promise.race([promiseFactory(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function extractText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item))
      .filter(Boolean)
      .join("");
  }

  if (typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;

  if (typeof obj.response === "string") return obj.response;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.output_text === "string") return obj.output_text;

  const candidates = obj.candidates;
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const item = candidate as Record<string, unknown>;
      const content = item.content;
      const parts = (content as Record<string, unknown> | undefined)?.parts;
      if (Array.isArray(parts)) {
        const text = parts
          .filter((part) => part && typeof part === "object")
          .filter((part) => (part as Record<string, unknown>).thought !== true)
          .map((part) => typeof (part as Record<string, unknown>).text === "string"
            ? String((part as Record<string, unknown>).text)
            : "")
          .filter(Boolean)
          .join("");
        if (text) return text;
      }
    }
  }

  const choices = obj.choices;
  if (Array.isArray(choices)) {
    const text = choices
      .map((choice) => {
        const item = choice as Record<string, unknown>;
        const message = item.message as Record<string, unknown> | undefined;
        const delta = item.delta as Record<string, unknown> | undefined;
        return extractText(message?.content) || extractText(delta?.content) || (typeof item.text === "string" ? item.text : "");
      })
      .filter(Boolean)
      .join("");
    if (text) return text;
  }

  const output = obj.output;
  if (Array.isArray(output)) {
    const text = output
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        return extractText(item);
      })
      .filter(Boolean)
      .join("");
    if (text) return text;
  }

  return "";
}

function emitInChunks(text: string, onText: (text: string) => void): void {
  const value = String(text || "");
  if (!value) return;
  const chunkSize = 700;
  for (let i = 0; i < value.length; i += chunkSize) onText(value.slice(i, i + chunkSize));
}

async function generateGemini(options: StreamOptions, env: Env): Promise<ProviderContext> {
  const provider: ProviderName = "gemini";
  if (!env.GEMINI_API_KEY) throw genericFailure(provider, "Gemini is not configured.");
  const model = MODEL_CONFIG[provider].model;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const contents = options.messages.map((message) => ({ role: "user", parts: [{ text: message.content }] }));

  const body = {
    systemInstruction: { parts: [{ text: options.systemPrompt }] },
    contents,
    generationConfig: {
      temperature: options.mode === "creative" ? 0.7 : 0.2,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingLevel: modeThinkingLevel(options.mode) },
    },
  };

  const response = await withTimeout(() => fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY as string },
    body: JSON.stringify(body),
    signal: options.signal,
  }), PROVIDER_TIMEOUT_MS, options.signal);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw failure(provider, response, `Gemini request failed (${response.status}): ${text.slice(0, 800)}`);
  }

  let payload: unknown;
  try { payload = await response.json(); } catch { throw genericFailure(provider, "Gemini returned invalid JSON."); }
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
  const response = await withTimeout(() => fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: options.systemPrompt }, { role: "user", content: options.messages[0]?.content || "" }],
      stream: false,
      temperature: options.mode === "creative" ? 0.65 : 0.15,
      top_p: 0.9,
      reasoning_effort: "high",
      include_reasoning: false,
      max_completion_tokens: 8192,
    }),
    signal: options.signal,
  }), PROVIDER_TIMEOUT_MS, options.signal);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw failure(provider, response, `Groq request failed (${response.status}): ${text.slice(0, 800)}`);
  }

  let payload: unknown;
  try { payload = await response.json(); } catch { throw genericFailure(provider, "Groq returned invalid JSON."); }
  const text = extractText(payload).trim();
  if (!text) throw genericFailure(provider, "Groq returned no answer text.");

  emitInChunks(text, options.onText);
  return { provider, model };
}

async function generateCloudflare(options: StreamOptions, env: Env): Promise<ProviderContext> {
  const provider: ProviderName = "cloudflare";
  if (!env.AI?.run) throw genericFailure(provider, "Cloudflare AI is not configured.");
  const model = MODEL_CONFIG[provider].model;

  const result = await withTimeout(() => env.AI!.run(model, {
    messages: [{ role: "system", content: options.systemPrompt }, { role: "user", content: options.messages[0]?.content || "" }],
    stream: false,
    temperature: options.mode === "creative" ? 0.65 : 0.15,
    top_p: 0.9,
    max_tokens: 8192,
    chat_template_kwargs: { enable_thinking: true, force_nonempty_content: true },
  }), PROVIDER_TIMEOUT_MS, options.signal);

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
      const temporary = [408, 409, 425, 429, 500, 502, 503, 504].includes(status)
        || /rate.?limit|quota|capacity|temporar|unavailable|insufficient|timeout|overload|exceeded/.test(message);

      if (!temporary) continue;
      if (typed.dailyQuota || /rpd|per day|daily|tokens per day|tpd/.test(message)) setCooldown(provider, 6 * 60 * 60 * 1000);
      else setCooldown(provider, typed.retryAfterMs || 30_000);
    }
  }

  const typed = lastError as ProviderFailure | null;
  if (typed?.dailyQuota) throw new Error("Moina is temporarily at capacity. Please try again later.");
  throw new Error("Moina could not complete that request. Please try again.");
}

export function verificationProviderOrder(
  env: Env,
  excluded: ProviderName | undefined,
  preferred: ProviderName[] = ["groq", "gemini", "cloudflare"],
): ProviderName[] {
  const diverse = preferred.filter(
    (provider) => provider !== excluded && providerAvailable(provider, env) && !isCoolingDown(provider),
  );

  // Provider diversity is preferred, but it must never make verification disappear
  // when the other providers are unavailable or rate-limited. A second request to
  // the primary provider is still independent because the verifier never receives
  // the draft and reconstructs the answer from the original request.
  if (excluded && providerAvailable(excluded, env) && !isCoolingDown(excluded)) {
    diverse.push(excluded);
  }

  return diverse.length ? diverse : availableProviders(env);
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

/**
 * Independent reference pass: intentionally does NOT receive the draft.
 * This prevents the verifier from anchoring on the first model's answer.
 */
export async function runIndependentVerification(
  messages: ReturnType<typeof trimHistory>,
  mode: ModeKey,
  sandboxFeedback: string,
  searchContext: string,
  env: Env,
  signal: AbortSignal,
  excludeProvider?: ProviderName,
): Promise<{ context: ProviderContext; text: string }> {
  const preferred = verificationProviderOrder(
    env,
    excludeProvider,
    ["groq", "gemini", "cloudflare"],
  );
  const chunks: string[] = [];
  const context = await streamWithFallback({
    mode,
    systemPrompt: verificationSystemPrompt(mode),
    messages: buildVerificationPrompt(messages, sandboxFeedback, searchContext),
    signal,
    onText: (text) => chunks.push(text),
  }, env, preferred);

  return { context, text: chunks.join("").trim() };
}

/**
 * Final editor compares the draft and an independent reference answer.
 * With three providers, this can use a third provider distinct from both passes.
 */
export async function runFinalReview(
  messages: ReturnType<typeof trimHistory>,
  mode: ModeKey,
  draft: string,
  referenceAnswer: string,
  sandboxFeedback: string,
  searchContext: string,
  env: Env,
  signal: AbortSignal,
  preferredProviders: ProviderName[] = ["cloudflare", "gemini", "groq"],
): Promise<{ context: ProviderContext; text: string }> {
  const chunks: string[] = [];
  const context = await streamWithFallback({
    mode,
    systemPrompt: finalReviewSystemPrompt(mode),
    messages: buildFinalReviewPrompt(messages, draft, referenceAnswer, sandboxFeedback, searchContext),
    signal,
    onText: (text) => chunks.push(text),
  }, env, preferredProviders);

  return { context, text: chunks.join("").trim() };
}

export function shouldSearch(prompt: string): boolean {
  const clean = prompt.trim();
  if (!clean) return false;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|good morning|good evening|good night)\W*$/i.test(clean)) return false;
  if (/^\d+(?:\s*[+\-*/x×÷]\s*\d+)+\s*\??$/i.test(clean)) return false;

  const live = /\b(latest|today|current|right now|recent|news|breaking|as of|this week|this month|this year|tomorrow|yesterday|live|real[- ]time|price|stock|weather|forecast|who is|what happened|source|sources|cite|citation|reference|look up|search for|research)\b/i.test(clean);
  const webLike = /https?:\/\/|www\.|\b20\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/i.test(clean);
  const highStakes = /\b(medical|medicine|symptom|diagnosis|treatment|legal|law|lawsuit|contract|tax|investment|investing|financial|bank|security|vulnerability|cybersecurity)\b/i.test(clean);
  return live || webLike || highStakes;
}

export function shouldAudit(prompt: string, draft = "", sandboxFeedback = ""): boolean {
  const normalized = prompt.trim();
  const hardSignal = /\b(prove|derive|calculate|debug|review|audit|analy[sz]e|compare|contrast|design|architect|research|verify|validate|critique|evaluate|refactor|optimi[sz]e|code|equation|algorithm|legal|medical|financial|tax|security)\b/i.test(normalized);
  const completenessSignal = /\b(exactly|all|every|complete|completely|systematically|enumerate|enumeration|decision tree|case[s]?|constraint[s]?|counterexample|global optimum|prove that|without missing|independently|double-check|check every|find any error)\b/i.test(normalized);
  const codeSignal = /```|\b(function|class|typescript|javascript|python|sql|regex|stack trace|compiler error)\b/i.test(normalized);
  const numericSignal = /\b\d+(?:\.\d+)?\b/.test(normalized) && /[=+\-*/%<>]|\bhow many\b|\bmaximize\b|\bminimum\b|\bmaximum\b/i.test(normalized);
  const highStakes = /\b(medical|medicine|symptom|diagnosis|treatment|legal|law|lawsuit|contract|tax|investment|investing|financial|bank|security|vulnerability|cybersecurity)\b/i.test(normalized);
  const current = shouldSearch(normalized);

  return Boolean(
    sandboxFeedback
    || hardSignal
    || completenessSignal
    || codeSignal
    || numericSignal
    || highStakes
    || current
    || isIdentityPrompt(normalized)
    || normalized.length > 650
    || draft.length > 7000,
  );
}
