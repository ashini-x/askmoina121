# AskMoina / Moina — 1.2.1

A standalone, custom-branded AI workspace. The customer-facing assistant is **Moina**, presented by **AskMoina**.

## Runtime

- `frontend/` — custom vanilla HTML/CSS/JS application and client-side AI orchestration.
- `src/` — Cloudflare Worker for privileged tools such as web search and optional Python verification.
- AI inference — browser-side Puter.js. AskMoina does not store OpenAI, Anthropic, or Groq provider API keys.
- Primary intelligence — `openai/gpt-6-astra`.
- Independent review — `anthropic/claude-fable-5-1`.
- Fallback — `openai/gpt-oss-120b`.
- Sandbox — E2B when `E2B_API_KEY` is configured.

The underlying provider/model names are implementation details and are intentionally not shown in the customer UI.

## Authentication

The application uses Puter.js browser authentication. Moina presents a custom onboarding screen first; the Continue button requests Puter temporary-user creation when possible, before the user starts chatting. Puter's sign-in popup may still appear because browser authentication is controlled by Puter.

## Secrets

**No AI provider key is required.** `E2B_API_KEY` is optional. Without it, Moina still works; Python verification is simply unavailable.

If E2B is enabled, store the key only as a Cloudflare Worker Secret or local `.dev.vars` value. Never commit it.

## Local development

```bash
npm install
copy .dev.vars.example .dev.vars
# E2B is optional; set E2B_API_KEY only when you want Python verification.
npm run dev
```

Then open the Worker URL shown by Wrangler.

## Validation

```bash
npm run typecheck
npm test
```

## Production

Connect this repository to Cloudflare Workers Builds or deploy with Wrangler. See `DEPLOYMENT.md` and `UPLOAD_AND_DEPLOY.md`.
