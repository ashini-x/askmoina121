import type { Env } from "./types";
import { classifyProviderHealth } from "./telemetry";

const PROVIDERS = ["gemini", "groq", "cloudflare"] as const;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

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

function htmlHeaders(): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  return headers;
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return b64url(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function withCookies(headersInit: HeadersInit, cookies: string[]): Headers {
  const headers = new Headers(headersInit);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return headers;
}

function sessionCookie(token: string): string {
  return `${"MOINA_ADMIN_SESSION"}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function stateCookie(state: string): string {
  return `MOINA_OAUTH_STATE=${state}; Path=/; Max-Age=${OAUTH_STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function parseAllowlist(value: string | undefined): Set<string> {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function adminUserAllowed(githubId: number, login: string, env: Env): boolean {
  const allow = parseAllowlist(env.ADMIN_GITHUB_USERS);
  if (!allow.size) return false;
  return allow.has(String(githubId)) || allow.has(login.toLowerCase());
}

function callbackUrl(request: Request): string {
  const url = new URL(request.url);
  url.pathname = "/api/v1/admin/auth/callback";
  url.search = "";
  return url.toString();
}

async function githubIdentity(code: string, env: Env, redirectUri: string): Promise<{ id: number; login: string }> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) throw new Error("GitHub developer authentication is not configured.");

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "AskMoina-Control-Plane",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) throw new Error(`GitHub token exchange failed (${tokenResponse.status}).`);
  const tokenData = await tokenResponse.json() as { access_token?: string; error?: string; error_description?: string };
  if (!tokenData.access_token) throw new Error(tokenData.error_description || tokenData.error || "GitHub authorization failed.");

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": "AskMoina-Control-Plane",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!userResponse.ok) throw new Error(`GitHub identity lookup failed (${userResponse.status}).`);
  const user = await userResponse.json() as { id?: number; login?: string };
  if (!Number.isInteger(user.id) || !user.login) throw new Error("GitHub returned an incomplete developer identity.");
  return { id: Number(user.id), login: String(user.login) };
}

async function beginGithubAuth(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !String(env.ADMIN_GITHUB_USERS || "").trim()) {
    return new Response("Developer authentication is not configured.", { status: 503 });
  }
  const state = randomToken(32);
  const stateHash = await sha256Hex(state);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + OAUTH_STATE_TTL_SECONDS * 1000);

  await env.OPS_DB!.prepare(`
    INSERT INTO admin_oauth_states (state_hash, created_at, expires_at)
    VALUES (?, ?, ?)
  `).bind(stateHash, createdAt.toISOString(), expiresAt.toISOString()).run();

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: callbackUrl(request),
    scope: "read:user",
    state,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://github.com/login/oauth/authorize?${params.toString()}`,
      "Set-Cookie": stateCookie(state),
      "Cache-Control": "no-store",
    },
  });
}

async function completeGithubAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateCookieValue = cookieValue(request, "MOINA_OAUTH_STATE");
  if (!code || !state || !stateCookieValue || state !== stateCookieValue) {
    return json({ error: "Invalid developer authentication state." }, 400);
  }

  const stateHash = await sha256Hex(state);
  const row = await env.OPS_DB!.prepare(`
    SELECT state_hash, expires_at FROM admin_oauth_states WHERE state_hash=?
  `).bind(stateHash).first<{ state_hash: string; expires_at: string }>();
  await env.OPS_DB!.prepare(`DELETE FROM admin_oauth_states WHERE state_hash=?`).bind(stateHash).run();

  if (!row || Date.parse(row.expires_at) < Date.now()) {
    return json({ error: "Developer authentication state expired." }, 400);
  }

  try {
    const identity = await githubIdentity(code, env, callbackUrl(request));
    if (!adminUserAllowed(identity.id, identity.login, env)) {
      return new Response("Not authorized.", {
        status: 403,
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": clearCookie("MOINA_OAUTH_STATE"),
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const token = randomToken(32);
    const tokenHash = await sha256Hex(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

    await env.OPS_DB!.prepare(`
      INSERT INTO admin_sessions
      (token_hash, github_user_id, github_login, created_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).bind(tokenHash, String(identity.id), identity.login, now.toISOString(), expiresAt.toISOString()).run();

    return new Response(null, {
      status: 302,
      headers: withCookies({
        Location: "/admin/",
        "Cache-Control": "no-store",
      }, [sessionCookie(token), clearCookie("MOINA_OAUTH_STATE")]),
    });
  } catch (error) {
    console.error("[admin-auth] GitHub login failed", error);
    return new Response("Developer authentication failed.", {
      status: 502,
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": clearCookie("MOINA_OAUTH_STATE"),
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}

async function logout(request: Request, env: Env): Promise<Response> {
  const token = cookieValue(request, "MOINA_ADMIN_SESSION");
  if (token && env.OPS_DB) {
    const tokenHash = await sha256Hex(token);
    await env.OPS_DB.prepare(`UPDATE admin_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL`).bind(new Date().toISOString(), tokenHash).run();
  }
  return new Response(null, { status: 204, headers: { "Set-Cookie": clearCookie("MOINA_ADMIN_SESSION"), "Cache-Control": "no-store" } });
}

async function requireAdmin(request: Request, env: Env): Promise<{ githubId: string; login: string } | Response> {
  if (!env.OPS_DB) return json({ error: "Control plane database is not configured." }, 503);
  const token = cookieValue(request, "MOINA_ADMIN_SESSION");
  if (!token) return json({ error: "Developer authentication required." }, 401);
  const tokenHash = await sha256Hex(token);
  const row = await env.OPS_DB.prepare(`
    SELECT github_user_id, github_login, expires_at, revoked_at
    FROM admin_sessions
    WHERE token_hash=?
  `).bind(tokenHash).first<{ github_user_id: string; github_login: string; expires_at: string; revoked_at: string | null }>();

  if (!row || row.revoked_at || Date.parse(row.expires_at) < Date.now()) {
    return new Response(null, { status: 401, headers: { "Set-Cookie": clearCookie("MOINA_ADMIN_SESSION"), "Cache-Control": "no-store" } });
  }
  return { githubId: row.github_user_id, login: row.github_login };
}

function rows<T>(result: { results: T[] }): T[] {
  return Array.isArray(result.results) ? result.results : [];
}

export async function handleAdminRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const configuredAdminHostname = String(env.ADMIN_HOSTNAME || "").trim().toLowerCase();
  if (configuredAdminHostname && url.hostname.toLowerCase() !== configuredAdminHostname) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }

  const isAdminPath = url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/api/v1/admin/");
  if (!isAdminPath) return null;
  if (!env.OPS_DB) return json({ error: "Control plane database is not configured." }, 503);

  if (url.pathname === "/api/v1/admin/auth/github" && request.method === "GET") return beginGithubAuth(request, env);
  if (url.pathname === "/api/v1/admin/auth/callback" && request.method === "GET") return completeGithubAuth(request, env);
  if (url.pathname === "/api/v1/admin/auth/logout" && request.method === "POST") return logout(request, env);

  const auth = await requireAdmin(request, env);
  const authenticated = !(auth instanceof Response);

  if ((url.pathname === "/admin" || url.pathname === "/admin/") && !authenticated) {
    // Never serve the dashboard shell to an unauthenticated request.
    // Redirect to a harmless static login page so an edge/browser cache can
    // never accidentally expose the dashboard HTML.
    const headers = htmlHeaders();
    headers.set("Location", "/admin-login.html");
    headers.set("Cache-Control", "private, no-store, max-age=0");
    headers.set("CDN-Cache-Control", "no-store");
    return new Response(null, { status: 302, headers });
  }

  if (auth instanceof Response) return auth;

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    const assetResponse = await env.ASSETS.fetch(new Request(new URL("/admin.html", request.url), request));
    const headers = new Headers(assetResponse.headers);
    for (const [key, value] of htmlHeaders()) headers.set(key, value);
    headers.set("Cache-Control", "private, no-store, max-age=0");
    headers.set("CDN-Cache-Control", "no-store");
    headers.set("Vary", "Cookie");
    return new Response(assetResponse.body, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
  }

  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);

  const db = env.OPS_DB;

  if (url.pathname === "/api/v1/admin/system") {
    return json({
      generated_at: new Date().toISOString(),
      service: "askmoina-control-plane",
      build: "1.5.3",
      ops_db_configured: Boolean(env.OPS_DB),
      providers_configured: {
        gemini: Boolean(env.GEMINI_API_KEY),
        groq: Boolean(env.GROQ_API_KEY),
        cloudflare: Boolean(env.AI?.run),
      },
      sandbox_configured: Boolean(env.E2B_API_KEY),
      admin_auth_configured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      admin_allowlist_configured: Boolean(String(env.ADMIN_GITHUB_USERS || "").trim()),
      admin_auth_method: "github-oauth",
      admin_hostname_configured: Boolean(String(env.ADMIN_HOSTNAME || "").trim()),
      retention_days: 30,
      telemetry_policy: "Operational metadata only; no prompt text, model output, secrets, or upstream response bodies are stored.",
      authenticated_developer: auth.login,
    });
  }

  if (url.pathname === "/api/v1/admin/overview") {
    const [summary, status] = await Promise.all([
      db.prepare(`
        SELECT COUNT(*) AS requests,
          COALESCE(SUM(CASE WHEN final_status LIKE 'success%' THEN 1 ELSE 0 END), 0) AS successful,
          COALESCE(SUM(CASE WHEN final_status='error' THEN 1 ELSE 0 END), 0) AS failed,
          COALESCE(SUM(CASE WHEN verification_status='completed' THEN 1 ELSE 0 END), 0) AS verified,
          COALESCE(SUM(CASE WHEN verification_status='unavailable' THEN 1 ELSE 0 END), 0) AS verification_unavailable,
          AVG(duration_ms) AS avg_latency_ms
        FROM request_sessions WHERE started_at >= datetime('now', '-15 minutes')
      `).first<Record<string, unknown>>(),
      db.prepare(`
        SELECT provider, state, last_success_at, last_failure_at, last_status,
               last_error_class, next_retry_at, consecutive_failures, last_latency_ms,
               last_model, updated_at FROM provider_health ORDER BY provider
      `).all<Record<string, unknown>>(),
    ]);

    return json({
      generated_at: new Date().toISOString(),
      operator: auth.login,
      window_minutes: 15,
      summary: summary || {},
      provider_health: rows(status).map((item: any) => ({ ...item, health: classifyProviderHealth(item.state) })),
    });
  }

  if (url.pathname === "/api/v1/admin/providers") {
    const result = await db.prepare(`
      SELECT provider, state, last_success_at, last_failure_at, last_status,
             last_error_class, next_retry_at, consecutive_failures, last_latency_ms,
             last_model, updated_at FROM provider_health ORDER BY provider
    `).all<Record<string, unknown>>();

    const seen = new Set<string>();
    const providerRows = rows(result).map((item: any) => {
      seen.add(item.provider);
      return { ...item, health: classifyProviderHealth(item.state) };
    });
    for (const provider of PROVIDERS) if (!seen.has(provider)) providerRows.push({ provider, state: "unknown", health: "unknown" });
    return json({ providers: providerRows });
  }

  if (url.pathname === "/api/v1/admin/requests") {
    const rawLimit = Number(url.searchParams.get("limit") || "50");
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50, 1), 100);
    const result = await db.prepare(`
      SELECT request_id, started_at, completed_at, mode, audited, search_used, sandbox_used,
             primary_provider, verifier_provider, final_provider, verification_status,
             final_status, duration_ms, error_class
      FROM request_sessions ORDER BY started_at DESC LIMIT ?
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
      FROM provider_events WHERE request_id=? ORDER BY event_id ASC
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
