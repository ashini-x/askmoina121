# AskMoina 1.5.4

Admin route hardening: unauthenticated `/admin/` requests redirect to the GitHub login page, while authenticated dashboard responses are explicitly private/no-store and vary by Cookie.
