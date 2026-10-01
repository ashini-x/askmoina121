# Provider Setup

## 1. Google Gemini — primary

Model:

```text
gemini-3.8-flash
```

The Worker calls the Gemini REST API with the server-side `GEMINI_API_KEY` secret. Thinking is selected from the Moina mode.

Google currently documents Gemini 3.8 Flash as a GA model with 1M input context, 65,536 max output tokens, and low/medium/high thinking. The current standard free tier is listed as free of charge; exact rate limits are shown in AI Studio and are project-scoped. See:

https://ai.google.dev/gemini-api/docs/latest-model
https://ai.google.dev/gemini-api/docs/pricing
https://ai.google.dev/gemini-api/docs/rate-limits

## 2. Groq — fast fallback

Model:

```text
openai/gpt-oss-120b
```

The Worker calls Groq's OpenAI-compatible endpoint with `GROQ_API_KEY`.

Groq currently lists GPT-OSS-120B at 30 RPM, 1,000 RPD, 8K TPM, and 200K TPD on the free plan. Groq also exposes rate-limit response headers with remaining requests/tokens and reset information.

https://console.groq.com/docs/rate-limits
https://console.groq.com/docs/model/openai/gpt-oss-120b

## 3. Cloudflare Workers AI — final fallback

Model:

```text
@cf/nvidia/nemotron-3-120b-a12b
```

The Worker uses the built-in `AI` binding. No separate provider API key is stored in the repository.

Cloudflare currently documents this model as supporting reasoning and function calling with a 256K context window. The Workers AI free allocation is metered in neurons; check the current Cloudflare AI pricing/limits for the account.

https://developers.cloudflare.com/workers-ai/models/nemotron-3-120b-a12b/
https://developers.cloudflare.com/workers-ai/platform/pricing/
https://developers.cloudflare.com/workers-ai/configuration/bindings/

## 4. E2B — optional verifier

`E2B_API_KEY` is only used for sandboxed Python verification.

Without the key, Moina still works; it simply skips Python execution.

Never expose the key in frontend code.

## Provider priority

Default order:

```text
Gemini 3.8 Flash
      ↓
GPT-OSS-120B via Groq
      ↓
Nemotron 3 120B A12B via Workers AI
```

The order is a practical prototype policy, not a claim of universal model superiority.
