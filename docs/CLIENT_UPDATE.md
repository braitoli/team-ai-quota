# Updating a machine's client safely

`scripts/safe-update.sh` (macOS / Linux) replaces the manual "run setup again":

1. **Preflight on the new code**: it must compile, its effective Worker URL must not be a placeholder and `/health` must answer. Otherwise nothing on the machine is touched.
2. **Backup** of `~/.claude/quota-monitor`, the key file, `~/.ai-quota/config.json` and the scheduler entries (LaunchAgents / crontab) in `~/.claude/quota-monitor-backups/<timestamp>` (5 newest kept).
3. **Install** with the normal setup script.
4. **Verify end to end**: a test report must be accepted and the Worker must show this machine on the new version.
5. **Rollback automatically** if any step fails (or by hand: `scripts/safe-update.sh --rollback`). Legacy `com.yourteam.*` agents are removed only after verification succeeded.

```bash
git pull && scripts/safe-update.sh      # or the first time: gh repo clone <owner>/<repo> && cd <repo> && scripts/safe-update.sh
```

Built-in protections (client 3.13+): the self-updater refuses a release that changes `DEFAULT_WORKER_URL` or `UPDATE_REPO` (`failed:identity_changed`), and after an update 5 failed reports in a row (HTTP 404 or no connection) restore the previous client from `report_quota.py.prev` and pause updates for 24 h (`rolled_back_auto`).
