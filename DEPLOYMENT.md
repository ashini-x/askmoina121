# Deployment summary

The canonical deployment procedure is in `UPLOAD_AND_DEPLOY.md`.

Cloudflare settings:

```text
Project / Worker: askmoina121
Root directory: /
Build command: blank
Deploy command: npx wrangler deploy
Preview command: npx wrangler preview
Preview builds: ON
Cloudflare Access: ON for `/admin/*` and `/api/v1/admin/*` only
```

Worker secrets:

```text
GEMINI_API_KEY   required for Gemini
GROQ_API_KEY     required for Groq fallback
E2B_API_KEY      optional for Python verification
ADMIN_EMAILS     developer email allow-list for the Control Plane
```


Recommended Control Plane variables: `ADMIN_HOSTNAME=admin.askmoina.com` (non-secret) and `ADMIN_EMAILS` (secret).

## 1.5.5 routing fix

Protected admin pages and API routes use Cloudflare Workers Static Assets `run_worker_first` so authentication executes before static asset serving. Public static assets remain asset-first.

