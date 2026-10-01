# Moina Architecture

## Customer surface

The application is branded as **Moina by AskMoina**. Provider and model names are implementation details, not customer-facing concepts.

## Request flow

1. User submits a prompt from the Moina UI.
2. Browser-side guardrails normalize and reject obvious adversarial patterns.
3. Moina presents a custom onboarding screen. The Continue action initializes Puter authentication and requests temporary-user creation when available.
4. Worker web search gathers a small set of current source snippets.
5. Search snippets are inserted into the model context as explicitly untrusted data.
6. GPT-6 Astra produces the primary response with high reasoning effort.
7. If the primary model is temporarily unavailable, the request can fall back to GPT-OSS-120B.
8. If a Python block is present, the Worker validates and executes it in E2B.
9. Claude Fable 5.1 performs an independent review pass.
10. If the review pass is unavailable, the verified primary draft remains the final answer.
11. The browser renders the final streamed answer.

## Security boundaries

- Provider credentials for model inference are not stored by AskMoina.
- The E2B API key remains a Cloudflare Worker secret.
- Search material, draft text, and sandbox feedback are treated as data rather than instructions by the model prompts.
- Customer UI does not expose provider/model branding.

## Important limitation

Because inference is performed through a browser-side AI service, a technically sophisticated user can inspect browser code/network activity and identify the underlying model. Branding changes the product experience; it cannot make the underlying technical dependency unknowable to someone inspecting the application.
