# Local secrets & machine-only data

Nothing sensitive is committed. Everything below lives on the machine that runs the monitor.

| Item | Where it lives | Committed? |
|---|---|---|
| Worker access key | `.secrets/quota-key.txt` (repo clone, gitignored) → copied by setup to `~/.claude/claude-quota-secret-key.txt` (chmod 600) | No |
| Claude account email | read at run time from `claude auth status` | No |
| agy account email | read at run time from `~/.gemini/antigravity-cli/antigravity-oauth-token` (`id_token_email`, or the `email` claim of `id_token`); tokens are never printed, stored or sent | No |

## For an agent setting this up on a new machine
1. Clone the repo. Get the access key from the owner (never from git history or chat logs).
2. `mkdir -p .secrets && printf '%s\n' '<KEY>' > .secrets/quota-key.txt && chmod 600 .secrets/quota-key.txt`
   (template: `docs/quota-key.example.txt`). Alternative: `export CLAUDE_QUOTA_SECRET_KEY=<KEY>` or `CLAUDE_QUOTA_SECRET_KEY_FILE=/path/to/file`.
3. Run `scripts/setup-mac.sh` / `setup-linux.sh` / `setup-windows.ps1`. It fails fast, with a message, if no key is found.
4. Never paste the key into docs, scripts, commit messages or PRs. Print only the key *name*. Before committing run `git grep -n "<first 6 chars of key>"`, which must return nothing.
5. If a new kind of sensitive local data appears, add its path to `.gitignore` under `.secrets/` and document it in the table above.

## Rotating
The old key was embedded in earlier commits, so treat it as exposed: rotate `API_SECRET_KEY` on the Worker
(`npx wrangler secret put API_SECRET_KEY`, or via CI/CD per docs/CI_CD.md), then update `.secrets/quota-key.txt` and re-run setup.
