# AskMoina 1.2.1

## What changed

- Rebranded customer experience from infrastructure/provider terminology to **Moina by AskMoina**.
- Primary model changed to `openai/gpt-6-astra`.
- Audit model changed to `anthropic/claude-fable-5-1`.
- Fallback added: `openai/gpt-oss-120b`.
- Puter authentication now attempts temporary-user onboarding from a user click.
- Provider/model names removed from user-facing copy and health output.
- Reasoning instructions no longer ask the model to expose scratchpad text.
- Search content remains explicitly untrusted data.
- Audit failure falls back to the verified primary draft rather than breaking the conversation.
- Primary inference failure can switch to the fallback model for transient availability/rate-limit style errors.

## No AI provider key

No Groq, OpenAI, or Anthropic API key is used. Puter.js handles model access in the browser. E2B remains the only server-side secret in this release.
