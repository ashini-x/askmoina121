# AskMoina 1.5.6 — Control Plane Dashboard Asset Fix

## What changed

The authenticated `/admin/` route now fetches `admin.html` from the Cloudflare Static Assets binding using an explicit assets URL instead of passing the incoming `Request` object as `RequestInit`.

This avoids a Workers-runtime request-construction failure that could occur after successful GitHub OAuth authentication and make `/admin/` appear as a generic browser "page isn't working" error while authenticated admin API endpoints still worked.

## Verification target

After deployment:

1. `/admin/` unauthenticated should redirect to `/admin-login.html`.
2. GitHub OAuth should complete and set the admin session cookie.
3. Authenticated `/api/v1/admin/system` should return build `1.5.6` and the developer login.
4. Authenticated `/admin/` should serve the dashboard HTML instead of a 5xx response.
