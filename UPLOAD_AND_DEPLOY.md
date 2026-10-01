# Manual GitHub Upload + Cloudflare Deployment

This is the exact procedure for the supplied AskMoina 1.2.1 release.

## 1. Extract the ZIP

Extract the ZIP and open the folder that directly contains:

- `package.json`
- `wrangler.jsonc`
- `frontend/`
- `src/`
- `tests/`

That folder is the repository root.

## 2. Create the GitHub repository

GitHub → `+` → `New repository`.

Suggested name: `askmoina121`

For development, Private is recommended. Do not initialize the repository with another README, `.gitignore`, or license because this release already contains its own repository files.

## 3. Upload the contents

Inside the empty GitHub repository choose `Add file` → `Upload files`.

Drag the **contents** of the extracted project root into the GitHub upload area. The top-level folders such as `frontend/` and `src/` must remain folders in GitHub.

Do not upload:

- `.dev.vars`
- `.env`
- `node_modules/`
- any API key or credential file

Commit with a message such as `Initial Moina 1.2.1 release`.

## 4. Connect GitHub to Cloudflare

Cloudflare Dashboard → Workers & Pages → Create application → Import a repository.

Connect GitHub, choose the `askmoina121` repository, then Save and Deploy.

The repository already contains `wrangler.jsonc`, which declares the Worker entry point and static frontend asset directory. The Worker name is `askmoina121`.

## 5. Optional E2B key

The application does not need an AI provider key. If you want Python execution/verification, add:

`E2B_API_KEY`

as a Cloudflare Worker Secret under Settings → Variables and Secrets. Do not put this value in GitHub.

## 6. Open the site

Cloudflare gives you a `workers.dev` URL. Open it in a normal browser window.

You should see the custom `Moina by AskMoina` interface.

## 7. First AI request

Type a question and press Send. The application calls the Puter browser SDK. If the visitor is not already authenticated, Puter may open its authentication window. The app requests temporary-user creation to reduce signup friction.

The provider/model names are intentionally not displayed in the customer UI.

## 8. Test

Try these in order:

1. `Explain why the sky is blue.`
2. `What is the current population of India?`
3. `Calculate compound interest on ₹500000 at 12% for 7 years and show the calculation.`
4. Regenerate an answer.
5. Reload the page and check History.

## 9. Continuous deployment

Once GitHub integration is connected, pushes to the connected branch can trigger Cloudflare builds/deployments automatically. Cloudflare provides build status and preview/deployment URLs for the integration.

## 10. If something fails

- Blank page → check the Cloudflare deployment/build log and confirm `frontend/index.html` was uploaded at the repository root under `frontend/`.
- AI won't start → allow the authentication popup and reload.
- Search unavailable → the model should continue with its own knowledge.
- Python verification unavailable → check whether `E2B_API_KEY` was added; it is optional.
- Worker tools unavailable → open `/api/v1/health` on the deployed domain.


## Worker name

The Cloudflare Worker is configured as `askmoina121` in `wrangler.jsonc`. This controls the default `workers.dev` hostname; the customer-facing product remains branded as **Moina by AskMoina**.
