# AskMoina 1.5.1 — Control Plane Final

## Included

- Private developer Control Plane with D1-backed telemetry
- Cloudflare Access identity enforcement plus `ADMIN_EMAILS` allow-list
- Optional `ADMIN_HOSTNAME` lock for a dedicated admin hostname
- Provider health, request traces, verification status, incidents, and configuration presence
- 30-day telemetry retention via daily Cron Trigger
- Public-facing error sanitization so provider/API internals are not returned to users
- Monotonic provider-health updates using event timestamps to reduce out-of-order telemetry races
