# 1.3.1 Provider Reliability Hotfix

The previous build could show “Moina returned an empty response” because provider-specific streaming response formats were not normalized consistently.

This release uses reliable non-streaming upstream provider responses, extracts final answer text across Gemini, Groq, and Cloudflare response shapes, then streams normalized text chunks to the browser.
