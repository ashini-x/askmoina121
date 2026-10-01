# Deployment — Moina by AskMoina

## Accounts

- GitHub
- Cloudflare
- Puter is used by visitors for browser AI access/authentication.
- E2B is optional for Python verification.

**No OpenAI, Anthropic, or Groq API key is required.**

## Optional E2B secret

If you want Python verification, create an E2B API key and add it in Cloudflare: Workers & Pages → your Worker → Settings → Variables and Secrets → Add → Secret.

Name:

```text
E2B_API_KEY
```

Paste the E2B key as the secret value, then deploy. If the secret is omitted, Moina simply skips executable Python verification.

## GitHub deployment

1. Workers & Pages → Create application → Import a repository.
2. Connect GitHub and select the AskMoina repository.
3. Use Worker name `askmoina121` unless you also change `wrangler.jsonc`.
4. Save and Deploy.
5. Add the optional `E2B_API_KEY` secret if desired.
6. Deploy again if Cloudflare asks you to.
7. Open the resulting `workers.dev` URL.

## First use

Click Send from Moina. If a Puter session is not already available, the app requests a temporary-user sign-in flow from that user action. A Puter authentication window can still appear; browsers require popup authentication to originate from user interaction.

## Verification

Open:

```text
https://YOUR-WORKER.workers.dev/api/v1/health
```

Expected result is a small JSON object indicating the Moina tools service is ready.
