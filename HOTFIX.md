# 1.4.0 intelligence hardening

This release supersedes the 1.3.x provider parsing hotfixes with a general-purpose verification pipeline.

Key changes:
- prompt-injection phrases are no longer blocked at the input layer;
- history is serialized as untrusted transcript data;
- independent verification no longer receives the primary draft;
- final review compares the primary draft with an independent reference;
- empty final-review responses fall back safely to a non-empty reference/draft;
- request-body size is enforced after reading the actual bytes;
- provider requests receive a timeout;
- live-search calls honor request cancellation;
- prompt limits are increased for real code and long-form use.
