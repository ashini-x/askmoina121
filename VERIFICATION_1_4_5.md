# Moina 1.4.5 — Verification Hardening

## Fix

A benchmark uncovered a case where Moina found the correct answer to a finite XOR enumeration problem but then supplied an invalid second “independent verification” using an incorrect GF(2) basis.

Moina 1.4.5 now instructs the independent verifier and final editor to treat every claimed independent verification as untrusted evidence and to validate the verification method itself.

For GF(2)/linear-algebra solutions this includes checking the particular vector, every claimed nullspace/basis vector, and every parameter-to-solution mapping against the original equations. For small finite domains, direct exhaustive enumeration is preferred when it is easier to validate than an algebraic shortcut.

## Important behavior

Moina must not say a result was “independently confirmed” unless the independent check is itself valid. If the second method is wrong but the primary result is right, Moina should report the verification defect and retain only the result that survives checking.
