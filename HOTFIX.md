# AskMoina 1.5.4 hotfix

## Admin route hardening
- Unauthenticated `/admin` and `/admin/` requests now return a `302` to `/admin-login.html` instead of serving the dashboard HTML.
- Authenticated dashboard responses are marked private/no-store, CDN no-store, and `Vary: Cookie`.
- This prevents an authenticated dashboard shell from being reused for an anonymous browser.
