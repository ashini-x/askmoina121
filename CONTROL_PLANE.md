# AskMoina Control Plane

This release adds a private developer control plane to the existing AskMoina Worker. It records provider attempts, health state, request status, latency, failover, and verification availability without storing user prompt text, model output, API keys, or provider response bodies.

## Security
The Worker requires a Cloudflare Access identity for admin routes and also requires the authenticated email to appear in the `ADMIN_EMAILS` secret. Configure Cloudflare Access to protect `/admin/*` and `/api/v1/admin/*` on the production hostname.

## What you can see
- Current observed state of Gemini, Groq, and Cloudflare AI.
- Last HTTP status/error class and retry information observed.
- Recent request traces across primary, verification, and final passes.
- Whether independent verification actually completed.
- Recent failures and provider incidents.

## What is deliberately NOT stored
- User prompt content.
- Full model responses.
- API keys or secrets.
- Raw upstream response bodies.

## Important limitation
Provider status is an observed-health signal, not a hidden-quota oracle. Moina knows a provider is rate-limited/quota-limited/capacity-limited when an actual request returns a corresponding failure (or a provider reset header that we record). It does not guess a provider's private remaining quota.

## 1.5.5 routing fix

Protected admin pages and API routes use Cloudflare Workers Static Assets `run_worker_first` so authentication executes before static asset serving. Public static assets remain asset-first.

