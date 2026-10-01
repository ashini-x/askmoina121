import type { Env, ProviderName, ModeKey, D1Database } from "./types";

export type OpsStage = "primary" | "verification" | "final";
export type ProviderEventKind = "attempt" | "success" | "failure";
export type VerificationStatus = "not_requested" | "completed" | "unavailable";
export type FinalStatus = "success" | "success_unverified" | "success_degraded" | "error";

export interface OpsExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  access?: {
    getIdentity(): Promise<{ email?: string | null; name?: string | null } | null | undefined>;
  };
}

export interface ProviderTelemetryEvent {
  requestId: string;
  stage: OpsStage;
  kind: ProviderEventKind;
  provider: ProviderName;
  model: string;
  latencyMs?: number;
  status?: number;
  errorClass?: string;
  retryAfterMs?: number;
}

export interface RequestSessionStart {
  requestId: string;
  mode: ModeKey;
  audited: boolean;
  searchUsed: boolean;
  sandboxUsed: boolean;
}

export interface RequestSessionFinish {
  requestId: string;
  finalStatus: FinalStatus;
  verificationStatus: VerificationStatus;
  durationMs: number;
  primaryProvider?: ProviderName;
  verifierProvider?: ProviderName;
  finalProvider?: ProviderName;
  audited?: boolean;
  searchUsed?: boolean;
  sandboxUsed?: boolean;
  errorClass?: string;
}

function isoNow(): string {
  return new Date().toISOString();
}

function safeErrorClass(value: unknown): string | null {
  if (!value) return null;
  const text = String(value).toLowerCase();
  if (/quota|rpd|tpd|daily|tokens per day/.test(text)) return "quota_exhausted";
  if (/rate.?limit|429/.test(text)) return "rate_limited";
  if (/capacity|overload|busy|at capacity|insufficient capacity/.test(text)) return "capacity";
  if (/401|403|unauthori[sz]|forbidden|invalid.*key|api key/.test(text)) return "auth_error";
  if (/timeout|timed out|exceeded 45s/.test(text)) return "timeout";
  if (/404|model.*not.*found|not found/.test(text)) return "model_unavailable";
  if (/invalid json|no answer text|empty response|malformed/.test(text)) return "invalid_response";
  if (/5\d\d|upstream|internal server|bad gateway|service unavailable/.test(text)) return "upstream_error";
  return "unknown";
}

function schedule(ctx: OpsExecutionContext, env: Env, operation: (db: D1Database) => Promise<void>): void {
  if (!env.OPS_DB) return;
  ctx.waitUntil(operation(env.OPS_DB).catch((error) => console.error("[ops] telemetry write failed", error)));
}

export async function beginRequest(_ctx: OpsExecutionContext, env: Env, session: RequestSessionStart): Promise<void> {
  if (!env.OPS_DB) return;
  try {
    await env.OPS_DB.prepare(`
      INSERT OR REPLACE INTO request_sessions
      (request_id, started_at, mode, audited, search_used, sandbox_used, verification_status, final_status)
      VALUES (?, ?, ?, ?, ?, ?, 'not_requested', 'error')
    `).bind(
      session.requestId,
      isoNow(),
      session.mode,
      session.audited ? 1 : 0,
      session.searchUsed ? 1 : 0,
      session.sandboxUsed ? 1 : 0,
    ).run();
  } catch (error) {
    console.error("[ops] begin-request telemetry failed", error);
  }
}
export function recordProviderEvent(ctx: OpsExecutionContext, env: Env, event: ProviderTelemetryEvent): void {
  const observedAt = isoNow();
  schedule(ctx, env, async (db) => {
    const now = observedAt;
    const state = event.kind === "success" ? "healthy" : event.kind === "failure" ? (event.errorClass || "unknown") : "checking";

    await db.prepare(`
      INSERT INTO provider_events
      (request_id, timestamp, stage, event_kind, provider, model, latency_ms, http_status, error_class, retry_after_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      event.requestId,
      now,
      event.stage,
      event.kind,
      event.provider,
      event.model,
      event.latencyMs ?? null,
      event.status ?? null,
      event.errorClass || null,
      event.retryAfterMs ?? null,
    ).run();

    if (event.kind === "success") {
      await db.prepare(`
        INSERT INTO provider_health
        (provider,state,last_success_at,last_failure_at,last_status,last_error_class,next_retry_at,consecutive_failures,last_latency_ms,last_model,updated_at)
        VALUES (?, 'healthy', ?, NULL, ?, NULL, NULL, 0, ?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
          state='healthy',
          last_success_at=excluded.last_success_at,
          last_status=excluded.last_status,
          last_error_class=NULL,
          next_retry_at=NULL,
          consecutive_failures=0,
          last_latency_ms=excluded.last_latency_ms,
          last_model=excluded.last_model,
          updated_at=excluded.updated_at
      WHERE provider_health.updated_at <= excluded.updated_at
      `).bind(event.provider, now, event.status ?? 200, event.latencyMs ?? null, event.model, now).run();
    } else if (event.kind === "failure") {
      const nextRetry = event.retryAfterMs ? new Date(Date.parse(now) + event.retryAfterMs).toISOString() : null;
      await db.prepare(`
        INSERT INTO provider_health
        (provider,state,last_success_at,last_failure_at,last_status,last_error_class,next_retry_at,consecutive_failures,last_latency_ms,last_model,updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
          state=excluded.state,
          last_success_at=provider_health.last_success_at,
          last_failure_at=excluded.last_failure_at,
          last_status=excluded.last_status,
          last_error_class=excluded.last_error_class,
          next_retry_at=excluded.next_retry_at,
          consecutive_failures=provider_health.consecutive_failures+1,
          last_latency_ms=excluded.last_latency_ms,
          last_model=excluded.last_model,
          updated_at=excluded.updated_at
      WHERE provider_health.updated_at <= excluded.updated_at
      `).bind(
        event.provider,
        state,
        now,
        event.status ?? null,
        event.errorClass || "unknown",
        nextRetry,
        event.latencyMs ?? null,
        event.model,
        now,
      ).run();
    } else {
      await db.prepare(`
        INSERT INTO provider_health
        (provider,state,last_success_at,last_failure_at,last_status,last_error_class,next_retry_at,consecutive_failures,last_latency_ms,last_model,updated_at)
        VALUES (?, 'checking', NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
          state='checking',
          updated_at=excluded.updated_at,
          last_model=excluded.last_model
      WHERE provider_health.updated_at <= excluded.updated_at
      `).bind(event.provider, event.model, now).run();
    }

    if (event.stage === "primary" && event.kind === "success") {
      await db.prepare(`UPDATE request_sessions SET primary_provider=? WHERE request_id=?`).bind(event.provider, event.requestId).run();
    }
    if (event.stage === "verification" && event.kind === "success") {
      await db.prepare(`UPDATE request_sessions SET verifier_provider=?, verification_status='completed' WHERE request_id=?`).bind(event.provider, event.requestId).run();
    }
    if (event.stage === "final" && event.kind === "success") {
      await db.prepare(`UPDATE request_sessions SET final_provider=? WHERE request_id=?`).bind(event.provider, event.requestId).run();
    }
  });
}

export function finishRequest(ctx: OpsExecutionContext, env: Env, finish: RequestSessionFinish): void {
  schedule(ctx, env, async (db) => {
    await db.prepare(`
      UPDATE request_sessions
      SET completed_at=?, final_status=?, verification_status=?, duration_ms=?,
          primary_provider=COALESCE(?, primary_provider),
          verifier_provider=COALESCE(?, verifier_provider),
          final_provider=COALESCE(?, final_provider),
          audited=COALESCE(?, audited),
          search_used=COALESCE(?, search_used),
          sandbox_used=COALESCE(?, sandbox_used),
          error_class=?
      WHERE request_id=?
    `).bind(
      isoNow(),
      finish.finalStatus,
      finish.verificationStatus,
      finish.durationMs,
      finish.primaryProvider ?? null,
      finish.verifierProvider ?? null,
      finish.finalProvider ?? null,
      finish.audited == null ? null : (finish.audited ? 1 : 0),
      finish.searchUsed == null ? null : (finish.searchUsed ? 1 : 0),
      finish.sandboxUsed == null ? null : (finish.sandboxUsed ? 1 : 0),
      finish.errorClass || null,
      finish.requestId,
    ).run();
  });
}

export function errorClassFrom(value: unknown): string {
  return safeErrorClass(value) || "unknown";
}

export function classifyProviderHealth(state: string | null | undefined): "healthy" | "degraded" | "down" | "unknown" {
  if (!state) return "unknown";
  if (state === "healthy") return "healthy";
  if (["auth_error", "model_unavailable"].includes(state)) return "down";
  return "degraded";
}
