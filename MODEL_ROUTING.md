# Moina Model Routing

## Goal

Use a small set of strong providers and consume their legitimate free/available capacity without making the customer choose a provider.

## Primary path

Moina starts with:

```text
gemini-3.8-flash
```

with high thinking for Logical/Auto modes and medium thinking for Creative mode.

## Fallback path

If the primary provider is temporarily unavailable before any answer text is visible, Moina can fall back to:

```text
openai/gpt-oss-120b
```

and then:

```text
@cf/nvidia/nemotron-3-120b-a12b
```

## Independent review

Hard requests can use a second provider after the primary draft has been created. The audit prompt explicitly excludes the primary provider so the review is not simply the same model called twice.

Simple requests avoid the audit call to conserve inference capacity.

## Why there is no permanent “global ranking” number

Model leaderboards change, and a model can be strongest for one task while another is stronger for coding, vision, or long-context reasoning. Moina therefore hardcodes a **small, vetted provider set** for this release rather than trying to infer intelligence from model names or context size.

## Failover safety

Moina only fails over on temporary/rate-limit/quota/capacity style failures. If a provider has already emitted user-visible answer text and then fails, Moina does **not** splice another provider's answer into the partial response. That prevents malformed mixed answers.

## Quota philosophy

Moina uses one legitimate provider credential/account per provider. It does not create or rotate extra accounts/keys to bypass limits.
