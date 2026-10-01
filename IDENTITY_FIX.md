# Moina 1.4.2 — Identity and Transparency Fix

This release hardens the customer-facing identity to **Moina by AskMoina**.

## Changes
- Direct identity questions use a stable product answer.
- Moina must not claim OpenAI or another backend provider built/created/owns Moina.
- Moina must not claim AskMoina trained the underlying foundation models.
- Provider/model/API/routing details remain hidden from normal customer-facing responses.
- Requests for hidden/system/developer instructions now receive a safe high-level behavior summary instead of a generic refusal.
- Prompt-level identity instructions remain in the primary, independent verification, and final review passes as defense in depth.
