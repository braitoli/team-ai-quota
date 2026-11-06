#!/usr/bin/env python3
"""
Quota Monitor - Cursor Agent CLI (`cursor`) client. Python 3.8+, standard library only.

Reads Cursor fast requests quota and monthly resets from Cursor CLI or local SQLite state,
and posts the usage to the centralized Cloudflare Worker with provider="cursor".
"""

import os
import sys
import json
import time
import shutil
import sqlite3
import subprocess
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import report_quota as rq  # noqa: E402

CURSOR_CLIENT_VERSION = "cursor-1.0"
CURSOR_UPDATE_STATE = "update_state_cursor.json"
CURSOR_TIMEOUT_SEC = 60
CURSOR_LOCK = "cursor.lock"


def find_cursor():
    override = os.environ.get("CURSOR_BIN")
    if override and os.path.isfile(override):
        return override
    found = shutil.which("cursor")
    if found:
        return found
    home = os.path.expanduser("~")
    dirs = [
        os.path.join(home, ".local", "bin"),
        "/usr/local/bin",
        "/usr/bin",
        "/Applications/Cursor.app/Contents/Resources/app/bin",
    ]
    if os.name == "nt":
        for var in ("LOCALAPPDATA", "ProgramFiles"):
            base = os.environ.get(var)
            if base:
                dirs += [os.path.join(base, "Programs", "cursor", "bin"), os.path.join(base, "Cursor", "bin")]
    for d in dirs:
        for name in (("cursor.cmd", "cursor.exe", "cursor") if os.name == "nt" else ("cursor",)):
            candidate = os.path.join(d, name)
            if os.path.isfile(candidate):
                return candidate
    return None


def find_cursor_state_db():
    override = os.environ.get("CURSOR_STATE_PATH")
    if override and os.path.isfile(override):
        return override
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
        os.path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    ]
    if os.name == "nt":
        appdata = os.environ.get("APPDATA")
        if appdata:
            candidates.append(os.path.join(appdata, "Cursor", "User", "globalStorage", "state.vscdb"))
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


def read_cursor_email():
    override = os.environ.get("CURSOR_ACCOUNT_EMAIL")
    if override and "@" in override:
        return override.strip().lower()

    db_path = find_cursor_state_db()
    if db_path and os.path.isfile(db_path):
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            cursor = conn.cursor()
            cursor.execute(
                "SELECT value FROM ItemTable WHERE key IN ('cursorAuth/cachedEmail', 'cursorAuth/stripeEmail') LIMIT 1"
            )
            row = cursor.fetchone()
            conn.close()
            if row and row[0]:
                val = str(row[0]).strip().strip('"').strip("'")
                if "@" in val:
                    return val.lower()
        except Exception:
            pass

    return None


def parse_cursor_usage(raw_data):
    """Parses monthly fast requests usage for Cursor.
    Returns: (session, monthly, error)
    """
    if isinstance(raw_data, str):
        try:
            data = json.loads(raw_data)
        except Exception:
            data = None
    else:
        data = raw_data

    if isinstance(data, dict):
        monthly_used = data.get("monthly_used_percent")
        if monthly_used is None and "used_percent" in data:
            monthly_used = data["used_percent"]
        if monthly_used is None and "fast_requests_limit" in data and "fast_requests_used" in data:
            lim = data["fast_requests_limit"]
            usd = data["fast_requests_used"]
            if lim > 0:
                monthly_used = round((usd / lim) * 100, 1)

        monthly_resets = data.get("monthly_resets_at") or data.get("resets_at")
        if monthly_resets:
            dt = rq.parse_iso_datetime(monthly_resets)
            if dt:
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                monthly_resets = dt.astimezone(timezone.utc).isoformat()

        used_percent = data.get("used_percent")
        if used_percent is None:
            used_percent = monthly_used if monthly_used is not None else 0.0

        resets_at = data.get("resets_at") or monthly_resets
        if resets_at:
            dt = rq.parse_iso_datetime(resets_at)
            if dt:
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                resets_at = dt.astimezone(timezone.utc).isoformat()

        session = {
            "used_percent": float(used_percent),
            "resets_at": resets_at,
        }

        monthly = None
        if monthly_used is not None:
            monthly = {
                "percent": float(monthly_used),
                "resets_at": monthly_resets,
            }

        return session, monthly, ""

    return None, None, "Could not parse cursor usage output"


def fetch_cursor_state(cursor_bin):
    """Fetches cursor usage from CURSOR_USAGE_JSON or cursor state."""
    env_json = os.environ.get("CURSOR_USAGE_JSON")
    if env_json:
        session, monthly, err = parse_cursor_usage(env_json)
        return session, monthly, (("parse_error", err, None) if err else None)

    db_path = find_cursor_state_db()
    if db_path and os.path.isfile(db_path):
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            cursor = conn.cursor()
            cursor.execute(
                "SELECT value FROM ItemTable WHERE key = 'cursorAuth/usage' LIMIT 1"
            )
            row = cursor.fetchone()
            conn.close()
            if row and row[0]:
                session, monthly, err = parse_cursor_usage(row[0])
                if not err:
                    return session, monthly, None
        except Exception:
            pass

    if cursor_bin and os.path.isfile(cursor_bin):
        try:
            proc = subprocess.run(
                [cursor_bin, "status", "--json"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=CURSOR_TIMEOUT_SEC,
            )
            if proc.returncode == 0:
                session, monthly, err = parse_cursor_usage(proc.stdout)
                if not err:
                    return session, monthly, None
        except Exception:
            pass

    return None, None, ("cursor_missing", "Could not locate cursor usage data", None)


def build_cursor_payload(email, session, monthly, fetched_at_ms):
    payload = {
        "email": email,
        "provider": "cursor",
        "used_percent": round(session["used_percent"], 1),
        "resets_at": session["resets_at"],
        "limits": [],
        "fetched_at": fetched_at_ms,
        "machine_id": rq.get_machine_id(),
        **rq.machine_info(),
        "client_version": CURSOR_CLIENT_VERSION,
        "token_state": "ok",
        "parse_source": "json",
        "parse_status": "ok",
        **rq.update_fields(CURSOR_UPDATE_STATE),
    }
    ml = rq.get_machine_label()
    if ml:
        payload["machine_label"] = ml
    al = rq.get_account_label(email)
    if al:
        payload["account_label"] = al
    if monthly:
        payload["monthly_used_percent"] = round(monthly["percent"], 1)
        payload["monthly_resets_at"] = monthly["resets_at"]
        payload["limits"].append({
            "kind": "monthly",
            "group": "monthly",
            "percent": monthly["percent"],
            "resets_at": monthly["resets_at"],
            "is_active": True,
            "scope_name": "cursor",
        })
    return payload


def send_cursor_error(email, kind, message, token_state=None):
    if not email:
        print(f"Warning: cursor account email unknown, skipping {kind} report: {message}")
        return
    payload = {
        "email": email,
        "provider": "cursor",
        "error_kind": kind,
        "error": message[:300],
        "machine_id": rq.get_machine_id(),
        **rq.machine_info(),
        "client_version": CURSOR_CLIENT_VERSION,
        **rq.update_fields(CURSOR_UPDATE_STATE),
    }
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


def run_cursor_report(force=False):
    cursor_bin = find_cursor()
    state_db = find_cursor_state_db()
    if not cursor_bin and not state_db and not os.environ.get("CURSOR_USAGE_JSON"):
        print("Cursor CLI / state is not found on this machine; nothing to report for it.")
        return False

    email = read_cursor_email()
    if not email:
        print("ERROR: could not determine the cursor account email; not reporting.")
        return False

    session, monthly, failure = fetch_cursor_state(cursor_bin)
    if failure:
        kind, msg, tstate = failure
        send_cursor_error(email, kind, msg, token_state=tstate)
        return False

    fetched_at_ms = int(time.time() * 1000)
    payload = build_cursor_payload(email, session, monthly, fetched_at_ms)
    ok, status, body = rq.post_to_worker(payload)
    if ok:
        print(f"✓ Successfully reported Cursor quota to Worker: HTTP {status}")
    else:
        print(f"ERROR: Worker returned HTTP {status} for Cursor: {body}")
    return ok


def main():
    if "--detect" in sys.argv[1:]:
        b = find_cursor() or find_cursor_state_db()
        if b:
            print(b)
        sys.exit(0 if b else 1)
    if "--version" in sys.argv[1:]:
        print(CURSOR_CLIENT_VERSION)
        sys.exit(0)

    force = "--force" in sys.argv[1:]
    success = run_cursor_report(force=force)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
