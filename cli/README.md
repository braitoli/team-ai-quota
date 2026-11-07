# team-ai-quota (CLI: `taq`)

Ask your team's [Team AI Quota](https://github.com/braitoli/team-ai-quota) server from the terminal or from an AI agent:
which account to use right now, quota status, which machine uses which account, and how much weekly quota went unused.

No dependencies. Node.js 18+.

```bash
npx team-ai-quota login "https://your-quota-host/?key=YOUR_KEY"   # once; same link you open in the browser
npx team-ai-quota best                                             # which account to use now
```

Or install it: `npm i -g team-ai-quota`, then use `taq`.

## Log in once

Open your dashboard link in the browser (it ends with `?key=...`) and give that same link to the CLI:

```bash
taq login "https://your-quota-host/?key=YOUR_KEY"
# or explicitly
taq login --url https://your-quota-host --key YOUR_KEY
```

The URL and key are saved in `~/.config/team-ai-quota/config.json` (file mode 600). The key is never printed.
Works the same for Cloudflare Worker, Docker or Kubernetes deployments: the URL is wherever you host the server.

Where the CLI looks for the URL and key, first match wins:

1. `--url` / `--key`
2. `TAQ_URL` / `TAQ_KEY`
3. `~/.config/team-ai-quota/config.json` (written by `taq login`)
4. what the reporter already has on this machine: `CLAUDE_QUOTA_WORKER_URL`, `~/.config/ai-quota/config.json` (`worker_url`), `~/.claude/claude-quota-secret-key.txt`

## Commands

| Command | What it does |
| --- | --- |
| `taq best` | The account to use now, with the next best ones. Exit code 3 when none is eligible. |
| `taq best --email` | Only the email address (handy in scripts). |
| `taq status` | Every account: state, 5h and 7d usage, resets, unused-at-reset warning. |
| `taq machines` | Which machine is using which account right now. |
| `taq waste` | Closed weekly periods per account: average used and unused. |
| `taq health` | Is the server reachable. |
| `taq login <link>` | Save the dashboard link (URL + key). |
| `taq config` | Show the saved URL; the key is only shown as "set". |

Options: `--provider claude|agy|codex|gemini|copilot|cursor` (default `claude`), `--priority-mode 7d_first|5h_first|monthly_first` (best only), `--json` for the raw server response, `--url`, `--key`.

```text
$ taq best
Use: alice@acme.dev
  5h used 12%, 7d used 31%, free now 88%, state ACTIVE
Next: bob@acme.dev (44% 7d, 20% 5h)
```

## Use it from an AI agent

Install the agent skill so Claude Code, Codex, Cursor and others know when and how to call it:

```bash
npx skills add braitoli/team-ai-quota
```

See [`skills/team-ai-quota/SKILL.md`](../skills/team-ai-quota/SKILL.md). The CLI calls the same read-only endpoints as the dashboard
(`/route`, `/status`, `/health`), so it needs no extra server setup.

## License

MIT
