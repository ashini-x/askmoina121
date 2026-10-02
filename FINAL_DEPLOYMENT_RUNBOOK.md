# Moina 1.5.2 — Final Deployment Runbook

This release adds a private developer Control Plane and hardens the public error path so provider failures do not appear as raw upstream errors to customers.

## 1. Create the D1 database

```bash
npx wrangler d1 create askmoina-ops
```

Copy the returned `database_id` into `wrangler.jsonc`.

## 2. Apply telemetry schema

```bash
npx wrangler d1 migrations apply askmoina-ops --remote
```

Cloudflare's D1 CLI supports applying migrations to the remote database with `--remote`.

## 3. Configure secrets

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put ADMIN_EMAILS
```

`E2B_API_KEY` is optional. Use Cloudflare Worker Secrets for API keys and other sensitive values.

## 4. Deploy

```bash
npm install
npm run typecheck
npm test
npx wrangler deploy
```

If Cloudflare Workers Builds is connected to GitHub, commit and push the repository instead; use the deployment command configured in your existing build.

## 5. Give the Control Plane its own hostname (recommended)

For the cleanest production setup, create a separate Worker custom hostname such as:

```text
admin.askmoina.com
```

Route the same Worker to that hostname. Then set the non-secret Worker variable `ADMIN_HOSTNAME=admin.askmoina.com`. With that value set, `/admin` and `/api/v1/admin/*` return 404 on every other hostname.

If you are not ready to create a separate hostname yet, leave `ADMIN_HOSTNAME` empty and instead protect only these paths with Cloudflare Access on your existing production hostname:

- `/admin/*`
- `/api/v1/admin/*`

Allow only your developer email or group. Do not protect the public chat routes.

Cloudflare Access authenticates the request before the Worker runs, and the Worker additionally checks `ctx.access.getIdentity()` and requires the authenticated email to appear in `ADMIN_EMAILS`.

## 6. Use the dashboard

Open:

```text
https://YOUR_DOMAIN/admin/
```

You will see:

- system configuration presence (never secret values)
- observed provider health
- last HTTP status and error class
- retry information
- request traces
- verification completion/unavailability
- recent incidents

The request trace intentionally excludes prompt text, model output, API keys, and raw upstream response bodies.

## 7. Diagnose the current “empty response” problem

Send `hi` from the public app, then open Control Plane → Recent requests → View.

Examples:

- `429` / `rate_limited` → provider is rate-limited.
- `quota_exhausted` → a provider returned a quota/day/token limit.
- `capacity` → provider reported temporary capacity trouble.
- `auth_error` → secret/authentication configuration problem.
- `timeout` → upstream call timed out.
- `model_unavailable` → selected model is unavailable.
- `invalid_response` → provider returned an unusable payload.

If all providers fail, the Control Plane makes that visible instead of collapsing everything into a generic empty-response guess.

## 8. Retention

A daily Worker Cron Trigger deletes telemetry older than 30 days. Cron expressions run in UTC.

## 9. What not to do

Do not expose `/api/v1/admin/*` publicly, put API keys in GitHub, put secrets in `wrangler.jsonc`, or create multiple provider accounts to evade provider quotas.

## 1.5.5 routing fix

Protected admin pages and API routes use Cloudflare Workers Static Assets `run_worker_first` so authentication executes before static asset serving. Public static assets remain asset-first.

