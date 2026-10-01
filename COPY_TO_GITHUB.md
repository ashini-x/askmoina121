# Copy to GitHub

1. Extract this ZIP.
2. Open the folder **containing** `package.json`, `wrangler.jsonc`, `frontend/`, and `src/`. That is the repository root.
3. Create a new empty GitHub repository.
4. Upload the **contents** of that root folder, not the ZIP and not the parent folder.
5. Do not upload `.dev.vars` or any secret file.
6. The repository should contain `frontend/`, `src/`, `tests/`, `docs/`, `package.json`, `wrangler.jsonc`, and the documentation files at its top level.

Then connect that GitHub repository to Cloudflare Workers Builds, or deploy with Wrangler.
