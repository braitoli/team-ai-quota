# AI Coding Agent Instructions: Claude Quota Monitor

When the developer requests: **"Hãy đọc thư mục docs/ và setup cron job quota"** (or similar instructions regarding setting up the quota monitor cron job), execute the following steps precisely:

## Step 1: Detect Operating System
Identify the current operating system:
- On Unix/macOS/Linux: Run `uname -s`
- On Windows: Check PowerShell `$env:OS` or environment variables.

## Step 2: Execute Corresponding Setup Script
Locate and run the appropriate setup script from the `scripts/` directory:
- **macOS**: Run `scripts/setup-mac.sh`
  - *Note*: Uses **`launchd` LaunchAgent** (`~/Library/LaunchAgents/com.yourteam.claude-quota-monitor.plist`) running in the user GUI session (`gui/$(id -u)`). This lets `claude -p` run in the logged-in user's context, executes on boot/login (`RunAtLoad: true`), runs every 15 minutes (`StartInterval: 900`), and catches up immediately after waking from sleep. Do NOT use `crontab` on macOS.
- **Linux**: Run `scripts/setup-linux.sh`
  - Configures crontab with `@reboot sleep 15 && ...` (immediate boot reporting) and `*/15 * * * *` (15-minute periodic reporting).
- **Windows**: Run `scripts/setup-windows.ps1`
  - Configures two Scheduled Tasks: `ClaudeQuotaMonitorOnBoot` (`/sc onlogon`) and `ClaudeQuotaMonitor` (`/sc minute /mo 15`).

Consult `docs/setup-<os>.md` for manual instructions or troubleshooting.

## Step 3: Verification & Test Report
- Run a manual test execution of the monitor script once:
  ```bash
  python3 ~/.claude/quota-monitor/report_quota.py --no-jitter
  ```
- Verify the following features:
  * **Overload Suppression**: If quota is 100%, the script automatically sleeps until the reset time (`resets_at`), skipping the `claude` call.
  * **Auth Error Alert**: If `claude auth status` says logged out (or `/usage` reports a login problem), the script notifies the Worker with `status: "auth_required"`.
  * **No token handling (v3)**: the client runs `claude -p "/usage"` (0 tokens) and parses the text; it never reads or caches OAuth tokens. A Haiku fallback (~4k input tokens) runs only if the text cannot be parsed, and its answer is accepted only when verified against the text.
- Report the current quota status and email confirmation back to the developer.

## Step 4: Quota Check API & Dashboard Instructions
Output instructions for the user:
- **Web Dashboard Cockpit**:
  ```
  https://team-ai-quota.your-worker.workers.dev/?key=<ACCESS_KEY>
  ```
- **cURL command**:
  ```bash
  curl -s "https://team-ai-quota.your-worker.workers.dev/status?key=<ACCESS_KEY>"
  ```
