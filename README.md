# Moina by AskMoina

A multi-provider, Cloudflare Worker-based AI application with a custom consumer UI.

## What it does

Moina keeps the product surface provider-neutral while routing inference through a small set of strong provider options:

- **Google Gemini 3.8 Flash** — primary path, high thinking for the Logical/Auto modes.
- **Groq `openai/gpt-oss-120b`** — high-quality fallback with fast inference.
- **Cloudflare Workers AI `@cf/nvidia/nemotron-3-120b-a12b`** — final fallback when the Cloudflare AI binding is available.

Harder requests can additionally use isolated E2B Python verification and a second provider for an independent review. Simple requests use one model call to conserve free capacity.

## User experience

The website is branded **Moina by AskMoina**. Provider names, API keys, routing state, and infrastructure details are not shown in the normal customer UI.

This is product branding, not a claim that AskMoina trained the underlying foundation models. The privacy policy should accurately describe third-party AI processing where applicable.

## Required accounts / secrets

For the full three-provider AI stack you need:

1. A **Google AI Studio / Gemini API key** stored as the Cloudflare Worker secret `GEMINI_API_KEY`.
2. A **Groq API key** stored as the Cloudflare Worker secret `GROQ_API_KEY`.
3. No API key is required for the Cloudflare Workers AI binding; the `AI` binding is configured in `wrangler.jsonc`.
4. `E2B_API_KEY` is optional and only enables Python verification.

**Never commit any real key to GitHub.**

## Local development

Requirements:

- Node.js 18+ (Wrangler supports current LTS releases; use a current LTS version).
- A Cloudflare account with Workers AI enabled for the AI binding.

```bash
npm install
copy .dev.vars.example .dev.vars
# fill in GEMINI_API_KEY and GROQ_API_KEY; E2B_API_KEY is optional
npm run dev
```

The Worker uses a remote Workers AI binding for local development. Cloudflare documents that AI bindings do not run as a fully local simulation and can connect to remote AI resources from `wrangler dev`. 

## Validation

```bash
npm run typecheck
npm test
```

`npm test` requires the dev dependencies to be installed.

## Production

Recommended flow:

1. Upload this repository to GitHub.
2. Connect the repository to Cloudflare Workers Builds.
3. Use `/` as the root directory.
4. Leave the build command blank.
5. Use `npx wrangler deploy` as the deploy command.
6. Add `GEMINI_API_KEY` and `GROQ_API_KEY` as Worker Secrets.
7. Add `E2B_API_KEY` only if Python verification is desired.
8. Open the deployed `workers.dev` URL.

See `UPLOAD_AND_DEPLOY.md` for the exact click-by-click process.

## Architecture notes

The browser sends chat history to the Worker. The Worker validates, trims, and re-encodes that history before inference. Search output is wrapped as untrusted evidence. Model-generated Python is validated and, when E2B is configured, executed in a separate sandbox with a timeout and cleanup.

Provider failover is **quota-aware heuristics**, not a guaranteed quota ledger: Cloudflare Workers can scale across isolates, so in-memory cooldowns are only a local optimization. The provider response remains the source of truth.
