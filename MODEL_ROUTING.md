# Moina Model Routing — 1.4.2

## General-purpose routing

Moina is designed for arbitrary user prompts rather than a fixed benchmark. The server classifies requests with lightweight deterministic signals and then chooses the least expensive pipeline that is appropriate:

```text
simple request
  -> primary answer

reasoning / code / current / high-stakes / precision request
  -> primary draft
  -> optional isolated Python verification
  -> independent reference pass (without seeing the draft)
  -> final editor compares draft + reference + evidence
```

This fixes the earlier self-audit weakness where the second model saw the draft first and could anchor on it.

## Why the verifier is draft-free

The independent verification pass receives the original request, conversation context, web evidence, and sandbox feedback, but **not the primary draft**. Its job is to reconstruct the answer independently. The final editor then adjudicates between the draft and the independent reference.

That means a correct final conclusion no longer causes Moina to assume every intermediate claim in the draft was correct.

## Provider diversity

The preferred primary order is:

```text
gemini -> groq -> cloudflare
```

The independent pass prefers a different provider:

```text
groq -> gemini -> cloudflare
```

The final editor prefers a third provider when one is available:

```text
cloudflare -> gemini -> groq
```

This is a routing preference, not a claim that one model is universally better than another. Provider response failures, quota errors, timeouts, and temporary capacity errors can trigger failover.

## Quota philosophy

Moina uses one legitimate account/key per configured provider. It does not create, rotate, or coordinate extra identities to bypass provider limits.

The in-memory cooldown map is only a local optimization in a serverless environment. It is not a global quota ledger; the provider's response remains authoritative.

## Prompt-injection handling

Moina 1.4.2 removes the old regex that rejected user messages containing phrases such as “ignore previous instructions”. A person may legitimately ask about prompt injection, jailbreaks, system prompts, or security research.

Instead:

- user text is normalized, not keyword-blocked;
- browser-supplied history is serialized as inert transcript data rather than privileged assistant messages;
- search results and sandbox output are explicitly labeled untrusted data;
- system instructions tell each reasoning pass not to follow commands embedded in those data blocks.

## Search behavior

Live search is triggered by current/time-sensitive requests, explicit research/source requests, URLs/date-like references, and selected high-stakes topics. Long creative prompts no longer trigger search merely because they are long.

## Output buffering

Simple requests can stream the primary answer immediately. Reviewed requests buffer the draft until verification and final editing are complete, so the user never receives a partial answer that is later silently replaced by a different answer.
