# Moina Architecture

## Customer surface

The application is branded **Moina by AskMoina**. Providers, API endpoints, routing decisions, and model identifiers are implementation details.

## Request flow

```text
Browser
  ↓
Moina frontend
  ↓
Cloudflare Worker
  ├─ input validation
  ├─ optional web search
  ├─ primary model
  ├─ optional E2B verification
  ├─ optional independent audit model
  └─ SSE response
  ↓
Browser
```

## AI provider order

1. Google Gemini 3.8 Flash
2. Groq GPT-OSS-120B
3. Cloudflare Nemotron 3 120B A12B

The Worker only uses providers that are configured/available at runtime.

## Search

DuckDuckGo HTML search runs in the Worker for prompts that are likely to benefit from current evidence. Search results are passed to the model inside explicit untrusted-evidence delimiters.

## Verification

Hard tasks can trigger a sandbox stage. Python code is validated before it is sent to E2B. The sandbox is killed in `finally` and has a timeout.

The audit stage uses a different provider than the primary provider when one is available.

## State

Conversation history is stored client-side for UX continuity and re-sent with each chat request. The Worker validates roles, bounds message size, and trims the model-facing history by characters.

## Security boundary

Provider secrets are Worker secrets. They are not stored in frontend JavaScript.

Customer-facing error messages are provider-neutral.
