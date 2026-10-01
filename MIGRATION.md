# Moina 1.3.0 — Multi-Provider Release

## Main change

The previous Puter.js browser-AI architecture has been removed.

Moina now uses a Cloudflare Worker as the AI gateway and keeps provider credentials server-side.

## Provider stack

```text
Primary   → Gemini 3.8 Flash
Fallback  → Groq GPT-OSS-120B
Fallback  → Cloudflare Nemotron 3 120B A12B
Verifier  → a different available provider when a hard task needs review
```

## Product branding

The customer UI is **Moina by AskMoina**. Provider names and implementation details are intentionally omitted from normal product copy.

## Authentication

There is no Puter authentication popup in this release.

## Secrets

Required for the full stack:

```text
GEMINI_API_KEY
GROQ_API_KEY
```

Optional:

```text
E2B_API_KEY
```

## Security improvements

- No provider API key is shipped to the browser.
- Web search output is treated as untrusted evidence.
- Prompt length and conversation history are server-bounded.
- Generated Python is policy-checked before E2B execution.
- Hard tasks keep the primary draft server-side until audit/finalization.
- Provider fallback is disabled after visible partial output to prevent answer splicing.

## Notes

Free-tier limits are provider-owned and can change. This release increases the available testing runway by using several independent legitimate providers; it does not create unlimited inference.
