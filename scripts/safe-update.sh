#!/usr/bin/env bash
# Safe client update for macOS / Linux: backup -> preflight -> install -> verify end-to-end -> rollback on failure.
# Usage (from a fresh `git pull` of this repo):
#   scripts/safe-update.sh              update this machine
#   scripts/safe-update.sh --rollback   restore the newest backup
# Backups: ~/.claude/quota-monitor-backups/<timestamp> (the 5 newest are kept).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="$HOME/.claude/quota-monitor"
KEY_PATH="$HOME/.claude/claude-quota-secret-key.txt"
BACKUP_ROOT="$HOME/.claude/quota-monitor-backups"
PLIST_DIR="$HOME/Library/LaunchAgents"
OS="$(uname -s)"
PY="$(command -v python3 || echo /usr/bin/python3)"
PLACEHOLDER='your-worker|your-org|example\.com'

say()  { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; }

reload_agents() { # macOS: (re)load every quota-monitor LaunchAgent found in PLIST_DIR
  [ "$OS" = "Darwin" ] || return 0
  local p uid; uid="$(id -u)"
  for p in "$PLIST_DIR"/com.*quota-monitor*.plist; do
    [ -f "$p" ] || continue
    launchctl bootout "gui/$uid" "$p" 2>/dev/null || true
    launchctl bootstrap "gui/$uid" "$p" 2>/dev/null || true
  done
}

restore() { # restore() <backup dir>
  local bk="$1"
  [ -d "$bk/quota-monitor" ] || { fail "backup $bk is incomplete"; return 1; }
  # drop files the failed install added, then put the old ones back
  find "$INSTALL_DIR" -maxdepth 1 -type f \( -name '*.py' -o -name '*.json' \) -delete 2>/dev/null || true
  cp -p "$bk"/quota-monitor/* "$INSTALL_DIR"/ 2>/dev/null || true
  [ -f "$bk/secret-key.txt" ] && cp -p "$bk/secret-key.txt" "$KEY_PATH"
  [ -f "$bk/ai-quota-config.json" ] && cp -p "$bk/ai-quota-config.json" "$HOME/.ai-quota/config.json" 2>/dev/null || true
  if [ "$OS" = "Darwin" ]; then
    rm -f "$PLIST_DIR"/com.*quota-monitor*.plist
    cp -p "$bk"/plists/*.plist "$PLIST_DIR"/ 2>/dev/null || true
    reload_agents
  elif [ -f "$bk/crontab.txt" ]; then
    crontab "$bk/crontab.txt"
  fi
  say "Restored the previous client from $bk"
}

effective_url() { # effective_url <client dir>: the worker URL that client would use
  "$PY" - "$1" <<'PYEOF'
import sys, os
sys.path.insert(0, sys.argv[1]); sys.argv = sys.argv[:1]
import report_quota
print(report_quota.get_worker_url())
PYEOF
}

if [ "${1:-}" = "--rollback" ]; then
  LATEST="$(ls -1d "$BACKUP_ROOT"/*/ 2>/dev/null | sort | tail -1)"
  [ -n "$LATEST" ] || { fail "no backup found in $BACKUP_ROOT"; exit 1; }
  restore "${LATEST%/}"; exit $?
fi

[ -f "$KEY_PATH" ] || { fail "no access key at $KEY_PATH (this machine was never set up; use scripts/setup-*.sh)"; exit 1; }
SETUP="$REPO/scripts/setup-linux.sh"; [ "$OS" = "Darwin" ] && SETUP="$REPO/scripts/setup-mac.sh"
[ -f "$SETUP" ] || { fail "run this from inside a clone of the repo ($SETUP missing)"; exit 1; }

say "=== [1/5] Preflight on the NEW code (nothing on this machine is touched yet) ==="
for f in report_quota.py report_agy.py report_codex.py; do
  "$PY" -m py_compile "$REPO/client/$f" 2>/dev/null || { fail "$f does not compile; aborting, nothing changed"; exit 1; }
done
NEW_URL="$(effective_url "$REPO/client" 2>/dev/null)" || { fail "cannot load the new client; aborting, nothing changed"; exit 1; }
if printf '%s' "$NEW_URL" | grep -Eiq "$PLACEHOLDER"; then
  fail "the new client would report to a placeholder URL ($NEW_URL). Set worker_url in ~/.ai-quota/config.json or CLAUDE_QUOTA_WORKER_URL, or fix the repo. Aborting, nothing changed"; exit 1
fi
BASE="${NEW_URL%/update}"
curl -fsS -m 15 "$BASE/health" >/dev/null || { fail "Worker $BASE/health is not reachable; aborting, nothing changed"; exit 1; }
say "  worker: $BASE (health ok)"
NEW_VER="$(grep -E '^CLIENT_VERSION' "$REPO/client/report_quota.py" | sed -E 's/.*"([^"]*)".*/\1/')"
OLD_VER="$(grep -E '^CLIENT_VERSION' "$INSTALL_DIR/report_quota.py" 2>/dev/null | sed -E 's/.*"([^"]*)".*/\1/')"
OLD_URL="$(effective_url "$INSTALL_DIR" 2>/dev/null || echo unknown)"
say "  installed: v${OLD_VER:-none} -> $OLD_URL"
say "  new:       v$NEW_VER"

say "=== [2/5] Backing up the current install ==="
BK="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK/quota-monitor" "$BK/plists"
find "$INSTALL_DIR" -maxdepth 1 -type f \( -name '*.py' -o -name '*.json' -o -name machine_id \) -exec cp -p {} "$BK/quota-monitor/" \; 2>/dev/null
cp -p "$KEY_PATH" "$BK/secret-key.txt"
[ -f "$HOME/.ai-quota/config.json" ] && cp -p "$HOME/.ai-quota/config.json" "$BK/ai-quota-config.json"
[ "$OS" = "Darwin" ] && cp -p "$PLIST_DIR"/com.*quota-monitor*.plist "$BK/plists/" 2>/dev/null
[ "$OS" != "Darwin" ] && crontab -l > "$BK/crontab.txt" 2>/dev/null
say "  backup: $BK"

say "=== [3/5] Installing the new client ==="
if ! CLAUDE_QUOTA_SECRET_KEY_FILE="$KEY_PATH" bash "$SETUP"; then
  fail "installer failed"; restore "$BK"; exit 1
fi

say "=== [4/5] Verifying end to end ==="
verify() {
  local inst_url out mid ls_ok
  inst_url="$(effective_url "$INSTALL_DIR" 2>/dev/null)" || { fail "installed client cannot be loaded"; return 1; }
  printf '%s' "$inst_url" | grep -Eiq "$PLACEHOLDER" && { fail "installed client reports to a placeholder URL: $inst_url"; return 1; }
  [ -z "${SAFE_UPDATE_FORCE_FAIL:-}" ] || { fail "forced failure (test)"; return 1; }
  # the freshly loaded LaunchAgent may hold the run lock ("Another run is in progress"): wait and retry
  local try rc=1
  for try in 1 2 3 4 5 6 7 8; do
    out="$("$PY" "$INSTALL_DIR/report_quota.py" --no-jitter 2>&1)"; rc=$?
    printf '%s' "$out" | grep -q "Another run is in progress" || break
    say "  (a scheduled run holds the lock, retry $try/8 in 15s)"; sleep 15
  done
  printf '%s\n' "$out" | tail -4 | sed 's/^/  | /'
  # "Skipping this tick" = a report was accepted moments ago; the server check below is the real proof
  if [ $rc -ne 0 ] || printf '%s' "$out" | grep -q "^ERROR"; then fail "the client reported an error"; return 1; fi
  # the Worker must now show THIS machine on the new version
  mid="$(tr -d '[:space:]' < "$INSTALL_DIR/machine_id" 2>/dev/null | cut -c1-6)"
  local n
  for n in 1 2 3 4 5 6; do
    if curl -fsS -m 20 -H "x-api-key: $(tr -d '[:space:]' < "$KEY_PATH")" "$BASE/status?provider=claude" 2>/dev/null |
    "$PY" -c '
import sys, json, time, datetime
mid, ver = sys.argv[1], sys.argv[2]
s = json.load(sys.stdin)
for m in s.get("machine_stats", []):
    if (m.get("machine_id") or "").startswith(mid):
        seen = datetime.datetime.fromisoformat(m["last_seen"].replace("Z", "+00:00")).timestamp()
        ok = time.time() - seen < 300 and str(m.get("client_version")) == ver
        print("  server sees this machine: v%s, %ds ago" % (m.get("client_version"), time.time() - seen))
        sys.exit(0 if ok else 1)
print("  this machine is not in the server snapshot"); sys.exit(1)
' "$mid" "$NEW_VER"; then return 0; fi
    sleep 10
  done
  fail "the Worker does not show this machine updated within 60s"; return 1
}
if ! verify; then
  say "=== Verification failed: rolling back ==="
  restore "$BK"
  say "Rolled back. Send the lines above to the maintainer."
  exit 1
fi

say "=== [5/5] Cleaning up ==="
# The v1.0.0 setup script installed agents named com.yourteam.*; they only get removed now that the new client is verified.
if [ "$OS" = "Darwin" ]; then
  for p in "$PLIST_DIR"/com.yourteam.*quota-monitor*.plist; do
    [ -f "$p" ] || continue
    grep -q "$(basename "$p" .plist)" "$SETUP" && continue   # this install's own label (e.g. the public repo): keep
    launchctl bootout "gui/$(id -u)" "$p" 2>/dev/null || true
    rm -f "$p"; say "  removed legacy agent $(basename "$p")"
  done
fi
ls -1d "$BACKUP_ROOT"/*/ 2>/dev/null | sort | awk '{a[NR]=$0} END{for(i=1;i<=NR-5;i++)print a[i]}' | while read -r old; do rm -rf "$old"; done
say "Updated v${OLD_VER:-none} -> v$NEW_VER and verified on the Worker. Backup kept at $BK (undo with: scripts/safe-update.sh --rollback)."
