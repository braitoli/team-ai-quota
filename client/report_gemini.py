#!/usr/bin/env python3
"""
Quota Monitor - Google Gemini CLI (`gemini`) client. Python 3.8+, standard library only.

Asks the Gemini CLI for quota / rate limit information and posts the usage to the
centralized Cloudflare Worker with provider="gemini".
"""

import os
import sys
import json
import time
import shutil
import subprocess
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import report_quota as rq  # noqa: E402

GEMINI_CLIENT_VERSION = "gemini-1.0"
GEMINI_UPDATE_STATE = "update_state_gemini.json"
GEMINI_TIMEOUT_SEC = 60
GEMINI_LOCK = "gemini.lock"


def find_gemini():
    override = os.environ.get("GEMINI_BIN") or os.environ.get("GEMINI_QUOTA_BIN")
    if override and os.path.isfile(override):
        return override
    found = shutil.which("gemini")
    if found:
        return found
    home = os.path.expanduser("~")
    dirs = [
        os.path.join(home, ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        os.path.join(home, ".gemini", "bin"),
    ]
    if os.name == "nt":
        for var in ("APPDATA", "LOCALAPPDATA"):
            base = os.environ.get(var)
            if base:
                dirs += [os.path.join(base, "npm"), os.path.join(base, "Programs", "gemini")]
    for d in dirs:
        for name in (("gemini.exe", "gemini.cmd", "gemini") if os.name == "nt" else ("gemini",)):
            candidate = os.path.join(d, name)
            if os.path.isfile(candidate):
                return candidate
    return None


def read_gemini_email():
    override = os.environ.get("GEMINI_ACCOUNT_EMAIL")
    if override and "@" in override:
        return override.strip().lower()

    # Search ~/.gemini/ credentials/config files
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".gemini", "oauth_credentials.json"),
        os.path.join(home, ".gemini", "credentials.json"),
        os.path.join(home, ".gemini", "config.json"),
        os.path.join(home, ".gemini", "settings.json"),
    ]
    for p in candidates:
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    for key in ("email", "account", "user_email", "client_email", "id_token_email"):
                        val = data.get(key)
                        if isinstance(val, str) and "@" in val:
                            return val.strip().lower()
            except Exception:
                pass

    # Check agy oauth token as potential fallback if gemini was logged in via AGY
    agy_token = os.path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
    if os.path.isfile(agy_token):
        try:
            with open(agy_token, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                email = data.get("id_token_email")
                if isinstance(email, str) and "@" in email:
                    return email.strip().lower()
        except Exception:
            pass

    return None


def parse_gemini_usage(raw_data):
    """Parses Gemini quota data from dict or string.
    Returns: (session, weekly, error)
    """
    if isinstance(raw_data, str):
        try:
            data = json.loads(raw_data)
        except Exception:
            data = None
    else:
        data = raw_data

    if isinstance(data, dict):
        used = data.get("used_percent")
        if used is None and "remaining_fraction" in data:
            rem = data["remaining_fraction"]
            if isinstance(rem, (int, float)) and 0 <= rem <= 1:
                used = round((1 - rem) * 100, 1)

        resets = data.get("resets_at")
        if resets:
            resets = rq.parse_iso_datetime(resets)
            if resets:
                if resets.tzinfo is None:
                    resets = resets.replace(tzinfo=timezone.utc)
                resets = resets.astimezone(timezone.utc).isoformat()

        session = {
            "used_percent": float(used) if used is not None else 0.0,
            "resets_at": resets,
        }

        weekly = None
        w_used = data.get("weekly_used_percent")
        w_resets = data.get("weekly_resets_at")
        if w_used is not None:
            if w_resets:
                dt = rq.parse_iso_datetime(w_resets)
                if dt:
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    w_resets = dt.astimezone(timezone.utc).isoformat()
            weekly = {
                "percent": float(w_used),
                "resets_at": w_resets,
            }

        return session, weekly, ""

    return None, None, "Could not parse gemini usage output"


def fetch_gemini_state(gemini_bin):
    """Executes gemini CLI to read quota or reads GEMINI_USAGE_JSON."""
    env_json = os.environ.get("GEMINI_USAGE_JSON")
    if env_json:
        session, weekly, err = parse_gemini_usage(env_json)
        return session, weekly, (("parse_error", err, None) if err else None)

    if not gemini_bin or not os.path.isfile(gemini_bin):
        return None, None, ("gemini_missing", "gemini binary not found", None)

    try:
        proc = subprocess.run(
            [gemini_bin, "quota", "--json"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=GEMINI_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired:
        return None, None, ("usage_timeout", f"gemini quota timed out after {GEMINI_TIMEOUT_SEC}s", None)
    except Exception as e:
        return None, None, ("gemini_failed", str(e), None)

    if proc.returncode != 0:
        err_msg = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
        if "login" in err_msg.lower() or "auth" in err_msg.lower():
            return None, None, ("auth_required", err_msg, "auth_required")
        return None, None, ("gemini_failed", err_msg, None)

    session, weekly, err = parse_gemini_usage(proc.stdout)
    if err:
        return None, None, ("parse_error", err, None)
    return session, weekly, None


def build_gemini_payload(email, session, weekly, fetched_at_ms):
    payload = {
        "email": email,
        "provider": "gemini",
        "used_percent": round(session["used_percent"], 1),
        "resets_at": session["resets_at"],
        "limits": [],
        "fetched_at": fetched_at_ms,
        "machine_id": rq.get_machine_id(),
        **rq.machine_info(),
        "client_version": GEMINI_CLIENT_VERSION,
        "token_state": "ok",
        "parse_source": "json",
        "parse_status": "ok",
        **rq.update_fields(GEMINI_UPDATE_STATE),
    }
    ml = rq.get_machine_label()
    if ml:
        payload["machine_label"] = ml
    al = rq.get_account_label(email)
    if al:
        payload["account_label"] = al
    if weekly:
        payload["limits"].append({
            "kind": "weekly",
            "group": "weekly",
            "percent": weekly["percent"],
            "resets_at": weekly["resets_at"],
            "is_active": True,
            "scope_name": "gemini",
        })
    return payload


def send_gemini_error(email, kind, message, token_state=None):
    if not email:
        print(f"Warning: gemini account email unknown, skipping {kind} report: {message}")
        return
    payload = {
        "email": email,
        "provider": "gemini",
        "error_kind": kind,
        "error": message[:300],
        "machine_id": rq.get_machine_id(),
        **rq.machine_info(),
        "client_version": GEMINI_CLIENT_VERSION,
        **rq.update_fields(GEMINI_UPDATE_STATE),
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


def run_gemini_report(force=False):
    gemini_bin = find_gemini()
    if not gemini_bin and not os.environ.get("GEMINI_USAGE_JSON"):
        print("Gemini CLI (`gemini`) is not installed on this machine; nothing to report for it.")
        return False

    email = read_gemini_email()
    if not email:
        print("ERROR: could not determine the gemini account email; not reporting.")
        return False

    session, weekly, failure = fetch_gemini_state(gemini_bin)
    if failure:
        kind, msg, tstate = failure
        send_gemini_error(email, kind, msg, token_state=tstate)
        return False

    fetched_at_ms = int(time.time() * 1000)
    payload = build_gemini_payload(email, session, weekly, fetched_at_ms)
    ok, status, body = rq.post_to_worker(payload)
    if ok:
        print(f"✓ Successfully reported Gemini quota to Worker: HTTP {status}")
    else:
        print(f"ERROR: Worker returned HTTP {status} for Gemini: {body}")
    return ok


def main():
    if "--detect" in sys.argv[1:]:
        b = find_gemini()
        if b:
            print(b)
        sys.exit(0 if b else 1)
    if "--version" in sys.argv[1:]:
        print(GEMINI_CLIENT_VERSION)
        sys.exit(0)

    force = "--force" in sys.argv[1:]
    success = run_gemini_report(force=force)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
