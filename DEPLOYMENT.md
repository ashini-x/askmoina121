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
Cloudflare Access: OFF
```

Worker secrets:

```text
GEMINI_API_KEY   required for Gemini
GROQ_API_KEY     required for Groq fallback
E2B_API_KEY      optional for Python verification
```
