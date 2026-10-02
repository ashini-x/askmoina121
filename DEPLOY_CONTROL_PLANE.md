# AskMoina 1.5.2 — Control Plane Deployment

## 1. Create the D1 database

From the project folder:

```bash
npx wrangler d1 create askmoina-ops
```

Copy the returned `database_id`.

## 2. Add the database ID

Edit `wrangler.jsonc` and replace:

```text
REPLACE_WITH_D1_DATABASE_ID
```

with the real D1 database ID.

## 3. Apply the migration

```bash
npx wrangler d1 migrations apply askmoina-ops --remote
```

## 4. Add your developer email as a secret

```bash
npx wrangler secret put ADMIN_EMAILS
```

Enter the email address you will use to sign in through Cloudflare Access. Multiple addresses are comma-separated.

## 5. Keep the AI secrets server-side

Existing secrets remain:

- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `E2B_API_KEY` (optional)

Do not put secrets into frontend files.

## 6. Type-check and deploy

```bash
npm run typecheck
npx wrangler deploy
```

For your existing Git-connected Cloudflare Worker, commit/push the changed files and ensure the production build uses the updated `wrangler.jsonc`.

## 7. Protect the control plane with Cloudflare Access

Recommended: use a separate hostname such as `admin.askmoina.com`, set `ADMIN_HOSTNAME=admin.askmoina.com`, and protect that entire hostname with Cloudflare Access.

Fallback: protect only `/admin/*` and `/api/v1/admin/*` on the main production hostname.

Set an Allow policy for your developer email or Access group. Do not protect the public chat routes. Cloudflare Access authenticates requests before the Worker runs; the Worker additionally checks `ctx.access.getIdentity()` and the `ADMIN_EMAILS` allow-list.

## 8. Verify the Worker is running and telemetry is enabled

After deployment, open the public Moina site and send `hi` once. Then open the Control Plane. The system configuration panel should show the D1 binding and configured provider presence. Provider health is **observed health**, not a private quota oracle; it becomes specific after an actual request succeeds or fails.

## 9. Open the dashboard

```text
https://YOUR_DOMAIN/admin/
```

Complete the Access login. The Control Plane should load.

## 10. Test telemetry

Use the public Moina app and send a tiny request such as:

```text
hi
```

Then refresh Control Plane → Recent requests. A request trace should appear.

If providers are unavailable, the provider table should show the latest state such as `rate_limited`, `quota_exhausted`, `capacity`, `timeout`, `auth_error`, or `model_unavailable`.

## 11. Read a detailed trace

Click `View` for a recent request. You should see provider attempts for each stage, latency, HTTP status, and error class. No prompt text is stored.

## 12. Optional automation later

For CI/CD or monitoring, Cloudflare Access service tokens can be added later instead of exposing an admin secret in scripts.
