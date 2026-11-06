#!/usr/bin/env python3
"""
Quota Monitor - Codex (OpenAI Codex CLI) client. Python 3.8+, standard library only.

Asks the Codex CLI itself for its quota: it starts `codex app-server` (JSON-RPC over stdio, 0 tokens) and calls
`account/read` (account email + plan) and `account/rateLimits/read` (the 5-hour window and the weekly window:
used percent + reset time). The numbers are sent as provider="codex" to the same Worker as report_quota.py.
Sending, lock, machine id and the neutral work dir are shared with report_quota.py (imported).
Runs only on machines where codex is installed (nothing is sent otherwise) and refreshes itself from a verified
commit on main like report_quota.py does (same switches: CLAUDE_QUOTA_NO_UPDATE=1 or a no_update marker file).

Codex's login credentials are never read, printed, stored or sent: the app server owns authentication, and the
only account data used is the email it reports. Numbers are never invented: an unreadable answer produces an
error report.
"""

import os
import sys
import re
import json
import time
import queue
import random
import shutil
import threading
import subprocess
import glob
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import report_quota as rq  # noqa: E402

CODEX_CLIENT_VERSION = "codex-1.0"
CODEX_UPDATE_PATH = "client/report_codex.py"
CODEX_UPDATE_STATE = "update_state_codex.json"
CODEX_TIMEOUT_SEC = 60
CODEX_MAX_JITTER_SEC = 60
CODEX_LOCK = "codex.lock"
CODEX_PROBE_TIMEOUT_SEC = 10
CODEX_PROBE_BUDGET_SEC = 20
FIVE_HOUR_MAX_MIN = 720     # a window up to 12 h is the "5h" session window (Codex reports 300)
WEEKLY_MIN_MIN = 7200       # a window from 5 days up is the weekly window (Codex reports 10080)


# ---------------------------------------------------------------------------
# Finding codex
# ---------------------------------------------------------------------------

def get_codex_cache_path():
    return os.path.join(rq.get_monitor_dir(), "codex_bin.json")


def _install_dirs():
    """The usual places a codex (and the node it runs on) lives, for schedulers that give a minimal PATH."""
    home = os.path.expanduser("~")
    dirs = [
        os.path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
        os.path.join(home, ".npm-global", "bin"), os.path.join(home, ".bun", "bin"), os.path.join(home, ".volta", "bin"),
        os.path.join(home, ".codex", "bin"),
    ]
    dirs += glob.glob(os.path.join(home, ".nvm", "versions", "node", "*", "bin"))
    dirs += glob.glob(os.path.join(home, ".local", "node*", "bin"))
    return dirs


def extend_path(codex_bin=None):
    """npm's codex is a `#!/usr/bin/env node` script, and launchd/cron/Task Scheduler do not have node on PATH
    (exit 127 "env: node: No such file or directory"). Append the codex file's own dir and the usual install
    dirs so node is found beside it; nothing is removed or reordered."""
    have = [d for d in os.environ.get("PATH", "").split(os.pathsep) if d]
    extra = ([os.path.dirname(os.path.abspath(codex_bin))] if codex_bin else []) + _install_dirs()
    add = []
    for d in extra:
        if os.path.isdir(d) and d not in have and d not in add:
            add.append(d)
    if add:
        os.environ["PATH"] = os.pathsep.join(have + add)


def codex_candidates():
    """Every existing codex file, PATH first, then the usual install dirs (cron/launchd/Task Scheduler give a
    minimal PATH)."""
    dirs = [d.strip('"') for d in os.environ.get("PATH", "").split(os.pathsep) if d.strip('"')]
    dirs += _install_dirs()
    names = ["codex"]
    if os.name == "nt":
        names = ["codex.exe", "codex.cmd", "codex"]
        for var in ("APPDATA", "LOCALAPPDATA"):
            base = os.environ.get(var)
            if base:
                dirs += [os.path.join(base, "npm"), os.path.join(base, "Programs", "codex"), os.path.join(base, "codex")]
    found = [shutil.which("codex")] + [os.path.join(d, n) for d in dirs for n in names]
    out, seen = [], set()
    for path in found:
        if not path or not os.path.isfile(path):
            continue
        key = os.path.normcase(os.path.abspath(path))
        if key not in seen:
            seen.add(key)
            out.append(path)
    return out


def find_codex():
    """Path of a codex binary that runs (`--version`), remembered between runs. When none answers the first one
    found is still returned: an installed but broken Codex must keep reporting codex_failed, not look uninstalled."""
    extend_path()
    override = os.environ.get("CODEX_QUOTA_CODEX_BIN")
    if override and os.path.isfile(override):
        return override
    cache_path = get_codex_cache_path()
    cached = rq._load_json_file(cache_path).get("path")
    if isinstance(cached, str) and os.path.isfile(cached) and os.path.getsize(cached) > 0:
        return cached
    candidates = codex_candidates()
    if not candidates:
        return None
    deadline = time.monotonic() + CODEX_PROBE_BUDGET_SEC
    for path in candidates:
        left = deadline - time.monotonic()
        if left < 1:
            break
        reason = rq._probe_claude(path, min(CODEX_PROBE_TIMEOUT_SEC, left))  # generic `path --version` probe
        if reason is None:
            rq._save_json_file(cache_path, {"path": path, "verified_at": time.time()}, "codex path")
            return path
        print(f"  diag: codex at {path} does not run: {reason}")
    return candidates[0]


def get_codex_state_path():
    return os.path.join(rq.get_monitor_dir(), "codex_state.json")


def remember_email(email):
    rq._save_json_file(get_codex_state_path(), {"email": email, "verified_at": time.time()}, "codex state")


def recent_email():
    """The email of the last successful run, only while fresh: used so a broken Codex (no email readable) is
    still reported instead of going silent. For error reports only, never for numbers."""
    state = rq._load_json_file(get_codex_state_path())
    at = state.get("verified_at")
    if isinstance(at, (int, float)) and 0 <= time.time() - at < rq.EMAIL_TRUST_SEC and isinstance(state.get("email"), str):
        return state["email"]
    return None


def forget_codex_path():
    try:
        os.remove(get_codex_cache_path())
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Asking the app server
# ---------------------------------------------------------------------------

class _Closed(Exception):
    pass


class _Timeout(Exception):
    pass


def fetch_codex_state(codex_bin):
    """-> (email, rate_limits_result, failure). failure is (kind, message, token_state) or None; email is None when
    it could not be read. Runs `codex app-server`, which is always killed before returning."""
    extend_path(codex_bin)
    try:
        proc = subprocess.Popen([codex_bin, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                                cwd=rq.get_work_dir())
    except Exception as e:  # e.g. [WinError 216] when the exe cannot run on this Windows
        return None, None, ("codex_failed", f"could not run codex: {e}"[:300], None)
    lines = queue.Queue()
    last_text = [""]

    def pump():
        try:
            for line in proc.stdout:
                lines.put(line)
        except Exception:
            pass
        lines.put(None)
    threading.Thread(target=pump, daemon=True).start()
    deadline = time.monotonic() + CODEX_TIMEOUT_SEC

    def send(obj):
        try:
            proc.stdin.write(json.dumps(obj) + "\n")
            proc.stdin.flush()
        except Exception:
            pass  # the process is gone: the reader sees the end of output next

    def call(req_id, method, params=None):
        """-> (result, error_message). Raises _Timeout or _Closed."""
        msg = {"id": req_id, "method": method}
        if params is not None:
            msg["params"] = params
        send(msg)
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise _Timeout()
            try:
                line = lines.get(timeout=left)
            except queue.Empty:
                raise _Timeout()
            if line is None:
                raise _Closed()
            try:
                data = json.loads(line)
            except Exception:
                last_text[0] = " ".join(line.split())[:150] or last_text[0]
                continue
            if isinstance(data, dict) and data.get("id") == req_id and "method" not in data:
                err = data.get("error")
                if err:
                    return None, str((err.get("message") if isinstance(err, dict) else err) or "error")[:200]
                return data.get("result"), None

    try:
        _, err = call(1, "initialize", {"clientInfo": {"name": "claude-quota-monitor", "version": CODEX_CLIENT_VERSION}})
        if err:
            return None, None, ("codex_failed", f"codex app-server refused to start: {err}", None)
        send({"method": "initialized"})
        account_res, err = call(2, "account/read", {"refreshToken": False})
        if err:
            return None, None, ("usage_error", f"codex account/read failed: {err}", None)
        account = account_res.get("account") if isinstance(account_res, dict) else None
        if not isinstance(account, dict):
            return None, None, ("auth_required", "Codex is not logged in on this machine.", "auth_required")
        email = account.get("email")
        email = email.strip().lower() if isinstance(email, str) and "@" in email else None
        result, err = call(3, "account/rateLimits/read")
        if err:
            if rq.AUTH_FAILURE_RE.search(err):
                return email, None, ("auth_required", f"Codex is not logged in: {err}", "auth_required")
            return email, None, ("usage_error", f"codex rate limits unavailable: {err}", None)
        return email, result, None
    except _Timeout:
        return None, None, ("usage_timeout", f"codex app-server did not answer within {CODEX_TIMEOUT_SEC}s.", None)
    except _Closed:
        try:
            code = proc.wait(timeout=5)
        except Exception:
            code = "?"
        detail = f": {last_text[0]}" if last_text[0] else ""
        return None, None, ("codex_failed", f"codex app-server exited (exit {code}) before answering{detail}", None)
    finally:
        for closer in (proc.stdin.close, proc.kill):
            try:
                closer()
            except Exception:
                pass
        try:
            proc.wait(timeout=5)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Parsing + payload
# ---------------------------------------------------------------------------

def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and value == value else None


def _window(raw, now):
    """-> (kind, percent, resets_at_iso) for one rate-limit window, kind "5h" or "weekly"; None when unusable.
    A window that already reset means no active window: 0% and no reset time."""
    if not isinstance(raw, dict):
        return None
    used, mins = _number(raw.get("usedPercent")), _number(raw.get("windowDurationMins"))
    if used is None or mins is None:
        return None
    kind = "5h" if mins <= FIVE_HOUR_MAX_MIN else "weekly" if mins >= WEEKLY_MIN_MIN else None
    if kind is None:
        return None
    percent = round(max(0.0, min(100.0, float(used))), 1)
    resets = _number(raw.get("resetsAt"))
    resets_at = None
    if resets is not None:
        reset_dt = datetime.fromtimestamp(resets, tz=timezone.utc)
        if reset_dt <= now:
            return kind, 0.0, None
        resets_at = reset_dt.isoformat()
    return kind, percent, resets_at


def parse_codex_limits(result, now=None):
    """-> (session, weekly, reason). session {used_percent, resets_at}; weekly {percent, resets_at} or None.
    Windows are told apart by their duration, not by primary/secondary. reason explains a missing session."""
    now = now or datetime.now(timezone.utc)
    snap = result.get("rateLimits") if isinstance(result, dict) else None
    if not isinstance(snap, dict):
        by_id = result.get("rateLimitsByLimitId") if isinstance(result, dict) else None
        snap = by_id.get("codex") if isinstance(by_id, dict) else None
    if not isinstance(snap, dict):
        return None, None, "no rate limit snapshot in the answer"
    found = {}
    for key in ("primary", "secondary"):
        w = _window(snap.get(key), now)
        if w and w[0] not in found:
            found[w[0]] = w
    if "5h" not in found:
        return None, None, "no readable 5h window in the rate limits"
    session = {"used_percent": found["5h"][1], "resets_at": found["5h"][2]}
    weekly = None
    if "weekly" in found and found["weekly"][2] is not None:
        weekly = {"percent": found["weekly"][1], "resets_at": found["weekly"][2]}
    return session, weekly, ""


def build_codex_payload(email, session, weekly, fetched_at_ms):
    payload = {
        "email": email,
        "provider": "codex",
        "used_percent": session["used_percent"],
        "resets_at": session["resets_at"],
        "limits": [],
        "fetched_at": fetched_at_ms,
        "machine_id": rq.get_machine_id(),
        **rq.machine_info(),
        "client_version": CODEX_CLIENT_VERSION,
        "token_state": "ok",
        "parse_source": "json",
        "parse_status": "ok",
        **rq.update_fields(CODEX_UPDATE_STATE),
    }
    ml = rq.get_machine_label()
    if ml:
        payload["machine_label"] = ml
    al = rq.get_account_label(email)
    if al:
        payload["account_label"] = al
    if weekly:
        payload["limits"].append({"kind": "weekly", "group": "weekly", "percent": weekly["percent"],
                                  "resets_at": weekly["resets_at"], "is_active": True, "scope_name": None})
    return payload


def send_codex_error(email, kind, message, token_state=None):
    payload = {"email": email, "provider": "codex", "error_kind": kind, "error": message[:300],
               "machine_id": rq.get_machine_id(), **rq.machine_info(), "client_version": CODEX_CLIENT_VERSION,
               **rq.update_fields(CODEX_UPDATE_STATE)}
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


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def run_once():
    codex_bin = find_codex()
    if not codex_bin:
        # Only installed CLIs are reported: a machine without Codex sends nothing (no error report, no numbers).
        print("Codex CLI (`codex`) is not installed on this machine; nothing to report for it.")
        return 0
    if "--no-jitter" not in sys.argv and not os.environ.get("CLAUDE_QUOTA_NO_JITTER"):
        time.sleep(random.uniform(0, CODEX_MAX_JITTER_SEC))

    email, result, failure = fetch_codex_state(codex_bin)
    if failure:
        kind, message, token_state = failure
        if kind == "codex_failed":
            forget_codex_path()  # the next run looks for a working codex again
        print(f"ERROR: {message}")
        email = email or recent_email()
        if email:
            send_codex_error(email, kind, message, token_state)
        else:
            print(f"Warning: codex account email unknown, skipping {kind} report.")
        return 1
    if not email:
        print("ERROR: could not determine the Codex account email (API-key login?); not reporting.")
        return 1
    print(f"✓ Codex account: {email}")
    remember_email(email)
    fetched_at_ms = int(time.time() * 1000)

    session, weekly, reason = parse_codex_limits(result)
    if session is None:
        msg = f"Could not read Codex rate limits; {reason}."
        print(f"ERROR: {msg}")
        send_codex_error(email, "parse_error", msg)
        return 1
    label = f"{session['used_percent']}% used, resets at {session['resets_at']}"
    print(f"✓ Current Codex 5-hour quota: {label}" + (f"; weekly {weekly['percent']}%" if weekly else ""))
    ok, status, body = rq.post_to_worker(build_codex_payload(email, session, weekly, fetched_at_ms))
    if not ok:
        print(f"ERROR: Worker returned HTTP {status}: {body.strip()[:300]}")
        return 1
    print(f"✓ Successfully reported to Worker: HTTP {status} - {body.strip()}")
    return 0


def reexec_after_update():
    env = dict(os.environ, CODEX_QUOTA_UPDATED="1", CODEX_QUOTA_UPDATED_FROM=CODEX_CLIENT_VERSION)
    args = [sys.executable, os.path.abspath(__file__)] + sys.argv[1:]
    if os.name == "nt":  # no real exec on Windows: run the new file and pass its exit code on
        sys.exit(subprocess.call(args, env=env))
    os.execve(sys.executable, args, env)


def report():
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Codex Quota Reporter {CODEX_CLIENT_VERSION} running...")
    if not find_codex():  # no codex here: no update check, no download, no report
        print("Codex CLI (`codex`) is not installed on this machine; nothing to report for it.")
        return 0
    lock = rq.acquire_lock(CODEX_LOCK)
    if lock is None:
        print("Another codex run is in progress; skipping.")
        return 0
    try:
        status, swapped = rq.self_update(os.path.abspath(__file__), repo_path=CODEX_UPDATE_PATH,
                                         version_var="CODEX_CLIENT_VERSION", current_version=CODEX_CLIENT_VERSION,
                                         state_name=CODEX_UPDATE_STATE, reexec_marker="CODEX_QUOTA_UPDATED")
        rq.UPDATE_INFO["status"] = status
        if status not in ("current", "skipped_recent", "disabled"):
            print(f"Self-update: {status}")
        if swapped:
            print(f"Self-update: codex client updated from {CODEX_CLIENT_VERSION}; restarting with the new version...")
            rq.release_lock(lock)  # the new process takes the lock itself
            lock = None
            try:
                reexec_after_update()
            except Exception as e:  # exec failed: keep running this (old, still working) file
                print(f"Warning: could not restart after the update: {e}")
                rq.UPDATE_INFO["status"] = "failed:exec"
                lock = rq.acquire_lock(CODEX_LOCK)
                if lock is None:
                    return 0
        return run_once()
    finally:
        rq.release_lock(lock)


if __name__ == "__main__":
    if "--detect" in sys.argv[1:]:  # used by the setup scripts: prints the codex binary path (empty when not installed)
        import contextlib
        import io
        with contextlib.redirect_stdout(io.StringIO()):  # the setup scripts read all of stdout as the path
            found = find_codex()
        print(found or "")
        sys.exit(0)
    if "--version" in sys.argv[1:]:  # used by the self-update smoke test: no side effects
        print(CODEX_CLIENT_VERSION)
        sys.exit(0)
    sys.exit(report())
