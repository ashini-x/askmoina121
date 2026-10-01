# Behavior — 1.4.0

| Area | Implementation |
|---|---|
| Customer brand | Moina by AskMoina |
| AI architecture | Cloudflare Worker multi-provider router |
| Primary model | Gemini 3.8 Flash |
| Fallback 1 | Groq GPT-OSS-120B |
| Fallback 2 | Cloudflare Nemotron 3 120B A12B |
| Web research | Worker + DuckDuckGo search snippets |
| Code verification | Worker + E2B, optional |
| Streaming | SSE from Worker to browser |
| Local history | Browser localStorage |
| Prompt cap | 2,000 characters |
| History cap | 40 messages / 80K model-facing characters |
| Puter authentication | Removed |
| Provider/API names in normal UI | Removed |
