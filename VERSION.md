# AskMoina 1.5.5

Static-asset routing fix: protected `/admin` and dynamic `/api/*` routes now run through the Worker before Cloudflare serves static assets, so GitHub OAuth/session checks cannot be bypassed by asset-first routing.
