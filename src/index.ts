import {
  MAX_PROMPT_CHARS,
  MAX_SANDBOX_CODE_CHARS,
  SEARCH_QUERY_MAX_CHARS,
  SEARCH_RESULT_LIMIT,
} from "./core/config";
import { sanitizeInput } from "./security/guardrails";
import { formatSearchContext, webSearch } from "./tools/search";
import { runPythonSandbox } from "./tools/sandbox";
import type { Env } from "./types";
import { JSON_HEADERS } from "./http/response";

const requestCounters = new Map<string, { search: number; sandbox: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;
const SEARCH_LIMIT_PER_WINDOW = 30;
const SANDBOX_LIMIT_PER_WINDOW = 8;

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
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

function clientKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "anonymous";
}

function checkRateLimit(request: Request, bucket: "search" | "sandbox"): boolean {
  const key = `${bucket}:${clientKey(request)}`;
  const now = Date.now();
  const current = requestCounters.get(key);
  const limit = bucket === "search" ? SEARCH_LIMIT_PER_WINDOW : SANDBOX_LIMIT_PER_WINDOW;
  if (!current || current.resetAt <= now) {
    requestCounters.set(key, { search: bucket === "search" ? 1 : 0, sandbox: bucket === "sandbox" ? 1 : 0, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  current[bucket] += 1;
  return current[bucket] <= limit;
}

function requireBrowserOrigin(request: Request): string | null {
  const origin = allowedOrigin(request);
  if (!origin) return null;
  return origin;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return await request.json() as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    if (url.pathname === "/api/v1/health" && request.method === "GET") {
      return json({ status: "ok", service: "moina-tools", ai: "ready" }, 200, cors);
    }

    if (url.pathname === "/api/v1/tools/search" && request.method === "POST") {
      const origin = requireBrowserOrigin(request);
      if (!origin) return json({ error: "Origin not allowed." }, 403);
      if (!checkRateLimit(request, "search")) return json({ error: "Search rate limit reached. Please try again shortly." }, 429, cors);
      try {
        const body = await readJson(request);
        const raw = typeof body.query === "string" ? body.query : "";
        const query = sanitizeInput(raw).slice(0, SEARCH_QUERY_MAX_CHARS);
        if (!query || query.length > MAX_PROMPT_CHARS) throw new Error(`Search query exceeds the ${MAX_PROMPT_CHARS}-character limit.`);
        const results = await webSearch(query, SEARCH_RESULT_LIMIT);
        return json({ query, results, context: formatSearchContext(results) }, 200, cors);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400, cors);
      }
    }

    if (url.pathname === "/api/v1/tools/sandbox" && request.method === "POST") {
      const origin = requireBrowserOrigin(request);
      if (!origin) return json({ error: "Origin not allowed." }, 403);
      if (!checkRateLimit(request, "sandbox")) return json({ error: "Sandbox rate limit reached. Please try again shortly." }, 429, cors);
      try {
        const body = await readJson(request);
        const code = typeof body.code === "string" ? body.code : "";
        if (!code.trim()) throw new Error("Sandbox code is empty.");
        if (code.length > MAX_SANDBOX_CODE_CHARS) throw new Error(`Sandbox code exceeds the ${MAX_SANDBOX_CODE_CHARS}-character limit.`);
        const result = await runPythonSandbox(code, env.E2B_API_KEY, MAX_SANDBOX_CODE_CHARS);
        return json(result, result.status === "success" ? 200 : 422, cors);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400, cors);
      }
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "Not Found" }, 404, cors);
    return env.ASSETS.fetch(request);
  },
};
