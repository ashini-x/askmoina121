# AskMoina Control Plane authentication (no Cloudflare Access)

The developer control plane uses GitHub OAuth so it does not depend on a Cloudflare Zero Trust billing profile or payment method.

## Cloudflare secrets / variables

- `GITHUB_CLIENT_ID` — Worker variable or secret
- `GITHUB_CLIENT_SECRET` — Worker secret
- `ADMIN_GITHUB_USERS` — Worker secret or variable containing the exact GitHub login(s) and/or numeric GitHub user ID(s) allowed to enter the control plane, comma-separated

## GitHub OAuth App

Create a GitHub OAuth App under GitHub Settings → Developer settings → OAuth Apps. Use:

- Application name: `AskMoina Control Plane`
- Homepage URL: `https://askmoina121.thenewtongs.workers.dev/admin/`
- Authorization callback URL: `https://askmoina121.thenewtongs.workers.dev/api/v1/admin/auth/callback`

Do not enable wildcard callback URLs. The app only requests the `read:user` scope so the Worker can identify the GitHub account.

## Security model

1. `/admin/` redirects the developer through GitHub OAuth.
2. A random state is stored hashed in D1 and bound to an HttpOnly cookie.
3. GitHub identity is checked against `ADMIN_GITHUB_USERS`.
4. The GitHub OAuth token is discarded after identity lookup; it is not stored.
5. AskMoina stores only a SHA-256 hash of a random session token in D1.
6. The browser receives a Secure, HttpOnly, SameSite=Lax session cookie.
7. Sessions expire after 8 hours and are cleaned up by the scheduled worker.
8. Admin APIs require the same session cookie.

Do not put the GitHub client secret or session tokens in GitHub.

## 1.5.3 cookie fix

The OAuth callback emits the session and state-clear cookies as separate `Set-Cookie` headers. Browsers must not be given multiple cookies combined into one comma-separated `Set-Cookie` header.
