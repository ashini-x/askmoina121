# Upload to GitHub + Deploy `askmoina121`

This release is designed for a Cloudflare Worker serving the static Moina frontend.

## 1. Extract the ZIP

Extract the release so the folder you open contains:

```text
package.json
wrangler.jsonc
frontend/
src/
tests/
docs/
```

That folder is the repository root.

## 2. Create or update GitHub

For a new repository:

1. GitHub → `+` → `New repository`.
2. Repository name: `askmoina121`.
3. Private is recommended while developing.
4. Do **not** initialize with another README, `.gitignore`, or license.
5. Create the repository.

Then choose `Add file` → `Upload files` and upload the **contents** of the extracted release folder.

The GitHub root must look like:

```text
frontend/
src/
tests/
docs/
package.json
wrangler.jsonc
README.md
.gitignore
```

Do not upload:

```text
.dev.vars
.env
node_modules/
```

Do not paste real API keys into GitHub.

Commit with something such as:

```text
Deploy Moina multi-provider AI engine
```

## 3. Connect GitHub to Cloudflare

Cloudflare Dashboard → `Workers & Pages` → create/import a Worker from your GitHub repository.

Select:

```text
Repository: askmoina121
Worker name: askmoina121
Root directory: /
Build command: blank
Deploy command: npx wrangler deploy
Preview command: npx wrangler preview
Preview builds: ON
Cloudflare Access: OFF
```

The Worker name is already set to `askmoina121` in `wrangler.jsonc`.

## 4. Add the AI provider secrets

After the Worker exists:

`Workers & Pages` → `askmoina121` → `Settings` → `Variables and Secrets` → add **Secret**.

Add:

```text
GEMINI_API_KEY
GROQ_API_KEY
```

Values:

- `GEMINI_API_KEY`: a Gemini API key created in Google AI Studio.
- `GROQ_API_KEY`: a Groq API key from the Groq console.

Optional:

```text
E2B_API_KEY
```

Only add that when you want Python verification.

Do not add a `PUTER_*`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` secret. This release does not use Puter and does not directly call OpenAI or Anthropic.

## 5. Workers AI binding

The `wrangler.jsonc` file already contains:

```json
"ai": {
  "binding": "AI",
  "remote": true
}
```

Cloudflare makes that binding available to Worker code as `env.AI`. If Cloudflare asks you to enable Workers AI, enable it for the account.

## 6. Deploy

With the GitHub integration active, commit/pushes to the configured production branch trigger builds.

You can also deploy manually from a local checkout:

```bash
npm install
npx wrangler login
npx wrangler deploy
```

## 7. Check health

Open:

```text
https://askmoina121.<your-workers-subdomain>.workers.dev/api/v1/health
```

You should receive JSON with the Moina service status and the number of configured AI providers. Provider names are intentionally not returned.

## 8. Test Moina

Try:

```text
hi
```

Then:

```text
Explain why the sky is blue.
```

Then a current question, for example:

```text
What are the latest major developments in AI?
```

Then a calculation:

```text
Calculate compound interest on ₹500000 at 12% for 7 years.
```

If E2B is configured, harder calculations/code tasks can trigger Python verification.

## 9. What happens when a provider reaches its limit?

Moina tries the configured providers in priority order. Temporary rate-limit/quota/capacity failures put that provider into a local cooldown and Moina tries the next eligible provider.

This is intentionally conservative. It never creates extra accounts or rotates credentials to evade provider quotas.

Because Workers are distributed, the local cooldown is only a hint. The provider's actual response is authoritative.

## 10. Custom domain later

You can attach `askmoina.com` (or another domain) to the Worker later. Changing the domain does not change the AI provider architecture.
