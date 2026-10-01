# AskMoina 1.4.1 — Round 9 Fix

Round 9 exposed a general-assistant issue: a false-premise request could produce a blanket refusal instead of correcting the false premise and answering the useful underlying request.

The 1.4.1 prompt stack now:
- validates important premises before proving or explaining them;
- forbids presenting a false proposition as established;
- requires examples and conclusions to be checked for consistency with the original proposition;
- tells the final editor to replace a generic refusal with a safe correction when possible.

Regression coverage was added for these prompt invariants.
