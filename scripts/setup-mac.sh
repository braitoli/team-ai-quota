#!/usr/bin/env bash
set -e

# Claude Quota Monitor - macOS Auto Setup
# Configures background reporting of Claude Code 5-hour quota via launchd LaunchAgent.
# Runs automatically on boot/login (RunAtLoad: true) and every 15 minutes (StartInterval: 900).
# Also catches up immediately when waking up from system sleep!
# Only the CLIs installed on this machine are reported: Claude Code (`claude`), Antigravity (`agy`) and/or OpenAI Codex (`codex`).
# A missing CLI gets no LaunchAgent, and the clients themselves send nothing when their CLI is absent.

INSTALL_DIR="$HOME/.claude/quota-monitor"
SCRIPT_PATH="$INSTALL_DIR/report_quota.py"
KEY_PATH="$HOME/.claude/claude-quota-secret-key.txt"
SECRET_SRC="${CLAUDE_QUOTA_SECRET_KEY_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.secrets/quota-key.txt}"
if [ -n "${CLAUDE_QUOTA_SECRET_KEY:-}" ]; then
    SECRET_KEY="$CLAUDE_QUOTA_SECRET_KEY"
elif [ -f "$SECRET_SRC" ]; then
    SECRET_KEY="$(tr -d '[:space:]' < "$SECRET_SRC")"
elif [ -f "$KEY_PATH" ]; then
    SECRET_KEY="$(tr -d '[:space:]' < "$KEY_PATH")"
else
    echo "ERROR: no access key found. Put it in .secrets/quota-key.txt (gitignored) or export CLAUDE_QUOTA_SECRET_KEY. See docs/LOCAL_SECRETS.md" >&2
    exit 1
fi

echo "=== [1/4] Preparing directories ==="
mkdir -p "$INSTALL_DIR"
mkdir -p "$HOME/.claude"

# Save Secret Key
echo "$SECRET_KEY" > "$KEY_PATH"
chmod 600 "$KEY_PATH"
echo "✓ Secret key saved to: $KEY_PATH"

echo "=== [2/4] Installing Python reporter script ==="
# Check if source exists locally in repo or create from embedded
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
LOCAL_SOURCE="$CURRENT_DIR/../client/report_quota.py"

if [ -f "$LOCAL_SOURCE" ]; then
    cp "$LOCAL_SOURCE" "$SCRIPT_PATH"
else
  echo "ERROR: client/report_quota.py not found next to this script. Run this script from inside a clone of the repo." >&2
  exit 1
fi

chmod +x "$SCRIPT_PATH"
# Optional Agy (Antigravity CLI) reporter: imports report_quota.py, so both live in the same folder.
AGY_SCRIPT_PATH="$INSTALL_DIR/report_agy.py"
cp "$CURRENT_DIR/../client/report_agy.py" "$AGY_SCRIPT_PATH"
chmod +x "$AGY_SCRIPT_PATH"
# Optional Codex reporter (OpenAI Codex CLI): also imports report_quota.py.
CODEX_SCRIPT_PATH="$INSTALL_DIR/report_codex.py"
cp "$CURRENT_DIR/../client/report_codex.py" "$CODEX_SCRIPT_PATH"
chmod +x "$CODEX_SCRIPT_PATH"
# v3 asks Claude Code itself for the quota and keeps no token: remove the cache older versions left behind.
rm -f "$INSTALL_DIR/.token_cache.json"
echo "✓ Reporter script installed at: $SCRIPT_PATH"

echo "=== [3/4] Detecting installed CLIs and running test execution ==="
PYTHON_BIN="$(which python3 || echo '/usr/bin/python3')"
# The clients use the same search paths as at run time (launchd has a minimal PATH), so detection matches what will run.
CLAUDE_BIN="$("$PYTHON_BIN" "$SCRIPT_PATH" --detect 2>/dev/null || true)"
AGY_BIN="$("$PYTHON_BIN" "$AGY_SCRIPT_PATH" --detect 2>/dev/null || true)"
CODEX_BIN="$("$PYTHON_BIN" "$CODEX_SCRIPT_PATH" --detect 2>/dev/null || true)"
echo "  claude: ${CLAUDE_BIN:-not installed}"
echo "  agy:    ${AGY_BIN:-not installed}"
echo "  codex:  ${CODEX_BIN:-not installed}"
if [ -z "$CLAUDE_BIN" ] && [ -z "$AGY_BIN" ] && [ -z "$CODEX_BIN" ]; then
  echo "None of 'claude' (Claude Code), 'agy' (Antigravity CLI) or 'codex' (Codex CLI) was found, so no reporting job was installed." >&2
  echo "Install and log in to at least one of them, then re-run this script." >&2
  exit 0
fi
if [ -n "$CLAUDE_BIN" ]; then
  "$PYTHON_BIN" "$SCRIPT_PATH" --no-jitter
  echo "✓ Claude test run completed successfully!"
fi
if [ -n "$AGY_BIN" ]; then
  if "$PYTHON_BIN" "$AGY_SCRIPT_PATH" --no-jitter; then
    echo "✓ Agy test run completed successfully!"
  else
    echo "! Agy test run failed (not logged in?). Continuing: the Agy reporter retries on schedule."
  fi
fi
if [ -n "$CODEX_BIN" ]; then
  if "$PYTHON_BIN" "$CODEX_SCRIPT_PATH" --no-jitter; then
    echo "✓ Codex test run completed successfully!"
  else
    echo "! Codex test run failed (not logged in?). Continuing: the Codex reporter retries on schedule."
  fi
fi

echo "=== [4/4] Setting up launchd LaunchAgent (runs on boot & adaptive interval 2-15m) ==="
# Remove legacy crontab entry if exists
CURRENT_CRON=$(crontab -l 2>/dev/null || true)
if echo "$CURRENT_CRON" | grep -q "report_quota.py"; then
    echo "Cleaning up legacy crontab entry..."
    NEW_CRON=$(echo "$CURRENT_CRON" | grep -v "report_quota.py")
    if [ -n "$NEW_CRON" ]; then
        echo "$NEW_CRON" | crontab -
    else
        crontab -r 2>/dev/null || true
    fi
fi

PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/com.yourteam.claude-quota-monitor.plist"
mkdir -p "$PLIST_DIR"
USER_ID=$(id -u)

if [ -n "$CLAUDE_BIN" ]; then
cat << EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yourteam.claude-quota-monitor</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON_BIN</string>
        <string>$SCRIPT_PATH</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>120</integer>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/quota.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/quota.log</string>
</dict>
</plist>
EOF

chmod 644 "$PLIST_PATH"

launchctl bootout "gui/$USER_ID" "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "gui/$USER_ID" "$PLIST_PATH"
echo "✓ Claude LaunchAgent installed (com.yourteam.claude-quota-monitor, log: $INSTALL_DIR/quota.log)"
else
echo "Note: the 'claude' command was not found; skipping the Claude quota reporter."
fi

# Agy quota reporter (provider "agy"): only when the agy CLI is installed. No ProcessType key on purpose.
# Fires at minutes 7/22/37/52 (the Claude job runs at 0/15/30/45) so the two heavy /usage scans do not start together.
if [ -n "$AGY_BIN" ]; then
AGY_PLIST_PATH="$PLIST_DIR/com.yourteam.agy-quota-monitor.plist"
cat << EOF > "$AGY_PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yourteam.agy-quota-monitor</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON_BIN</string>
        <string>$AGY_SCRIPT_PATH</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartCalendarInterval</key>
    <array>
        <dict><key>Minute</key><integer>7</integer></dict>
        <dict><key>Minute</key><integer>22</integer></dict>
        <dict><key>Minute</key><integer>37</integer></dict>
        <dict><key>Minute</key><integer>52</integer></dict>
    </array>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/agy-quota.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/agy-quota.log</string>
</dict>
</plist>
EOF
chmod 644 "$AGY_PLIST_PATH"
launchctl bootout "gui/$USER_ID" "$AGY_PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "gui/$USER_ID" "$AGY_PLIST_PATH"
echo "✓ Agy LaunchAgent installed (com.yourteam.agy-quota-monitor, log: $INSTALL_DIR/agy-quota.log)"
else
echo "Note: the 'agy' command was not found; skipping the Agy quota reporter."
fi

# Codex quota reporter (provider "codex"): only when the codex CLI is installed.
# Fires at minutes 3/18/33/48 (Claude 0/15/30/45, Agy 7/22/37/52) so the CLI scans do not start together.
if [ -n "$CODEX_BIN" ]; then
CODEX_PLIST_PATH="$PLIST_DIR/com.yourteam.codex-quota-monitor.plist"
cat << EOF > "$CODEX_PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yourteam.codex-quota-monitor</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON_BIN</string>
        <string>$CODEX_SCRIPT_PATH</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartCalendarInterval</key>
    <array>
        <dict><key>Minute</key><integer>3</integer></dict>
        <dict><key>Minute</key><integer>18</integer></dict>
        <dict><key>Minute</key><integer>33</integer></dict>
        <dict><key>Minute</key><integer>48</integer></dict>
    </array>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/codex-quota.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/codex-quota.log</string>
</dict>
</plist>
EOF
chmod 644 "$CODEX_PLIST_PATH"
launchctl bootout "gui/$USER_ID" "$CODEX_PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "gui/$USER_ID" "$CODEX_PLIST_PATH"
echo "✓ Codex LaunchAgent installed (com.yourteam.codex-quota-monitor, log: $INSTALL_DIR/codex-quota.log)"
else
echo "Note: the 'codex' command was not found; skipping the Codex quota reporter."
fi

echo "=========================================================="
echo "🎉 Quota Monitor installed successfully on macOS!"
[ -n "$CLAUDE_BIN" ] && echo "Claude: LaunchAgent com.yourteam.claude-quota-monitor (RunAtLoad + every 15 minutes), logs: tail -f $INSTALL_DIR/quota.log"
[ -n "$AGY_BIN" ] && echo "Agy:    LaunchAgent com.yourteam.agy-quota-monitor (RunAtLoad + minutes 7/22/37/52), logs: tail -f $INSTALL_DIR/agy-quota.log"
[ -n "$CODEX_BIN" ] && echo "Codex:  LaunchAgent com.yourteam.codex-quota-monitor (RunAtLoad + minutes 3/18/33/48), logs: tail -f $INSTALL_DIR/codex-quota.log"
true
echo "=========================================================="
