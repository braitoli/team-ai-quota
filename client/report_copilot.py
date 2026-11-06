#!/usr/bin/env python3
"""
Quota Monitor - GitHub Copilot CLI (`gh`) client. Python 3.8+, standard library only.

Asks GitHub Copilot CLI / API for monthly premium requests and usage,
and posts the usage to the centralized Cloudflare Worker with provider="copilot".
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

COPILOT_CLIENT_VERSION = "copilot-1.0"
COPILOT_UPDATE_STATE = "update_state_copilot.json"
COPILOT_TIMEOUT_SEC = 60
COPILOT_LOCK = "copilot.lock"


def find_gh():
    override = os.environ.get("GH_BIN") or os.environ.get("COPILOT_GH_BIN")
    if override and os.path.isfile(override):
        return override
    found = shutil.which("gh")
    if found:
        return found
    home = os.path.expanduser("~")
    dirs = [
        os.path.join(home, ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
    ]
    if os.name == "nt":
        for var in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            base = os.environ.get(var)
            if base:
                dirs += [os.path.join(base, "GitHub CLI")]
    for d in dirs:
        for name in (("gh.exe", "gh.cmd", "gh") if os.name == "nt" else ("gh",)):
            candidate = os.path.join(d, name)
            if os.path.isfile(candidate):
                return candidate
    return None


def read_copilot_email(gh_bin=None):
    override = os.environ.get("COPILOT_ACCOUNT_EMAIL") or os.environ.get("GH_COPILOT_EMAIL")
    if override and "@" in override:
        return override.strip().lower()

    # Try gh api user
    gh = gh_bin or find_gh()
    if gh:
        try:
            res = subprocess.run(
                [gh, "api", "user"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=15,
            )
            if res.returncode == 0:
                data = json.loads(res.stdout)
                email = data.get("email")
                if email and "@" in email:
                    return email.strip().lower()
                login = data.get("login")
                if login:
                    return f"{login.strip().lower()}@users.noreply.github.com"
        except Exception:
            pass

    # Inspect ~/.config/gh/hosts.yml
    hosts_path = os.path.expanduser("~/.config/gh/hosts.yml")
    if os.path.isfile(hosts_path):
        try:
            with open(hosts_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("user:"):
                        u = line.split(":", 1)[1].strip()
                        if u:
                            return f"{u.lower()}@users.noreply.github.com"
        except Exception:
            pass

    return None


def parse_copilot_usage(raw_data):
    """Parses monthly and session usage for Copilot.
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
        if monthly_used is None and "total_requests" in data and "used_requests" in data:
            tot = data["total_requests"]
            usd = data["used_requests"]
            if tot > 0:
                monthly_used = round((usd / tot) * 100, 1)

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

        resets_at = data.get("resets_at")
        if resets_at:
            dt = rq.parse_iso_datetime(resets_at)
            if dt:
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                resets_at = dt.astimezone(timezone.utc).isoformat()
        else:
            resets_at = monthly_resets

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

    return None, None, "Could not parse copilot usage output"


def fetch_copilot_state(gh_bin):
    """Queries copilot usage via GH_USAGE_JSON or gh CLI."""
    env_json = os.environ.get("COPILOT_USAGE_JSON")
    if env_json:
        session, monthly, err = parse_copilot_usage(env_json)
        return session, monthly, (("parse_error", err, None) if err else None)

    if not gh_bin or not os.path.isfile(gh_bin):
        return None, None, ("copilot_missing", "gh binary not found", None)

    try:
        proc = subprocess.run(
            [gh_bin, "api", "copilot_internal/usage"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=COPILOT_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired:
        return None, None, ("usage_timeout", f"gh api timed out after {COPILOT_TIMEOUT_SEC}s", None)
    except Exception as e:
        return None, None, ("copilot_failed", str(e), None)

    if proc.returncode != 0:
        err_msg = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
        if "auth" in err_msg.lower() or "login" in err_msg.lower():
            return None, None, ("auth_required", err_msg, "auth_required")
        return None, None, ("copilot_failed", err_msg, None)

    session, monthly, err = parse_copilot_usage(proc.stdout)
    if err:
        return None, None, ("parse_error", err, None)
    return session, monthly, None


def build_copilot_payload(email, session, monthly, fetched_at_ms):
    payload = {
        "email": email,
        "provider": "copilot",
        "used_percent": round(session["used_percent"], 1),
        "resets_at": session["resets_at"],
        "limits": [],
        "fetched_at": fetched_at_ms,
        "machine_id": rq.get_machine_id(),
        **rq.machine_info(),
        "client_version": COPILOT_CLIENT_VERSION,
        "token_state": "ok",
        "parse_source": "json",
        "parse_status": "ok",
        **rq.update_fields(COPILOT_UPDATE_STATE),
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
            "scope_name": "copilot",
        })
    return payload


def send_copilot_error(email, kind, message, token_state=None):
    if not email:
        print(f"Warning: copilot account email unknown, skipping {kind} report: {message}")
        return
    payload = {
        "email": email,
        "provider": "copilot",
        "error_kind": kind,
        "error": message[:300],
        "machine_id": rq.get_machine_id(),
        **rq.machine_info(),
        "client_version": COPILOT_CLIENT_VERSION,
        **rq.update_fields(COPILOT_UPDATE_STATE),
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


def run_copilot_report(force=False):
    gh_bin = find_gh()
    if not gh_bin and not os.environ.get("COPILOT_USAGE_JSON"):
        print("GitHub CLI (`gh`) is not installed on this machine; nothing to report for it.")
        return False

    email = read_copilot_email(gh_bin)
    if not email:
        print("ERROR: could not determine the copilot account email; not reporting.")
        return False

    session, monthly, failure = fetch_copilot_state(gh_bin)
    if failure:
        kind, msg, tstate = failure
        send_copilot_error(email, kind, msg, token_state=tstate)
        return False

    fetched_at_ms = int(time.time() * 1000)
    payload = build_copilot_payload(email, session, monthly, fetched_at_ms)
    ok, status, body = rq.post_to_worker(payload)
    if ok:
        print(f"✓ Successfully reported Copilot quota to Worker: HTTP {status}")
    else:
        print(f"ERROR: Worker returned HTTP {status} for Copilot: {body}")
    return ok


def main():
    if "--detect" in sys.argv[1:]:
        b = find_gh()
        if b:
            print(b)
        sys.exit(0 if b else 1)
    if "--version" in sys.argv[1:]:
        print(COPILOT_CLIENT_VERSION)
        sys.exit(0)

    force = "--force" in sys.argv[1:]
    success = run_copilot_report(force=force)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
