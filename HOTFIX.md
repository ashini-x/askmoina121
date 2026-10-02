# 1.5.5 Hotfix

The previous control-plane code had the correct authentication logic, but Cloudflare Static Assets could serve a matching/route asset before invoking the Worker. That meant `/admin/` could display the dashboard shell before the auth middleware ran.

1.5.5 adds selective `assets.run_worker_first` for `/admin`, `/admin/*`, and `/api/*`. This ensures the Worker executes first for protected and dynamic paths while leaving ordinary static assets cache/edge friendly.
