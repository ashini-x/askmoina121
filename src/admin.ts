import type { Env } from "./types";
import { classifyProviderHealth, type OpsExecutionContext } from "./telemetry";

type AccessIdentity = { email?: string | null; name?: string | null };

const PROVIDERS = ["gemini", "groq", "cloudflare"] as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function emailAllowed(email: string, env: Env): boolean {
  const allow = String(env.ADMIN_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return allow.length > 0 && allow.includes(email.toLowerCase());
}

async function requireAdmin(ctx: OpsExecutionContext, env: Env): Promise<{ email: string } | Response> {
  if (!env.OPS_DB) return json({ error: "Control plane database is not configured." }, 503);
  if (!ctx.access) return json({ error: "Developer authentication required." }, 403);

  let identity: AccessIdentity | null | undefined;
  try {
    identity = await ctx.access.getIdentity();
  } catch {
    return json({ error: "Developer authentication could not be verified." }, 403);
  }

  const email = String(identity?.email || "").trim();
  if (!email || !emailAllowed(email, env)) return json({ error: "Not authorized." }, 403);
  return { email };
}

function rows<T>(result: { results: T[] }): T[] {
  return Array.isArray(result.results) ? result.results : [];
}

export async function handleAdminRequest(
  request: Request,
  env: Env,
  ctx: OpsExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const configuredAdminHostname = String(env.ADMIN_HOSTNAME || "").trim().toLowerCase();
  if (configuredAdminHostname && url.hostname.toLowerCase() !== configuredAdminHostname) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  const isAdminPath =
    url.pathname === "/admin" ||
    url.pathname.startsWith("/admin/") ||
    url.pathname.startsWith("/api/v1/admin/");
  if (!isAdminPath) return null;

  const auth = await requireAdmin(ctx, env);
  if (auth instanceof Response) return auth;

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    const assetResponse = await env.ASSETS.fetch(new Request(new URL("/admin.html", request.url), request));
    const headers = new Headers(assetResponse.headers);
    headers.set("Cache-Control", "no-store, max-age=0");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    return new Response(assetResponse.body, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
  }

  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);

  const db = env.OPS_DB!;

  if (url.pathname === "/api/v1/admin/system") {
    return json({
      generated_at: new Date().toISOString(),
      service: "askmoina-control-plane",
      build: "1.5.1",
      ops_db_configured: Boolean(env.OPS_DB),
      providers_configured: {
        gemini: Boolean(env.GEMINI_API_KEY),
        groq: Boolean(env.GROQ_API_KEY),
        cloudflare: Boolean(env.AI?.run),
      },
      sandbox_configured: Boolean(env.E2B_API_KEY),
      admin_allowlist_configured: Boolean(String(env.ADMIN_EMAILS || "").trim()),
      admin_hostname_configured: Boolean(String(env.ADMIN_HOSTNAME || "").trim()),
      retention_days: 30,
      telemetry_policy: "Operational metadata only; no prompt text, model output, secrets, or upstream response bodies are stored.",
    });
  }

  if (url.pathname === "/api/v1/admin/overview") {
    const [summary, status] = await Promise.all([
      db.prepare(`
        SELECT
          COUNT(*) AS requests,
          COALESCE(SUM(CASE WHEN final_status LIKE 'success%' THEN 1 ELSE 0 END), 0) AS successful,
          COALESCE(SUM(CASE WHEN final_status='error' THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(CASE WHEN verification_status='completed' THEN 1 ELSE 0 END), 0) AS verified,
          COALESCE(SUM(CASE WHEN verification_status='unavailable' THEN 1 ELSE 0 END), 0) AS verification_unavailable,
          AVG(duration_ms) AS avg_latency_ms
        FROM request_sessions
        WHERE started_at >= datetime('now', '-15 minutes')
      `).first<Record<string, unknown>>(),
      db.prepare(`
        SELECT provider, state, last_success_at, last_failure_at, last_status,
               last_error_class, next_retry_at, consecutive_failures,
               last_latency_ms, last_model, updated_at
        FROM provider_health
        ORDER BY provider
      `).all<Record<string, unknown>>(),
    ]);

    return json({
      generated_at: new Date().toISOString(),
      operator: auth.email,
      window_minutes: 15,
      summary: summary || {},
      provider_health: rows(status).map((item: any) => ({
        ...item,
        health: classifyProviderHealth(item.state),
      })),
    });
  }

  if (url.pathname === "/api/v1/admin/providers") {
    const result = await db.prepare(`
      SELECT provider, state, last_success_at, last_failure_at, last_status,
             last_error_class, next_retry_at, consecutive_failures,
             last_latency_ms, last_model, updated_at
      FROM provider_health
      ORDER BY provider
    `).all<Record<string, unknown>>();

    const seen = new Set<string>();
    const providerRows = rows(result).map((item: any) => {
      seen.add(item.provider);
      return { ...item, health: classifyProviderHealth(item.state) };
    });
    for (const provider of PROVIDERS) {
      if (!seen.has(provider)) providerRows.push({ provider, state: "unknown", health: "unknown" });
    }
    return json({ providers: providerRows });
  }

  if (url.pathname === "/api/v1/admin/requests") {
    const rawLimit = Number(url.searchParams.get("limit") || "50");
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50, 1), 100);
    const result = await db.prepare(`
      SELECT request_id, started_at, completed_at, mode, audited, search_used, sandbox_used,
             primary_provider, verifier_provider, final_provider, verification_status,
             final_status, duration_ms, error_class
      FROM request_sessions
      ORDER BY started_at DESC
      LIMIT ?
    `).bind(limit).all<Record<string, unknown>>();
    return json({ requests: rows(result) });
  }

  const requestMatch = url.pathname.match(/^\/api\/v1\/admin\/requests\/([^/]+)$/);
  if (requestMatch) {
    const requestId = decodeURIComponent(requestMatch[1]);
    const session = await db.prepare(`SELECT * FROM request_sessions WHERE request_id=?`).bind(requestId).first<Record<string, unknown>>();
    if (!session) return json({ error: "Request not found." }, 404);

    const eventsResult = await db.prepare(`
      SELECT event_id, request_id, timestamp, stage, event_kind, provider, model,
             latency_ms, http_status, error_class, retry_after_ms
      FROM provider_events
      WHERE request_id=?
      ORDER BY event_id ASC
    `).bind(requestId).all<Record<string, unknown>>();

    return json({ session, events: rows(eventsResult) });
  }

  if (url.pathname === "/api/v1/admin/incidents") {
    const result = await db.prepare(`
      SELECT provider, state, last_failure_at, last_status, last_error_class,
             next_retry_at, consecutive_failures, last_model, updated_at
      FROM provider_health
      WHERE state IS NOT NULL AND state != 'healthy'
      ORDER BY updated_at DESC
    `).all<Record<string, unknown>>();
    return json({
      incidents: rows(result).map((item: any) => ({
        ...item,
        severity: classifyProviderHealth(item.state) === "down" ? "high" : "medium",
      })),
    });
  }

  return json({ error: "Not found." }, 404);
}
