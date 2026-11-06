#!/usr/bin/env python3
"""
Quota Monitor - Agy (Antigravity CLI) client. Python 3.8+, standard library only.

Asks the agy CLI itself (`agy -p /usage --output-format json`, 0 tokens, ~4s) for its quota and sends
ONE report per pool (provider="agy", pool="gemini"|"claude") to the same Worker as report_quota.py.
Sending, lock, machine id and the neutral work dir are shared with report_quota.py (imported).
Runs only on machines where agy is installed (nothing is sent otherwise) and refreshes itself from a verified
commit on main like report_quota.py does (same switches: CLAUDE_QUOTA_NO_UPDATE=1 or a no_update marker file).

The OAuth token file of agy is read only for its `id_token_email` field; the token is never printed,
stored or sent. Numbers are never invented: an unreadable answer produces an error report.
"""

import os
import sys
import json
import time
import random
import shutil
import subprocess
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import report_quota as rq  # noqa: E402

AGY_CLIENT_VERSION = "agy-1.1"
AGY_UPDATE_PATH = "client/report_agy.py"
AGY_UPDATE_STATE = "update_state_agy.json"
AGY_TIMEOUT_SEC = 120
AGY_MAX_JITTER_SEC = 60
AGY_LOCK = "agy.lock"
TOKEN_FILE = "~/.gemini/antigravity-cli/antigravity-oauth-token"
# agy group name (lowercased) -> pool id
GROUP_POOLS = {"gemini models": "gemini", "claude and gpt models": "claude"}
AUTH_HINT_RE = rq.AUTH_FAILURE_RE


def find_agy():
    override = os.environ.get("AGY_QUOTA_AGY_BIN")
    if override and os.path.isfile(override):
        return override
    found = shutil.which("agy")
    if found:
        return found
    home = os.path.expanduser("~")
    dirs = [
        os.path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
        os.path.join(home, ".npm-global", "bin"), os.path.join(home, ".bun", "bin"), os.path.join(home, ".volta", "bin"),
    ]
    if os.name == "nt":
        for var in ("APPDATA", "LOCALAPPDATA"):
            base = os.environ.get(var)
            if base:
                dirs += [os.path.join(base, "npm"), os.path.join(base, "Programs", "agy"), os.path.join(base, "agy")]
    for d in dirs:
        for name in (("agy.exe", "agy.cmd", "agy") if os.name == "nt" else ("agy",)):
            candidate = os.path.join(d, name)
            if os.path.isfile(candidate):
                return candidate
    return None


def _email_from_id_token(id_token):
    """Newer agy versions store only `id_token` (a JWT). Read the `email` claim from its payload locally;
    no signature check is needed because nothing is trusted beyond labelling this machine's own account."""
    try:
        import base64
        payload = id_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        email = claims.get("email")
        return email if isinstance(email, str) else None
    except Exception:
        return None


def read_agy_email():
    """Only the email (id_token_email, or the email claim of id_token) is taken from agy's token file; tokens are never read out."""
    data = rq._load_json_file(os.path.expanduser(TOKEN_FILE))
    email = data.get("id_token_email") or _email_from_id_token(data.get("id_token"))
    return email.strip().lower() if isinstance(email, str) and "@" in email else None


def _iso(value):
    dt = rq.parse_iso_datetime(value)
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _used(bucket):
    """Used percent (0..100, 1 decimal) from remaining_fraction, or None."""
    rem = bucket.get("remaining_fraction")
    if isinstance(rem, bool) or not isinstance(rem, (int, float)) or not 0 <= rem <= 1:
        return None
    return round((1 - rem) * 100, 1)


def parse_agy_usage(text):
    """-> (pools, reason). pools: [{pool, used_percent, resets_at, five_hour_disabled, weekly}], where weekly is
    {percent, resets_at} or None. Pools without a readable 5h bucket are skipped. reason explains an empty list."""
    start = text.find("{") if isinstance(text, str) else -1
    try:
        data = json.loads(text[start:]) if start >= 0 else None
    except Exception:
        data = None
    if not isinstance(data, dict):
        return [], "output is not JSON"
    if data.get("status") not in (None, "SUCCESS"):
        return [], f"agy status {str(data.get('status'))[:40]}"
    cmd = data.get("command")
    groups = ((cmd or {}).get("data") or {}).get("groups") if isinstance(cmd, dict) else None
    if not isinstance(groups, list):
        return [], "no command.data.groups in output"
    pools = []
    for g in groups:
        pool = GROUP_POOLS.get(str((g or {}).get("name", "")).strip().lower())
        buckets = [b for b in (g.get("buckets") or []) if isinstance(b, dict)] if pool else []
        by_window = {b.get("window"): b for b in buckets}
        five, week = by_window.get("5h"), by_window.get("weekly")
        if not pool or five is None:
            continue
        weekly = None
        if week is not None and _used(week) is not None:
            weekly = {"percent": _used(week), "resets_at": _iso(week.get("reset_time"))}
        if five.get("disabled"):
            # 5h does not apply: the weekly limit is hit. The 5h numbers are meaningless, so none are reported.
            pools.append({"pool": pool, "used_percent": weekly["percent"] if weekly else 100.0, "resets_at": None,
                          "five_hour_disabled": True, "weekly": weekly})
            continue
        used, resets = _used(five), _iso(five.get("reset_time"))
        if used is None:
            continue
        pools.append({"pool": pool, "used_percent": used, "resets_at": resets,
                      "five_hour_disabled": False, "weekly": weekly})
    return pools, ("" if pools else "no known pool with a readable 5h bucket")


def build_agy_payload(email, p, fetched_at_ms):
    payload = {
        "email": email,
        "provider": "agy",
        "pool": p["pool"],
        "used_percent": p["used_percent"],
        "resets_at": p["resets_at"],
        "limits": [],
        "fetched_at": fetched_at_ms,
        "machine_id": rq.get_machine_id(),
        **rq.machine_info(),
        "client_version": AGY_CLIENT_VERSION,
        "token_state": "ok",
        "parse_source": "json",
        "parse_status": "ok",
        **rq.update_fields(AGY_UPDATE_STATE),
    }
    ml = rq.get_machine_label()
    if ml:
        payload["machine_label"] = ml
    al = rq.get_account_label(email)
    if al:
        payload["account_label"] = al
    if p["weekly"]:
        payload["limits"].append({"kind": "weekly", "group": "weekly", "percent": p["weekly"]["percent"],
                                  "resets_at": p["weekly"]["resets_at"], "is_active": True, "scope_name": p["pool"]})
    if p["five_hour_disabled"]:
        payload["five_hour_disabled"] = True
    telem = rq.read_local_telemetry() if hasattr(rq, "read_local_telemetry") else None
    if telem:
        payload["telemetry"] = telem
    return payload


def send_agy_error(email, kind, message, token_state=None):
    if not email:
        print(f"Warning: agy account email unknown, skipping {kind} report: {message}")
        return
    payload = {"email": email, "provider": "agy", "error_kind": kind, "error": message[:300],
               "machine_id": rq.get_machine_id(), **rq.machine_info(), "client_version": AGY_CLIENT_VERSION,
               **rq.update_fields(AGY_UPDATE_STATE)}
    ml = rq.get_machine_label()
    if ml:
        payload["machine_label"] = ml
    al = rq.get_account_label(email)
    if al:
        payload["account_label"] = al
    if token_state:
        payload["token_state"] = token_state
        payload["status"] = "auth_required"
    ok, status, _ = rq.post_to_worker(payload)
    print(f"{'✓' if ok else 'Warning: failed'} {kind} report to Worker: HTTP {status}")


def fetch_agy_usage(agy_bin):
    """-> (text, failure). failure is (kind, message, token_state) or None. stdin is closed so agy never waits for input."""
    try:
        proc = subprocess.run([agy_bin, "-p", "/usage", "--output-format", "json"], stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=AGY_TIMEOUT_SEC, cwd=rq.get_work_dir())
    except subprocess.TimeoutExpired:
        return "", ("usage_timeout", f"agy /usage timed out after {AGY_TIMEOUT_SEC}s.", None)
    except Exception as e:
        return "", ("usage_error", f"could not run agy: {e}"[:300], None)
    out = proc.stdout or ""
    if proc.returncode != 0 or not out.strip():
        err = (proc.stderr or out).strip()[:200]
        if AUTH_HINT_RE.search(err):
            return out, ("auth_required", "agy is not logged in on this machine.", "auth_required")
        return out, ("usage_error", f"agy exited with {proc.returncode}: {err}", None)
    return out, None


def run_once():
    agy_bin = find_agy()
    email = read_agy_email()
    if not agy_bin:
        # Only installed CLIs are reported: a machine without agy sends nothing (no error report, no numbers).
        print("Antigravity CLI (`agy`) is not installed on this machine; nothing to report for it.")
        return 0
    if not email:
        print("ERROR: could not determine the agy account email (not logged in?); not reporting.")
        return 1
    if "--no-jitter" not in sys.argv and not os.environ.get("CLAUDE_QUOTA_NO_JITTER"):
        time.sleep(random.uniform(0, AGY_MAX_JITTER_SEC))
    print(f"✓ Agy account: {email}")

    text, failure = fetch_agy_usage(agy_bin)
    if failure:
        kind, message, token_state = failure
        print(f"ERROR: {message}")
        send_agy_error(email, kind, message, token_state)
        return 1
    if read_agy_email() != email:
        print("ERROR: the agy account changed while fetching usage; discarding the measurement.")
        return 1
    fetched_at_ms = int(time.time() * 1000)
    pools, reason = parse_agy_usage(text)
    if not pools:
        msg = f"Could not parse agy /usage output; {reason}."
        print(f"ERROR: {msg}")
        send_agy_error(email, "parse_error", msg)
        return 1

    failed = 0
    for p in pools:
        label = "5h disabled (weekly cap)" if p["five_hour_disabled"] else f"{p['used_percent']}% used, resets at {p['resets_at']}"
        print(f"✓ Agy {p['pool']}: {label}")
        ok, status, body = rq.post_to_worker(build_agy_payload(email, p, fetched_at_ms))
        if ok:
            print(f"✓ Reported {p['pool']}: HTTP {status}")
        else:
            failed += 1
            print(f"ERROR: Worker returned HTTP {status} for {p['pool']}: {body.strip()[:300]}")
    return 1 if failed else 0


def reexec_after_update():
    env = dict(os.environ, AGY_QUOTA_UPDATED="1", AGY_QUOTA_UPDATED_FROM=AGY_CLIENT_VERSION)
    args = [sys.executable, os.path.abspath(__file__)] + sys.argv[1:]
    if os.name == "nt":  # no real exec on Windows: run the new file and pass its exit code on
        sys.exit(subprocess.call(args, env=env))
    os.execve(sys.executable, args, env)


def report():
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Agy Quota Reporter {AGY_CLIENT_VERSION} running...")
    if not find_agy():  # no agy here: no update check, no download, no report
        print("Antigravity CLI (`agy`) is not installed on this machine; nothing to report for it.")
        return 0
    lock = rq.acquire_lock(AGY_LOCK)
    if lock is None:
        print("Another agy run is in progress; skipping.")
        return 0
    try:
        status, swapped = rq.self_update(os.path.abspath(__file__), repo_path=AGY_UPDATE_PATH,
                                         version_var="AGY_CLIENT_VERSION", current_version=AGY_CLIENT_VERSION,
                                         state_name=AGY_UPDATE_STATE, reexec_marker="AGY_QUOTA_UPDATED")
        rq.UPDATE_INFO["status"] = status
        if status not in ("current", "skipped_recent", "disabled"):
            print(f"Self-update: {status}")
        if swapped:
            print(f"Self-update: agy client updated from {AGY_CLIENT_VERSION}; restarting with the new version...")
            rq.release_lock(lock)  # the new process takes the lock itself
            lock = None
            try:
                reexec_after_update()
            except Exception as e:  # exec failed: keep running this (old, still working) file
                print(f"Warning: could not restart after the update: {e}")
                rq.UPDATE_INFO["status"] = "failed:exec"
                lock = rq.acquire_lock(AGY_LOCK)
                if lock is None:
                    return 0
        return run_once()
    finally:
        rq.release_lock(lock)


if __name__ == "__main__":
    if "--detect" in sys.argv[1:]:  # used by the setup scripts: prints the agy binary path (empty when not installed)
        print(find_agy() or "")
        sys.exit(0)
    if "--version" in sys.argv[1:]:  # used by the self-update smoke test: no side effects
        print(AGY_CLIENT_VERSION)
        sys.exit(0)
    sys.exit(report())
