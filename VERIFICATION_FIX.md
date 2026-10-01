# Moina 1.4.4 — Independent verification fallback

## Problem
A difficult request could finish with the UI notice that independent verification was unavailable even though the primary provider had already answered successfully. The previous routing excluded the primary provider, and if every alternate provider was unavailable, verification stopped.

## Fix
Moina now prefers a different provider for the independent pass, but if alternate providers are unavailable or rate-limited, it may run a second independent verification call through the primary provider. This remains independent because the verifier never receives the draft and solves the original request separately.

## Why
Provider diversity is useful, but a hard dependency on a second provider made verification fragile. The new policy is: diverse provider first, same provider as a last resort, never pretend verification happened if every verifier call fails.
