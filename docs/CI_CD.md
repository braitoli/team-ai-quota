# CI/CD with GitHub Actions

Two workflows ship with the repo:

- `.github/workflows/ci.yml`: runs the Node and Python test suites and a Docker smoke test on every push and pull request, on GitHub-hosted runners. Nothing to configure.
- `.github/workflows/deploy.yml` ("CI / Deploy Worker"): optional pipeline that tests and then deploys the Cloudflare Worker with `wrangler`. It is **disabled by default**: every job is skipped unless the repository variable `DEPLOY_ENABLED` is `true`, so forks never try to deploy.

On pull requests only the `test` job runs. On a push to `main`, `test` runs first and `deploy` follows (`needs: test`, `concurrency: deploy-worker`). Deploy only through CI, not from a personal machine.

## 1. Enable the deploy pipeline

In **Settings -> Secrets and variables -> Actions** of your repository:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `DEPLOY_ENABLED` | `true` |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account id |
| Secret | `CLOUDFLARE_API_TOKEN` | API token, see below |
| Variable (optional) | `CI_RUNNER_LABELS` | JSON array of runner labels, default `["ubuntu-latest"]` |
| Variable (optional) | `MACHINE_LABELS` | JSON map of machine id prefix to display name, e.g. `{"a1b2c3":"MacBook-M3"}` |

With the GitHub CLI: `gh variable set DEPLOY_ENABLED --body true` and `gh secret set CLOUDFLARE_API_TOKEN`.

## 2. Cloudflare API token

Create a token limited to your account with the permissions needed by `wrangler deploy` (Workers Scripts: Edit, Account Settings: Read, and Workers KV Storage: Edit if you use KV). Store it only as the `CLOUDFLARE_API_TOKEN` secret, never in the repository. Rotate it by creating a new token, updating the secret, then deleting the old token.

## 3. Optional: self-hosted runner

By default jobs run on `ubuntu-latest`. To use your own runner, register it for the repository (Settings -> Actions -> Runners) and point the pipeline at its labels:

```bash
gh variable set CI_RUNNER_LABELS --body '["self-hosted","linux"]'
```

The runner needs Node.js 22+ and `npm`. Run the runner service under a dedicated unprivileged user and keep it updated.

`wrangler.jsonc` is gitignored, so the deploy job creates it from `wrangler.jsonc.example` (Durable Object binding, migrations, Worker name). To customise the Worker, edit the example file or commit your own config in your fork.

## 4. Machine names

The Worker has no built-in machine names. `MACHINE_LABELS` (variable above, or the same environment variable for Docker) and the Settings API in the dashboard define them. When the `MACHINE_LABELS` variable is set, the deploy job passes it to the Worker with `wrangler deploy --var`. On an existing install the configured names are merged under any labels already saved in Settings (saved labels win), so no manual migration is needed.

## 5. Rollback

- Disable the pipeline: set `DEPLOY_ENABLED` to anything other than `true`.
- Revoke access: delete the Cloudflare token and run `gh secret delete CLOUDFLARE_API_TOKEN`.
- Roll back a bad release with `npx wrangler rollback`.

## 6. Keeping a private deployment in sync with the public repo

A private deployment usually differs from the public source in a few values (worker URL, update repo, storage key prefix, display names). To make sure a sync or release never replaces them with placeholders:

- Set repo variables `PROD_DEFAULTS_EXPECTED=1` and `EXPECTED_STORAGE_PREFIX=<your prefix>`: `test/prod-defaults.test.js` then fails CI if `DEFAULT_WORKER_URL` / `UPDATE_REPO` in `client/report_quota.py` are placeholders or the dashboard's localStorage keys lose the prefix. Without the variables the test is skipped.
- Set `WORKER_URL`: the deploy job calls `<WORKER_URL>/health` after deploying and fails if the Worker does not answer.
- Do not copy those values when cherry-picking between repos; review the diff of `client/report_quota.py` and the `*_STORE` constants in `src/dashboard.js`.
