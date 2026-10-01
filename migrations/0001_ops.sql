CREATE TABLE IF NOT EXISTS request_sessions (
  request_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  mode TEXT NOT NULL,
  audited INTEGER NOT NULL DEFAULT 0,
  search_used INTEGER NOT NULL DEFAULT 0,
  sandbox_used INTEGER NOT NULL DEFAULT 0,
  primary_provider TEXT,
  verifier_provider TEXT,
  final_provider TEXT,
  verification_status TEXT NOT NULL DEFAULT 'not_requested',
  final_status TEXT NOT NULL DEFAULT 'error',
  duration_ms INTEGER,
  error_class TEXT
);

CREATE INDEX IF NOT EXISTS idx_request_sessions_started_at ON request_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_sessions_final_status ON request_sessions(final_status);

CREATE TABLE IF NOT EXISTS provider_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  stage TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  latency_ms INTEGER,
  http_status INTEGER,
  error_class TEXT,
  retry_after_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_provider_events_request_id ON provider_events(request_id, event_id);
CREATE INDEX IF NOT EXISTS idx_provider_events_timestamp ON provider_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_provider_events_provider ON provider_events(provider, timestamp DESC);

CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'unknown',
  last_success_at TEXT,
  last_failure_at TEXT,
  last_status INTEGER,
  last_error_class TEXT,
  next_retry_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_latency_ms INTEGER,
  last_model TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO provider_health(provider, state, updated_at) VALUES
  ('gemini', 'unknown', CURRENT_TIMESTAMP),
  ('groq', 'unknown', CURRENT_TIMESTAMP),
  ('cloudflare', 'unknown', CURRENT_TIMESTAMP);
