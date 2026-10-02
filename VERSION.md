# AskMoina 1.5.3 — Control Plane Final

## Included

- Private developer Control Plane with D1-backed telemetry
- GitHub OAuth developer authentication with `ADMIN_GITHUB_USERS` allow-list
- Optional `ADMIN_HOSTNAME` lock for a dedicated admin hostname
- Provider health, request traces, verification status, incidents, and configuration presence
- 30-day telemetry retention via daily Cron Trigger
- Public-facing error sanitization so provider/API internals are not returned to users
- Monotonic provider-health updates using event timestamps to reduce out-of-order telemetry races

## 1.5.3 hotfix

- Fixed multiple `Set-Cookie` handling in the GitHub OAuth callback so the admin session cookie is reliably stored by browsers.
- Explicitly sends same-origin credentials for Control Plane API requests.
- Aligns the system-status allow-list field with the admin dashboard.
