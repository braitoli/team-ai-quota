#!/usr/bin/env bash
set -e

# Claude Quota Monitor - Linux Auto Setup
# Configures 15-minute background reporting of the 5-hour quota + immediate @reboot trigger.
# Only the CLIs installed on this machine are reported: Claude Code (`claude`), Antigravity (`agy`) and/or OpenAI Codex (`codex`).
# A missing CLI gets no cron job, and the clients themselves send nothing when their CLI is absent.

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
# The clients use the same search paths as at run time (cron has a minimal PATH), so detection matches what will run.
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

echo "=== [4/4] Setting up Cron jobs (@reboot & every 15 minutes) ==="
# Rebuild this tool's cron lines from scratch (idempotent): drop old claude/agy/codex lines, add one set per installed CLI.
# The agy job runs at minutes 7/22/37/52 and the codex job at 3/18/33/48 (the Claude job at 0/15/30/45) so the CLI scans do not start together.
CURRENT_CRON=$(crontab -l 2>/dev/null || true)
NEW_CRON=$(echo "$CURRENT_CRON" | grep -v -e "report_quota.py" -e "report_agy.py" -e "report_codex.py" || true)
{
  [ -n "$NEW_CRON" ] && echo "$NEW_CRON"
  if [ -n "$CLAUDE_BIN" ]; then
    echo "@reboot sleep 15 && $PYTHON_BIN $SCRIPT_PATH >> $INSTALL_DIR/quota.log 2>&1"
    echo "*/2 * * * * $PYTHON_BIN $SCRIPT_PATH >> $INSTALL_DIR/quota.log 2>&1"
  fi
  if [ -n "$AGY_BIN" ]; then
    echo "@reboot sleep 45 && $PYTHON_BIN $AGY_SCRIPT_PATH >> $INSTALL_DIR/agy-quota.log 2>&1"
    echo "7,22,37,52 * * * * $PYTHON_BIN $AGY_SCRIPT_PATH >> $INSTALL_DIR/agy-quota.log 2>&1"
  fi
  if [ -n "$CODEX_BIN" ]; then
    echo "@reboot sleep 75 && $PYTHON_BIN $CODEX_SCRIPT_PATH >> $INSTALL_DIR/codex-quota.log 2>&1"
    echo "3,18,33,48 * * * * $PYTHON_BIN $CODEX_SCRIPT_PATH >> $INSTALL_DIR/codex-quota.log 2>&1"
  fi
} | crontab -

echo "=========================================================="
echo "🎉 Quota Monitor installed successfully on Linux!"
[ -n "$CLAUDE_BIN" ] && echo "Claude: @reboot (+15s) and */15, logs: tail -f $INSTALL_DIR/quota.log"
[ -n "$AGY_BIN" ] && echo "Agy:    @reboot (+45s) and minutes 7/22/37/52, logs: tail -f $INSTALL_DIR/agy-quota.log"
[ -n "$CODEX_BIN" ] && echo "Codex:  @reboot (+75s) and minutes 3/18/33/48, logs: tail -f $INSTALL_DIR/codex-quota.log"
true
echo "=========================================================="
