#!/usr/bin/env python3
"""
Claude Quota Monitor - Client Script (v3)
Cross-platform: macOS, Linux, Windows. Python 3.8+, standard library only.

Asks Claude Code itself for the 5-hour quota (`claude -p "/usage"`, which costs 0 tokens),
turns the text into structured JSON and sends it to the centralized Cloudflare Worker.

This script never reads Claude's OAuth token, the OS keychain or any credentials file, never
keeps a token cache and never calls the Anthropic API itself: Claude Code owns authentication and
token refresh. The only thing it reads from Claude's config is the account email
(`claude auth status`, falling back to the `oauthAccount.emailAddress` key of ~/.claude.json).

Self-update: at most every 6 h the script asks GitHub (`gh api`) for the latest client/report_quota.py on
main and replaces ONLY this file when the newest commit touching it is GitHub-verified, the file compiles and
answers `--version`. Disable with CLAUDE_QUOTA_NO_UPDATE=1 or an empty ~/.claude/quota-monitor/no_update file.

Parsing is deterministic (regex). Only when the text cannot be parsed is ONE extra cheap call
made (`claude -p --model haiku`, ~4k input tokens) and its answer is accepted only if every
number it returns appears verbatim in the text. Numbers are never invented: when nothing can be
verified an error report is sent instead of a fabricated 0%.
"""

import sys
import os
import io
import re
import json
import time
import uuid
import glob
import math
import random
import shutil
import socket
import platform
import hashlib
import contextlib
import subprocess
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
except Exception:  # Python 3.8, or no tz database (Windows without the tzdata package)
    ZoneInfo = None

# Default configuration
DEFAULT_WORKER_URL = "https://team-ai-quota.your-worker.workers.dev/update"
DEFAULT_KEY = ""  # no embedded key: set CLAUDE_QUOTA_SECRET_KEY or ~/.claude/claude-quota-secret-key.txt (docs/LOCAL_SECRETS.md)

CLIENT_VERSION = "3.13"
MIN_REPORT_INTERVAL_SEC = 2 * 60   # 120s (2 minutes, fastest burn)
MAX_REPORT_INTERVAL_SEC = 15 * 60  # 900s (15 minutes, idle / slow)
REPORT_INTERVAL_SEC = MAX_REPORT_INTERVAL_SEC  # scheduler ceiling interval
BURN_RATE_SCALE_R0 = 18.0          # %/h scale for exponential decay mapping
USAGE_TIMEOUT_SEC = 270
FALLBACK_TIMEOUT_SEC = 120
AUTH_STATUS_TIMEOUT_SEC = 30
MAX_JITTER_SEC = 30
UPDATE_REPO = "braitoli/team-ai-quota"
UPDATE_PATH = "client/report_quota.py"
UPDATE_BRANCH = "main"
UPDATE_CHECK_SEC = 30 * 60  # at most one update check per machine every 6 h
UPDATE_RETRY_SAME_SHA_SEC = 24 * 3600  # a remote commit that failed to apply is not retried for 24 h
UPDATE_BUDGET_SEC = 30  # two gh calls (10 s each) + the --version smoke test (8 s); counted in the worst-case run time
GH_CALL_TIMEOUT_SEC = 10
UPDATE_SMOKE_TIMEOUT_SEC = 8
LOCK_STALE_SEC = REPORT_INTERVAL_SEC - 30  # above the worst-case run time (see test), below the interval so a dead run never blocks the next tick
USAGE_RETRY_WAIT_SEC = 60
FALLBACK_RETRY_SEC = 6 * 3600
EMAIL_TRUST_SEC = 2 * 3600  # how long a verified email may be reused for ERROR reports
FALLBACK_MAX_FAILS = 3
MAX_RESET_AHEAD = timedelta(days=8)
RESET_PAST_TOLERANCE = timedelta(minutes=10)


# ---------------------------------------------------------------------------
# Local files: state, machine id, lock
# ---------------------------------------------------------------------------

def get_monitor_dir():
    target_dir = os.path.expanduser("~/.claude/quota-monitor")
    if not os.path.isdir(target_dir):
        try:
            os.makedirs(target_dir, exist_ok=True)
        except Exception:
            target_dir = os.path.dirname(os.path.abspath(__file__))
    return target_dir


def get_state_file_path():
    return os.path.join(get_monitor_dir(), "last_state.json")


def get_fallback_state_path():
    return os.path.join(get_monitor_dir(), "fallback_state.json")


def get_work_dir():
    """Neutral, empty cwd for every claude call so it never picks up a project's CLAUDE.md or settings."""
    path = os.path.join(get_monitor_dir(), "work")
    try:
        os.makedirs(path, exist_ok=True)
    except Exception:
        pass
    return path if os.path.isdir(path) else get_monitor_dir()


def _load_json_file(path):
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception:
            pass
    return {}


def _save_json_file(path, data, label):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"Warning: Failed to save {label}: {e}")


def load_last_state():
    """{"email", "verified_at", "by_email": {email: {used_percent, resets_at, last_reported_at}}}.
    The pre-3.1 flat format is migrated into by_email so one account's numbers never apply to another."""
    state = _load_json_file(get_state_file_path())
    by_email = state.get("by_email") if isinstance(state.get("by_email"), dict) else {}
    if not by_email and isinstance(state.get("email"), str) and state.get("used_percent") is not None:
        by_email = {state["email"]: {k: state.get(k) for k in ("used_percent", "resets_at", "last_reported_at")}}
    return {"email": state.get("email"), "verified_at": state.get("verified_at"), "by_email": by_email}


def save_last_state(email, used_percent, resets_at):
    current_ts = time.time()
    state = load_last_state()
    by_email = state.get("by_email") if isinstance(state.get("by_email"), dict) else {}
    entry = by_email.get(email) if isinstance(by_email.get(email), dict) else {}

    burn_rate, next_interval, samples = update_account_burn_rate(entry, used_percent, resets_at, current_ts)

    by_email[email] = {
        "used_percent": used_percent,
        "resets_at": resets_at,
        "last_reported_at": datetime.now(timezone.utc).isoformat(),
        "last_reported_ts": current_ts,
        "burn_rate": burn_rate,
        "next_interval_sec": next_interval,
        "samples": samples,
    }
    state["by_email"] = by_email
    state["email"] = email
    state["verified_at"] = current_ts
    _save_json_file(get_state_file_path(), state, "last state")
    print(f"  diag: adaptive interval = {next_interval}s ({next_interval/60:.1f}m), burn rate = {burn_rate:.1f}%/h")


def compute_adaptive_interval(burn_rate, used_percent=0.0):
    """
    Computes the next report interval in seconds based on token burn rate (%/hour)
    and current quota utilization.

    Hard bounds:
    - Min interval: 120s (2 minutes)
    - Max interval: 900s (15 minutes)

    Monotonic inverse mapping:
    - burn_rate <= 0 -> 900s
    - burn_rate increases -> interval smoothly decreases towards 120s
    - High utilization urgency: if used >= 80% and burning fast, tightens interval towards 120s.
    """
    if burn_rate is None or burn_rate <= 0.0:
        base = float(MAX_REPORT_INTERVAL_SEC)
    else:
        decay = math.exp(-float(burn_rate) / BURN_RATE_SCALE_R0)
        base = MIN_REPORT_INTERVAL_SEC + (MAX_REPORT_INTERVAL_SEC - MIN_REPORT_INTERVAL_SEC) * decay

    # Urgency boost when close to quota ceiling (Time-to-exhaustion < 1h)
    if burn_rate and burn_rate > 10.0 and used_percent is not None and used_percent >= 80.0:
        remaining_quota = max(0.0, 100.0 - float(used_percent))
        tte_hours = remaining_quota / max(1.0, float(burn_rate))
        if tte_hours <= 0.5:  # under 30 mins to 100%
            base = min(base, MIN_REPORT_INTERVAL_SEC * 1.25)
        elif tte_hours <= 1.0:  # under 1 hour to 100%
            base = min(base, MIN_REPORT_INTERVAL_SEC * 1.75)

    return max(MIN_REPORT_INTERVAL_SEC, min(MAX_REPORT_INTERVAL_SEC, int(round(base))))


def update_account_burn_rate(entry, new_used, new_resets_at, current_ts):
    """
    Updates the per-account quota history and calculates:
    - burn_rate (smoothed %/h)
    - next_interval_sec (in [120, 900])

    Rules:
    1. Only uses history belonging to THIS account (entry is by_email[account]).
    2. Reset detection: if resets_at changed or used dropped significantly (>5%),
       treats as new window start (does NOT compute negative burn rate).
    3. Asymmetric EMA smoothing:
       - Faster burn (r_inst > r_prev): fast attack (weight 0.85).
       - Slower burn (r_inst <= r_prev): smooth decay (weight 0.50).
    """
    new_used = float(new_used) if new_used is not None else 0.0
    current_ts = float(current_ts)

    samples = entry.get("samples") if isinstance(entry.get("samples"), list) else []
    valid_samples = []
    for s in samples:
        if isinstance(s, dict) and "ts" in s and "used" in s:
            valid_samples.append(s)

    prev_burn_rate = float(entry.get("burn_rate", 0.0) or 0.0)

    if not valid_samples:
        valid_samples.append({"ts": current_ts, "used": new_used, "resets_at": new_resets_at})
        burn_rate = 0.0
        next_interval = compute_adaptive_interval(burn_rate, new_used)
        return burn_rate, next_interval, valid_samples

    last_sample = valid_samples[-1]
    prev_ts = float(last_sample.get("ts", current_ts))
    prev_used = float(last_sample.get("used", new_used))
    prev_reset = last_sample.get("resets_at")

    delta_t = current_ts - prev_ts
    delta_u = new_used - prev_used

    # Check if window reset occurred
    is_reset = False
    if prev_reset and new_resets_at and prev_reset != new_resets_at:
        is_reset = True
    elif delta_u < -5.0:  # significant drop without explicit reset string change
        is_reset = True

    if is_reset:
        if delta_t > 10.0 and new_used > 0:
            delta_t_hours = delta_t / 3600.0
            r_inst = new_used / delta_t_hours
        else:
            r_inst = 0.0
        valid_samples = []
    elif delta_t < 10.0:
        r_inst = prev_burn_rate
    else:
        delta_t_hours = delta_t / 3600.0
        if delta_u > 0:
            r_inst = delta_u / delta_t_hours
        else:
            r_inst = 0.0

    # Asymmetric EMA smoothing
    if r_inst > prev_burn_rate:
        burn_rate = 0.85 * r_inst + 0.15 * prev_burn_rate
    else:
        burn_rate = 0.50 * r_inst + 0.50 * prev_burn_rate

    burn_rate = max(0.0, round(burn_rate, 2))
    next_interval = compute_adaptive_interval(burn_rate, new_used)

    valid_samples.append({"ts": current_ts, "used": new_used, "resets_at": new_resets_at})
    if len(valid_samples) > 10:
        valid_samples = valid_samples[-10:]

    return burn_rate, next_interval, valid_samples


def check_adaptive_interval():
    """
    Returns (should_run, remaining_sec, reason).
    Checks if enough time has elapsed since the last report for the currently logged-in account.
    """
    if sys.modules.get("unittest") is not None and not os.environ.get("TEST_ADAPTIVE_CHECK"):
        return True, 0, "test mode"
    if "--force" in sys.argv[1:] or os.environ.get("CLAUDE_QUOTA_FORCE"):
        if not os.environ.get("TEST_ADAPTIVE_CHECK"):
            return True, 0, "forced run"

    email = read_config_email()
    if not email:
        return True, 0, "account unknown, running check"

    state = load_last_state()
    by_email = state.get("by_email") if isinstance(state.get("by_email"), dict) else {}
    entry = by_email.get(email)
    if not isinstance(entry, dict):
        return True, 0, "first run for account"

    last_reported_ts = entry.get("last_reported_ts")
    if not isinstance(last_reported_ts, (int, float)):
        return True, 0, "no prior timestamp"

    next_interval = entry.get("next_interval_sec", MAX_REPORT_INTERVAL_SEC)
    next_interval = max(MIN_REPORT_INTERVAL_SEC, min(MAX_REPORT_INTERVAL_SEC, next_interval))

    now = time.time()
    elapsed = now - last_reported_ts
    tolerance = 15.0  # 15s grace for scheduler jitter

    if elapsed < (next_interval - tolerance):
        remaining = max(1, int(round(next_interval - elapsed)))
        burn_rate = entry.get("burn_rate", 0.0)
        return False, remaining, f"next update in {remaining}s (burn rate: {burn_rate:.1f}%/h, interval: {next_interval}s)"

    return True, 0, "interval elapsed"


def recent_verified_email():
    """The last email confirmed by a successful run, only if it is fresh. For error reports only."""
    state = load_last_state()
    at = state.get("verified_at")
    if isinstance(at, (int, float)) and 0 <= time.time() - at < EMAIL_TRUST_SEC and isinstance(state.get("email"), str):
        return state["email"]
    return None


def machine_info():
    """Display-only machine fields (hostname, OS family); not used for identity."""
    info = {}
    try:
        name = socket.gethostname().strip()
        if name:
            info["machine_name"] = name[:64]
    except Exception:
        pass
    try:
        info["os"] = platform.system()[:32]
    except Exception:
        pass
    return info


def get_machine_id():
    """Stable random id of this machine (not derived from hardware), so the Worker can tell machines apart."""
    path = os.path.join(get_monitor_dir(), "machine_id")
    try:
        with open(path, "r", encoding="utf-8") as f:
            value = f.read().strip()
        if value:
            return value
    except Exception:
        pass
    value = uuid.uuid4().hex
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(value)
    except Exception:
        pass
    return value


def acquire_lock(name="run.lock"):
    """Returns the lock path, or None when another run is active. A lock older than LOCK_STALE_SEC is stale."""
    path = os.path.join(get_monitor_dir(), name)
    for _ in range(2):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w") as f:
                f.write(str(os.getpid()))
            return path
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(path) > LOCK_STALE_SEC:
                    os.remove(path)
                    continue
                # Also check if the locking PID is already dead
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        locked_pid = int(f.read().strip())
                    if locked_pid > 0:
                        os.kill(locked_pid, 0)
                except (ProcessLookupError, ValueError):
                    os.remove(path)
                    continue
                except (PermissionError, AttributeError):
                    pass
            except Exception:
                pass
            return None
        except Exception:
            return path  # cannot lock (read-only dir...): run anyway rather than never reporting
    return None


def release_lock(path):
    if path:
        try:
            os.remove(path)
        except Exception:
            pass


def parse_iso_datetime(dt_str):
    if not dt_str:
        return None
    try:
        return datetime.fromisoformat(str(dt_str).replace("Z", "+00:00"))
    except Exception:
        return None


def check_overload_suppression():
    if "--force" in sys.argv[1:] or os.environ.get("CLAUDE_QUOTA_FORCE"):
        return False
    # Only suppress for the account that is logged in right now (a cheap config read, no subprocess);
    # if it cannot be told, run normally rather than skip another account's report.
    email = read_config_email()
    entry = load_last_state()["by_email"].get(email) if email else None
    if not isinstance(entry, dict):
        return False
    used_pct = entry.get("used_percent")
    resets_at_str = entry.get("resets_at")
    if used_pct is not None and used_pct >= 100 and resets_at_str:
        reset_dt = parse_iso_datetime(resets_at_str)
        if reset_dt and reset_dt.tzinfo:
            now = datetime.now(timezone.utc)
            if now < reset_dt:
                diff_min = max(1, int((reset_dt - now).total_seconds()) // 60)
                print(f"[Overload Suppression] Quota đang chạm trần (100%). Ngủ đông đến giờ reset ({diff_min}m nữa: {resets_at_str}). Bỏ qua lần hỏi Claude.")
                return True
    return False


# ---------------------------------------------------------------------------
# Time zones
# ---------------------------------------------------------------------------

# Used only when the tz database is unavailable (Windows without `tzdata`). Fixed offsets, no DST.
FIXED_TZ_HOURS = {
    "utc": 0, "gmt": 0, "z": 0, "etc/utc": 0, "etc/gmt": 0,
    "asia/saigon": 7, "asia/ho_chi_minh": 7, "asia/bangkok": 7, "asia/jakarta": 7, "asia/phnom_penh": 7,
    "asia/vientiane": 7, "asia/singapore": 8, "asia/kuala_lumpur": 8, "asia/shanghai": 8,
    "asia/hong_kong": 8, "asia/taipei": 8, "asia/manila": 8, "asia/tokyo": 9, "asia/seoul": 9,
    "asia/kolkata": 5.5, "asia/calcutta": 5.5, "asia/dubai": 4,
}
OFFSET_TZ_RE = re.compile(r"^(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$", re.I)


def resolve_tz(name):
    """tzinfo for a printed zone name; local zone when no name is printed; None when it cannot be resolved."""
    if not name:
        return datetime.now().astimezone().tzinfo
    name = name.strip()
    if ZoneInfo is not None:
        try:
            return ZoneInfo(name)
        except Exception:
            pass
    m = OFFSET_TZ_RE.match(name)
    if m:
        minutes = int(m.group(2)) * 60 + int(m.group(3) or 0)
        return timezone(timedelta(minutes=minutes if m.group(1) == "+" else -minutes))
    hours = FIXED_TZ_HOURS.get(name.lower())
    if hours is not None:
        return timezone(timedelta(hours=hours))
    return None


# ---------------------------------------------------------------------------
# /usage text -> structured JSON
# ---------------------------------------------------------------------------

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
LINE_RE = re.compile(
    r"^\s*(?P<label>[^:\n]{3,60}?)\s*:\s*(?P<pct>\d{1,3}(?:\.\d+)?)\s*%\s*used\b(?P<rest>.*)$", re.I)
RESETS_RE = re.compile(r"\bresets?\b\s*(?P<phrase>.*)$", re.I)
TZ_PAREN_RE = re.compile(r"\(([^()]+)\)\s*[.)]?\s*$")
MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
MON_ALT = "|".join(MONTHS)
TIME_RE = re.compile(
    r"(?<![\d:])(?P<h>\d{1,2})(?::(?P<m>\d{2})\s*(?P<ap1>[ap]\.?m\.?)?|\s*(?P<ap2>[ap]\.?m\.?))(?![\w:])", re.I)
DATE_MD_RE = re.compile(r"\b(?P<mon>" + MON_ALT + r")[a-z]*\.?\s+(?P<day>\d{1,2})(?:st|nd|rd|th)?\b", re.I)
DATE_DM_RE = re.compile(r"\b(?P<day>\d{1,2})(?:st|nd|rd|th)?\s+(?P<mon>" + MON_ALT + r")[a-z]*\b", re.I)
WEEKDAY_RE = re.compile(r"\b(?P<wd>" + "|".join(WEEKDAYS) + r")[a-z]*\b", re.I)
RELATIVE_RE = re.compile(
    r"^in\s+(?:(?P<d>\d+)\s*d(?:ays?)?)?\s*(?:(?P<h>\d+)\s*h(?:ours?|rs?)?)?\s*(?:(?P<m>\d+)\s*m(?:in(?:ute)?s?)?)?\s*$",
    re.I)


def strip_ansi(text):
    return ANSI_RE.sub("", text or "")


def _clock_from_match(tm):
    """(hour24, minute) from a TIME_RE match, or None when it is not a valid clock time."""
    hour = int(tm.group("h"))
    minute = int(tm.group("m") or 0)
    ampm = (tm.group("ap1") or tm.group("ap2") or "").lower().replace(".", "")
    if minute > 59:
        return None
    if ampm:
        if not 1 <= hour <= 12:
            return None
        hour = hour % 12 + (12 if ampm == "pm" else 0)
    elif hour > 23:
        return None
    return hour, minute


def _month_day(phrase):
    m = DATE_MD_RE.search(phrase) or DATE_DM_RE.search(phrase)
    if not m:
        return None
    return MONTHS.index(m.group("mon").lower()) + 1, int(m.group("day"))


def parse_reset_phrase(phrase, now):
    """Reset instant (aware UTC datetime) from the text after 'resets', or None. Never guesses.

    Handles "Oct 28 at 11:40am (Asia/Saigon)", "11:40am", "5pm", "Oct 29 at 17:00", "Thu 5pm",
    "28 Oct, 23:40 (UTC)" and "in 2h 15m". A date without a year is the nearest instant that is not
    more than 10 minutes in the past.
    """
    phrase = (phrase or "").strip().rstrip(".")
    rel = RELATIVE_RE.match(phrase)
    if rel and (rel.group("d") or rel.group("h") or rel.group("m")):
        delta = timedelta(days=int(rel.group("d") or 0), hours=int(rel.group("h") or 0),
                          minutes=int(rel.group("m") or 0))
        return (now + delta).astimezone(timezone.utc)

    tzname = None
    tzm = TZ_PAREN_RE.search(phrase)
    if tzm:
        tzname = tzm.group(1).strip()
        phrase = phrase[:tzm.start()]
    tz = resolve_tz(tzname)
    if tz is None:
        return None
    tm = TIME_RE.search(phrase)
    clock = _clock_from_match(tm) if tm else None
    if clock is None:
        return None
    hour, minute = clock
    floor = now - RESET_PAST_TOLERANCE
    now_local = now.astimezone(tz)

    md = _month_day(phrase)
    if md:
        for year in (now_local.year, now_local.year + 1):
            try:
                cand = datetime(year, md[0], md[1], hour, minute, tzinfo=tz)
            except ValueError:
                return None
            if cand >= floor:
                return cand.astimezone(timezone.utc)
        return None
    wd = WEEKDAY_RE.search(phrase)
    for offset in range(0, 8):
        day = (now_local + timedelta(days=offset)).date()
        if wd and WEEKDAYS[day.weekday()] != wd.group("wd").lower():
            continue
        cand = datetime(day.year, day.month, day.day, hour, minute, tzinfo=tz)
        if cand >= floor:
            return cand.astimezone(timezone.utc)
    return None


def relevant_lines(text):
    return [ln.strip() for ln in strip_ansi(text).splitlines() if re.search(r"\b(?:used|resets?)\b", ln, re.I)]


def relevant_hash(text):
    return hashlib.sha256("\n".join(relevant_lines(text)).encode("utf-8")).hexdigest()[:12]


def _iso(dt):
    return dt.astimezone(timezone.utc).isoformat() if dt else None


def parse_usage_text(text, now=None, claude_version=None):
    """Structured result for the text printed by `claude -p "/usage"`:

        {"parse_status": "ok"|"partial"|"failed",
         "session": {"used_percent": 19.0, "resets_at": "<ISO UTC>"} | None,
         "weekly":  [{"label": "Current week (Fable)", "used_percent": 0.0, "resets_at": "<ISO UTC>"|None}],
         "raw_sha": "<12 hex>", "claude_version": "2.1.312"|None}

    ok      = session percent and reset instant parsed.
    partial = session ok but at least one weekly line has no parsable reset.
    failed  = session percent or reset missing/unparsable. Nothing is ever defaulted to 0%.
    A session of exactly 0% printed with no 'resets' text at all means no active window: ok, resets_at null.
    """
    now = now or datetime.now(timezone.utc)
    clean = strip_ansi(text)
    session = None
    weekly = []
    for line in clean.splitlines():
        m = LINE_RE.match(line)
        if not m:
            continue
        pct = float(m.group("pct"))
        if pct > 100:
            continue
        label = " ".join(m.group("label").split())
        rest = m.group("rest")
        rm = RESETS_RE.search(rest)
        resets_at = parse_reset_phrase(rm.group("phrase"), now) if rm else None
        entry = {"label": label, "used_percent": pct, "resets_at": _iso(resets_at), "_has_reset_text": bool(rm)}
        low = label.lower()
        if "week" in low:
            weekly.append(entry)
        elif "session" in low and session is None:
            session = entry

    status = "failed"
    if session is not None:
        if session["resets_at"] is not None or (session["used_percent"] == 0 and not session["_has_reset_text"]):
            status = "ok"
            if any(w["resets_at"] is None for w in weekly):
                status = "partial"
    for entry in ([session] if session else []) + weekly:
        entry.pop("_has_reset_text", None)
    return {
        "parse_status": status,
        "session": {"used_percent": session["used_percent"], "resets_at": session["resets_at"]} if session else None,
        "weekly": weekly,
        "raw_sha": hashlib.sha256(clean.encode("utf-8")).hexdigest()[:12],
        "claude_version": claude_version,
    }


# ---------------------------------------------------------------------------
# Calling the claude CLI
# ---------------------------------------------------------------------------

CLAUDE_PROBE_TIMEOUT_SEC = 10
CLAUDE_PROBE_BUDGET_SEC = 20  # all `--version` probes of one lookup together; counted in the worst-case run time
CLAUDE_LOOKUP = {"diag": None}  # set by find_claude when no candidate ran; leads the claude_failed message


def get_claude_cache_path():
    return os.path.join(get_monitor_dir(), "claude_bin.json")


def claude_candidates():
    """Every existing claude file, best first: the PATH hit, every other PATH match, the usual install dirs
    (launchd/cron/Task Scheduler give a minimal PATH), then the binaries an npm install keeps beside its wrapper."""
    home = os.path.expanduser("~")
    dirs = [d.strip('"') for d in os.environ.get("PATH", "").split(os.pathsep) if d.strip('"')]
    dirs += [
        os.path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
        os.path.join(home, ".claude", "local"), os.path.join(home, ".npm-global", "bin"),
        os.path.join(home, ".bun", "bin"), os.path.join(home, ".volta", "bin"),
    ]
    dirs += glob.glob(os.path.join(home, ".nvm", "versions", "node", "*", "bin"))
    # Node unpacked under ~/.local (e.g. ~/.local/node24) is only on the login shell's PATH, never on cron's.
    dirs += glob.glob(os.path.join(home, ".local", "node*", "bin"))
    names, bin_name = ["claude"], "claude"
    if os.name == "nt":
        names, bin_name = ["claude.exe", "claude.cmd", "claude"], "claude.exe"
        for var in ("APPDATA", "LOCALAPPDATA"):
            base = os.environ.get(var)
            if base:
                dirs += [os.path.join(base, "npm"), os.path.join(base, "Programs", "claude")]
    found = [shutil.which("claude")] + [os.path.join(d, n) for d in dirs for n in names]
    # npm's @anthropic-ai/claude-code ships only a placeholder bin/claude.exe that its postinstall overwrites with
    # the platform package's binary. When that step did not run, the placeholder fails ("not compatible with the
    # version of Windows") while the platform binary may still be there. node_modules sits beside the shim on
    # Windows and in ../lib on Unix. The placeholder itself is listed last so its size shows up in the diag.
    for d in dirs:
        for root in (os.path.join(d, "node_modules"), os.path.join(os.path.dirname(d), "lib", "node_modules")):
            scope = os.path.join(root, "@anthropic-ai")
            if not os.path.isdir(scope):
                continue
            found += sorted(glob.glob(os.path.join(scope, "claude-code-*", bin_name)))
            found += sorted(glob.glob(os.path.join(scope, "claude-code", "node_modules", "@anthropic-ai",
                                                   "claude-code-*", bin_name)))
            found.append(os.path.join(scope, "claude-code", "bin", "claude.exe"))
    for ide in (".vscode", ".vscode-insiders", ".cursor", ".windsurf"):  # the IDE extension bundles its own binary
        found += sorted(glob.glob(os.path.join(home, ide, "extensions", "anthropic.claude-code-*", "resources",
                                               "native-binary", bin_name)), reverse=True)
    out, seen = [], set()
    for path in found:
        if not path or not os.path.isfile(path):
            continue
        key = os.path.normcase(os.path.abspath(path))
        if key not in seen:
            seen.add(key)
            out.append(path)
    return out


def _probe_claude(path, timeout):
    """None when `path --version` prints a version, else a short reason. A 0-byte file is never run."""
    try:
        if os.path.getsize(path) == 0:
            return "empty file"
        rc, out, err = run_cmd([path, "--version"], timeout=timeout)
    except subprocess.TimeoutExpired:
        return "timed out"
    except Exception as e:  # e.g. [WinError 216] when the exe is run directly
        return f"{type(e).__name__}: {e}"[:160]
    if rc == 0 and re.search(r"\d+\.\d+\.\d+", out):
        return None
    return f"exit {rc}: {' '.join((err or out).split())[:160]}"


def _claude_lookup_diag(candidates):
    """Compact enough to survive the 300-char error field: files found (tail of the path + size), CPU, OS build."""
    def label(path):
        try:
            size = f"{os.path.getsize(path)}B"
        except OSError:
            size = "?"
        return "\\".join(re.split(r"[\\/]+", path)[-3:]) + " " + size
    arch = []
    for value in (platform.machine(), os.environ.get("PROCESSOR_ARCHITECTURE"), os.environ.get("PROCESSOR_ARCHITEW6432")):
        if value and value not in arch:
            arch.append(value)
    files = ", ".join(label(p) for p in candidates[:4])
    return (f"no claude answered --version; found {len(candidates)}: {files}; "
            f"arch {'/'.join(arch) or '?'}; os {platform.version()[:24]}")


def find_claude():
    """Path of a claude binary that runs. Candidates are tried with `--version` and the first that answers is
    remembered (re-checked after a claude_failed run). When none answers, the first one found is still returned:
    an installed but broken Claude Code must keep sending claude_failed, not look uninstalled."""
    CLAUDE_LOOKUP["diag"] = None
    override = os.environ.get("CLAUDE_QUOTA_CLAUDE_BIN")
    if override and os.path.isfile(override):
        return override
    cache_path = get_claude_cache_path()
    cached = _load_json_file(cache_path).get("path")
    if isinstance(cached, str) and os.path.isfile(cached) and os.path.getsize(cached) > 0:
        return cached
    candidates = claude_candidates()
    if not candidates:
        return None
    deadline = time.monotonic() + CLAUDE_PROBE_BUDGET_SEC
    for path in candidates:
        left = deadline - time.monotonic()
        if left < 1:
            print("  diag: claude probe budget spent")
            break
        reason = _probe_claude(path, min(CLAUDE_PROBE_TIMEOUT_SEC, left))
        if reason is None:
            if path != candidates[0]:
                print(f"  diag: using claude at {path} (the first one found does not run)")
            _save_json_file(cache_path, {"path": path, "verified_at": time.time()}, "claude path")
            return path
        print(f"  diag: claude at {path} does not run: {reason}")
    CLAUDE_LOOKUP["diag"] = _claude_lookup_diag(candidates)
    return candidates[0]


def forget_claude_path():
    try:
        os.remove(get_claude_cache_path())
    except OSError:
        pass


def _lower_priority():
    try:
        os.nice(10)
    except Exception:
        pass


def run_cmd(args, input_text=None, timeout=60, low_priority=False):
    """Runs a command in the neutral work dir. Returns (returncode, stdout, stderr); TimeoutExpired propagates.
    low_priority runs the child at nice +10 (macOS/Linux) so a slow `claude` does not starve the user's sessions."""
    extra = {"preexec_fn": _lower_priority} if low_priority and os.name != "nt" else {}
    proc = subprocess.run(
        args, input=input_text, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout, cwd=get_work_dir(), **extra)
    return proc.returncode, proc.stdout or "", proc.stderr or ""


def get_claude_version(claude_bin):
    try:
        rc, out, _ = run_cmd([claude_bin, "--version"], timeout=20)
        m = re.search(r"\d+\.\d+\.\d+", out)
        return m.group(0) if m else None
    except Exception:
        return None


def read_config_email():
    """Email from Claude's own config (only the oauthAccount.emailAddress key is used)."""
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    candidates = [os.path.join(config_dir, ".claude.json")] if config_dir else []
    candidates.append(os.path.expanduser("~/.claude.json"))
    for path in candidates:
        account = _load_json_file(path).get("oauthAccount")
        email = account.get("emailAddress") if isinstance(account, dict) else None
        if isinstance(email, str) and "@" in email:
            return email.strip().lower()
    return None


def get_account(claude_bin):
    """(logged_in, email). logged_in is None when it cannot be told. No token is read."""
    logged_in, email = None, None
    try:
        rc, out, _ = run_cmd([claude_bin, "auth", "status"], timeout=AUTH_STATUS_TIMEOUT_SEC)
        data = json.loads(out)
        if isinstance(data, dict):
            if isinstance(data.get("loggedIn"), bool):
                logged_in = data["loggedIn"]
            if isinstance(data.get("email"), str) and "@" in data["email"]:
                email = data["email"].strip().lower()
    except Exception:
        pass
    if not email:
        email = read_config_email()
    return logged_in, email


AUTH_FAILURE_RE = re.compile(
    r"not logged in|please run /login|run /login|/login|invalid api key|authentication|unauthorized|oauth token|expired", re.I)


def _load_avg():
    try:
        return "/".join(f"{x:.1f}" for x in os.getloadavg())
    except (OSError, AttributeError):  # no getloadavg on Windows
        return "n/a"


def fetch_usage_text(claude_bin):
    """Runs `claude -p /usage`. Returns (text, None) or (None, (error_kind, message, token_state_or_None)).
    /usage scans local sessions and can exceed the timeout on an overloaded machine: wait and retry once
    before reporting usage_timeout."""
    args = [claude_bin, "-p", "/usage", "--output-format", "json", "--setting-sources", "", "--no-session-persistence"]
    diag = ""
    for attempt in (1, 2):
        started = time.monotonic()
        try:
            rc, out, err = run_cmd(args, timeout=USAGE_TIMEOUT_SEC)
            print(f"  diag: /usage took {time.monotonic() - started:.1f}s, load avg {_load_avg()}")
            break
        except subprocess.TimeoutExpired:
            diag = f"attempt {attempt} timed out after {time.monotonic() - started:.0f}s, load avg {_load_avg()}"
            print(f"  diag: /usage {diag}")
            if attempt == 1:
                time.sleep(USAGE_RETRY_WAIT_SEC)
                continue
            return None, ("usage_timeout",
                          f"`claude -p /usage` did not finish within {USAGE_TIMEOUT_SEC}s twice (diag: {diag}).", None)
        except Exception as e:
            return None, ("claude_failed", f"Could not run claude: {e}", None)
    data = None
    try:
        data = json.loads(out)
    except Exception:
        pass
    result = data.get("result") if isinstance(data, dict) else None
    if rc != 0 or not isinstance(data, dict) or data.get("is_error") or not isinstance(result, str):
        detail = result if isinstance(result, str) else (err or out)
        detail = " ".join((detail or "").split())[:200]
        if AUTH_FAILURE_RE.search(detail):
            return None, ("auth_required", f"Claude Code is not logged in: {detail}", "auth_required")
        return None, ("claude_failed", f"`claude -p /usage` failed (exit {rc}): {detail}", None)
    return result, None


# ---------------------------------------------------------------------------
# LLM fallback (only when the deterministic parser failed)
# ---------------------------------------------------------------------------

LLM_SCHEMA = {
    "type": "object",
    "properties": {
        "session_used_percent": {"type": "number"},
        "session_resets_phrase": {"type": "string"},
        "session_resets_at": {"type": "string"},
    },
    "required": ["session_used_percent", "session_resets_phrase", "session_resets_at"],
    "additionalProperties": False,
}


def build_llm_prompt(raw_text, now):
    return (
        "Extract the CURRENT 5-HOUR SESSION usage from the Claude Code /usage text below. Reply with JSON only.\n"
        "- session_used_percent: the percent used printed for the current session limit.\n"
        "- session_resets_phrase: copy VERBATIM the exact substring of the text that says when that session limit "
        "resets, including the date, the time and the parenthesised time zone if printed.\n"
        "- session_resets_at: that moment as ISO-8601 with a numeric UTC offset, using the time zone printed in the "
        f"text. The current local time is {now.astimezone().isoformat(timespec='minutes')}.\n"
        "Do not guess or compute anything that is not printed.\n\n<usage>\n" + raw_text + "\n</usage>\n"
    )


def _percent_in_text(pct, raw_text):
    forms = {str(pct), "%g" % pct}
    if float(pct).is_integer():
        forms.add(str(int(pct)))
    return any(re.search(r"(?<![\d.])" + re.escape(f) + r"\s*%", raw_text) for f in forms)


def verify_llm_extraction(data, raw_text, now):
    """Returns (session_dict, None) when every field is confirmed by the raw text, else (None, reason)."""
    if not isinstance(data, dict):
        return None, "not an object"
    pct = data.get("session_used_percent")
    phrase = data.get("session_resets_phrase")
    iso = data.get("session_resets_at")
    if isinstance(pct, bool) or not isinstance(pct, (int, float)) or not 0 <= pct <= 100:
        return None, "percent missing or out of range"
    if not isinstance(phrase, str) or not phrase.strip() or not isinstance(iso, str):
        return None, "reset fields missing"
    if not _percent_in_text(pct, raw_text):
        return None, "percent not found in the text"
    if phrase not in raw_text:
        return None, "reset phrase is not a verbatim substring of the text"
    inst = parse_iso_datetime(iso)
    if inst is None or inst.tzinfo is None:
        return None, "reset time is not a timezone-aware ISO date"
    if not (now - RESET_PAST_TOLERANCE <= inst <= now + MAX_RESET_AHEAD):
        return None, "reset time outside the next 8 days"

    body = re.sub(r"^\s*resets?\b\s*", "", phrase.strip(), flags=re.I)
    tzname = None
    tzm = TZ_PAREN_RE.search(body)
    if tzm:
        tzname = tzm.group(1).strip()
        body = body[:tzm.start()]
    tz = resolve_tz(tzname)
    if tz is None:
        return None, "time zone in the text cannot be resolved"
    tm = TIME_RE.search(body)
    clock = _clock_from_match(tm) if tm else None
    if clock is None:
        return None, "no clock time in the reset phrase"
    local = inst.astimezone(tz)
    if (local.hour, local.minute) != clock:
        return None, "reset time does not match the digits of the phrase"
    md = _month_day(body)
    if md and (local.month, local.day) != md:
        return None, "reset date does not match the phrase"
    return {"used_percent": float(pct), "resets_at": _iso(inst)}, None


def _fallback_entry(email):
    return (_load_json_file(get_fallback_state_path()).get("by_email") or {}).get(email or "_") or {}


def fallback_allowed(raw_text, now_ts=None, email=None):
    """At most one call per run; a failed extraction is not retried for 6h on identical text, and after
    3 failures in a row the retry interval is 6h whatever the text."""
    now_ts = now_ts if now_ts is not None else time.time()
    state = _fallback_entry(email)
    last_at = state.get("at")
    if not isinstance(last_at, (int, float)) or state.get("ok") is not False:
        return True
    recent = now_ts - last_at < FALLBACK_RETRY_SEC
    if recent and state.get("hash") == relevant_hash(raw_text):
        return False
    if recent and int(state.get("fails") or 0) >= FALLBACK_MAX_FAILS:
        return False
    return True


def record_fallback(raw_text, ok, now_ts=None, email=None):
    fails = 0 if ok else int(_fallback_entry(email).get("fails") or 0) + 1
    by_email = dict(_load_json_file(get_fallback_state_path()).get("by_email") or {})
    by_email[email or "_"] = {
        "hash": relevant_hash(raw_text), "at": now_ts if now_ts is not None else time.time(),
        "ok": bool(ok), "fails": fails,
    }
    _save_json_file(get_fallback_state_path(), {"by_email": by_email}, "fallback state")


def llm_fallback(claude_bin, raw_text, now=None, email=None):
    """Returns (session_dict, None) or (None, reason). Costs ~4k Haiku input tokens (setting sources are
    disabled so the user's CLAUDE.md/plugins are not loaded)."""
    now = now or datetime.now(timezone.utc)
    if os.name == "nt" and claude_bin.lower().endswith((".cmd", ".bat")):
        return None, "fallback skipped: claude is a .cmd shim whose argument quoting is unsafe"
    if not fallback_allowed(raw_text, email=email):
        return None, "fallback skipped: the same text already failed in the last 6h"
    args = [claude_bin, "-p", "--model", "haiku", "--tools", "", "--no-session-persistence",
            "--disable-slash-commands", "--setting-sources", "", "--output-format", "json",
            "--json-schema", json.dumps(LLM_SCHEMA)]
    session, reason = None, None
    try:
        rc, out, _ = run_cmd(args, input_text=build_llm_prompt(raw_text, now), timeout=FALLBACK_TIMEOUT_SEC)
        envelope = json.loads(out)
        payload = envelope.get("structured_output") if isinstance(envelope, dict) else None
        if payload is None and isinstance(envelope, dict) and isinstance(envelope.get("result"), str):
            result = re.sub(r"^```(?:json)?|```$", "", envelope["result"].strip(), flags=re.M).strip()
            payload = json.loads(result)
        if rc != 0 or (isinstance(envelope, dict) and envelope.get("is_error")):
            reason = f"claude exited with an error (exit {rc})"
        else:
            session, reason = verify_llm_extraction(payload, raw_text, now)
    except subprocess.TimeoutExpired:
        reason = "fallback call timed out"
    except Exception as e:
        reason = f"fallback output was not valid JSON ({type(e).__name__})"
    record_fallback(raw_text, session is not None, email=email)
    return session, reason


# ---------------------------------------------------------------------------
# Device / Machine / Account Labeling & Config (~/.config/ai-quota/config.json)
# ---------------------------------------------------------------------------

def get_ai_quota_config_path():
    return os.environ.get("AI_QUOTA_CONFIG_PATH") or os.path.expanduser("~/.config/ai-quota/config.json")


def load_ai_quota_config():
    path = get_ai_quota_config_path()
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
        except Exception:
            pass
    return {}


def get_machine_label():
    for flag in ("--label", "--machine-label"):
        if flag in sys.argv:
            try:
                idx = sys.argv.index(flag)
                if idx + 1 < len(sys.argv):
                    val = sys.argv[idx + 1].strip()
                    if val and not val.startswith("--"):
                        return val
            except Exception:
                pass
    env_val = os.environ.get("QUOTA_MACHINE_LABEL")
    if env_val and env_val.strip():
        return env_val.strip()
    cfg = load_ai_quota_config()
    cfg_val = cfg.get("machine_label")
    if cfg_val and isinstance(cfg_val, str) and cfg_val.strip():
        return cfg_val.strip()
    return None


def get_account_label(email=None):
    if "--account-label" in sys.argv:
        try:
            idx = sys.argv.index("--account-label")
            if idx + 1 < len(sys.argv):
                val = sys.argv[idx + 1].strip()
                if val and not val.startswith("--"):
                    return val
        except Exception:
            pass
    env_val = os.environ.get("QUOTA_ACCOUNT_LABEL")
    if env_val and env_val.strip():
        return env_val.strip()
    cfg = load_ai_quota_config()
    if email and isinstance(cfg.get("accounts"), dict):
        acct_val = cfg["accounts"].get(email)
        if acct_val and isinstance(acct_val, str) and acct_val.strip():
            return acct_val.strip()
    cfg_val = cfg.get("account_label")
    if cfg_val and isinstance(cfg_val, str) and cfg_val.strip():
        return cfg_val.strip()
    return None


# ---------------------------------------------------------------------------
# Worker API
# ---------------------------------------------------------------------------

def get_secret_key():
    if "--key" in sys.argv:
        idx = sys.argv.index("--key")
        if idx + 1 < len(sys.argv):
            return sys.argv[idx + 1]

    if os.environ.get("CLAUDE_QUOTA_SECRET_KEY"):
        return os.environ.get("CLAUDE_QUOTA_SECRET_KEY").strip()

    cfg = load_ai_quota_config()
    cfg_key = cfg.get("api_key")
    if cfg_key and isinstance(cfg_key, str) and cfg_key.strip():
        return cfg_key.strip()

    key_path = os.path.expanduser("~/.claude/claude-quota-secret-key.txt")
    if os.path.isfile(key_path):
        try:
            with open(key_path, "r", encoding="utf-8") as f:
                k = f.read().lstrip("﻿").strip()
                if k:
                    return k
        except Exception:
            pass

    return DEFAULT_KEY


def get_worker_url():
    if "--url" in sys.argv:
        idx = sys.argv.index("--url")
        if idx + 1 < len(sys.argv):
            return sys.argv[idx + 1]
    env_url = os.environ.get("CLAUDE_QUOTA_WORKER_URL")
    if env_url:
        return env_url
    cfg = load_ai_quota_config()
    cfg_url = cfg.get("worker_url")
    if cfg_url and isinstance(cfg_url, str) and cfg_url.strip():
        return cfg_url.strip()
    return DEFAULT_WORKER_URL


def post_to_worker(payload):
    """POSTs a payload. Returns (ok, status_or_None, body_text)."""
    headers = {
        "Content-Type": "application/json",
        "x-api-key": get_secret_key(),
        "User-Agent": "ClaudeQuotaMonitor/3.1",
    }
    req = urllib.request.Request(get_worker_url(), data=json.dumps(payload).encode("utf-8"),
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return True, resp.status, resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        return False, e.code, e.read().decode("utf-8", errors="ignore")
    except Exception as e:
        return False, None, str(e)


def send_error_report(email, error_kind, message, token_state=None):
    if not email:
        print(f"Warning: account email unknown, skipping {error_kind} report: {message}")
        return
    payload = {
        "email": email,
        "error_kind": error_kind,
        "error": message[:300],
        "machine_id": get_machine_id(),
        **machine_info(),
        "client_version": CLIENT_VERSION,
        **update_fields(),
    }
    ml = get_machine_label()
    if ml:
        payload["machine_label"] = ml
    al = get_account_label(email)
    if al:
        payload["account_label"] = al
    if token_state:
        payload["token_state"] = token_state
        payload["status"] = "auth_required"
    ok, status, body = post_to_worker(payload)
    print(f"{'✓' if ok else 'Warning: failed'} {error_kind} report to Worker: HTTP {status}")


def weekly_limits(weekly):
    limits = []
    for w in weekly[:8]:
        scope = re.search(r"\(([^()]+)\)\s*$", w["label"])
        limits.append({
            "kind": "weekly",
            "group": "weekly",
            "percent": w["used_percent"],
            "resets_at": w["resets_at"],
            "is_active": True,
            "scope_name": scope.group(1).strip()[:60] if scope else None,
        })
    return limits


USAGE_WINDOW_SEC = 3600


def read_recent_token_usage(window_sec=USAGE_WINDOW_SEC, now=None, projects_dir=None):
    """Tokens this machine used in the last `window_sec`, summed over every account used here.

    Reads Claude Code transcripts (~/.claude/projects/**/*.jsonl). `tokens_1h` counts input + output +
    cache-creation tokens (cache reads are cheap and would drown the signal). Stateless: each call
    rescans only files touched inside the window, and a streamed message repeated across lines counts once.
    Returns {} when there is nothing to read.
    """
    now = time.time() if now is None else now
    base = projects_dir or os.path.join(os.path.expanduser("~"), ".claude", "projects")
    cutoff = now - window_sec
    seen = set()
    tokens = msgs = 0
    try:
        for path in glob.glob(os.path.join(base, "**", "*.jsonl"), recursive=True):
            try:
                if os.path.getmtime(path) < cutoff:
                    continue
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        if '"usage"' not in line:
                            continue
                        try:
                            d = json.loads(line)
                            msg = d.get("message") or {}
                            u = msg.get("usage")
                            ts = datetime.fromisoformat(str(d.get("timestamp")).replace("Z", "+00:00")).timestamp()
                        except Exception:
                            continue
                        if not isinstance(u, dict) or ts < cutoff or ts > now + 60:
                            continue
                        key = (msg.get("id"), d.get("requestId"))
                        if key != (None, None):
                            if key in seen:
                                continue
                            seen.add(key)
                        tokens += sum(int(u.get(k) or 0) for k in
                                      ("input_tokens", "output_tokens", "cache_creation_input_tokens"))
                        msgs += 1
            except Exception:
                continue
    except Exception:
        return {}
    return {"tokens_1h": tokens, "msgs_1h": msgs}


TOKEN_CURSOR_MAX_GAP_SEC = 6 * 3600


def get_token_cursor_path():
    return os.path.join(get_monitor_dir(), "token_cursor.json")


def read_token_delta(since_ts, until_ts, projects_dir=None):
    """Tokens this machine used in (since_ts, until_ts] (epoch seconds), from the Claude Code transcripts.
    `input` = input + cache-creation tokens, `output` = output tokens (cache reads are left out, as in
    tokens_1h). The transcripts do not record the account, so the caller attributes the whole delta to
    the account that is logged in. A streamed message repeated across lines counts once."""
    base = projects_dir or os.path.join(os.path.expanduser("~"), ".claude", "projects")
    seen = set()
    inp = out = msgs = 0
    try:
        for path in glob.glob(os.path.join(base, "**", "*.jsonl"), recursive=True):
            try:
                if os.path.getmtime(path) < since_ts:
                    continue
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        if '"usage"' not in line:
                            continue
                        try:
                            d = json.loads(line)
                            msg = d.get("message") or {}
                            u = msg.get("usage")
                            ts = datetime.fromisoformat(str(d.get("timestamp")).replace("Z", "+00:00")).timestamp()
                        except Exception:
                            continue
                        if not isinstance(u, dict) or ts <= since_ts or ts > until_ts:
                            continue
                        key = (msg.get("id"), d.get("requestId"))
                        if key != (None, None):
                            if key in seen:
                                continue
                            seen.add(key)
                        inp += int(u.get("input_tokens") or 0) + int(u.get("cache_creation_input_tokens") or 0)
                        out += int(u.get("output_tokens") or 0)
                        msgs += 1
            except Exception:
                continue
    except Exception:
        return None
    return {"input": inp, "output": out, "msgs": msgs}


def build_token_delta(now=None, cursor_path=None, projects_dir=None):
    """Delta since the last successfully reported moment, as the payload's `token_delta` (times in ms).
    None when there is no usable cursor yet (first run or a long gap): history is never attributed."""
    now = time.time() if now is None else now
    since = _load_json_file(cursor_path or get_token_cursor_path()).get("ts")
    if not isinstance(since, (int, float)) or since > now or now - since > TOKEN_CURSOR_MAX_GAP_SEC:
        return None
    d = read_token_delta(since, now, projects_dir)
    if d is None:
        return None
    return {"since": int(since * 1000), "until": int(now * 1000), **d}


def commit_token_cursor(token_delta, cursor_path=None, now=None):
    """Advance the cursor after the Worker accepted the report; without a delta this starts tracking from now."""
    ts = token_delta["until"] / 1000.0 if token_delta else (time.time() if now is None else now)
    _save_json_file(cursor_path or get_token_cursor_path(), {"ts": ts}, "token cursor")


def read_local_telemetry():
    """Reads local usage and token statistics from ~/.claude/stats-cache.json and last_state.json if available."""
    data = {}
    try:
        home = os.path.expanduser("~")
        stats_path = os.path.join(home, ".claude", "stats-cache.json")
        if os.path.isfile(stats_path):
            with open(stats_path, "r", encoding="utf-8") as f:
                sc = json.load(f)
            if isinstance(sc, dict):
                if sc.get("totalSessions") is not None:
                    data["total_sessions"] = sc.get("totalSessions")
                if sc.get("totalMessages") is not None:
                    data["total_messages"] = sc.get("totalMessages")
                mu = sc.get("modelUsage")
                if isinstance(mu, dict):
                    inp = sum(m.get("inputTokens", 0) for m in mu.values() if isinstance(m, dict))
                    out = sum(m.get("outputTokens", 0) for m in mu.values() if isinstance(m, dict))
                    cr = sum(m.get("cacheReadInputTokens", 0) for m in mu.values() if isinstance(m, dict))
                    cc = sum(m.get("cacheCreationInputTokens", 0) for m in mu.values() if isinstance(m, dict))
                    data["input_tokens"] = inp
                    data["output_tokens"] = out
                    data["cache_tokens"] = cr + cc
                    data["total_tokens"] = inp + out + cr + cc
    except Exception:
        pass
    try:
        ls = load_last_state()
        cur_email = ls.get("email")
        if cur_email and "by_email" in ls and cur_email in ls["by_email"]:
            st = ls["by_email"][cur_email]
            if "burn_rate" in st:
                data["burn_rate"] = st["burn_rate"]
    except Exception:
        pass
    data.update(read_recent_token_usage())
    return data if data else None


def build_payload(email, session, weekly, fetched_at_ms, parse_source, parse_status):
    payload = {
        "email": email,
        "used_percent": round(session["used_percent"], 1),
        "resets_at": session["resets_at"],
        "limits": weekly_limits(weekly),
        "fetched_at": fetched_at_ms,
        "machine_id": get_machine_id(),
        **machine_info(),
        "client_version": CLIENT_VERSION,
        "token_state": "ok",
        "parse_source": parse_source,
        "parse_status": parse_status,
        **update_fields(),
    }
    ml = get_machine_label()
    if ml:
        payload["machine_label"] = ml
    al = get_account_label(email)
    if al:
        payload["account_label"] = al
    telem = read_local_telemetry()
    if telem:
        payload["telemetry"] = telem
    token_delta = build_token_delta()
    if token_delta:
        payload["token_delta"] = token_delta
    if parse_source != "regex":
        payload["low_confidence"] = True
    return payload


# ---------------------------------------------------------------------------
# Self-update (gh api): replaces ONLY this file, from a GitHub-verified commit on main
# ---------------------------------------------------------------------------

UPDATE_INFO = {"status": None}


def get_update_state_path(name="update_state.json"):
    return os.path.join(get_monitor_dir(), name)


def update_disabled():
    return bool(os.environ.get("CLAUDE_QUOTA_NO_UPDATE")) or os.path.exists(os.path.join(get_monitor_dir(), "no_update"))


def find_gh():
    """Path of the GitHub CLI even when launchd/cron/Task Scheduler give a minimal PATH."""
    override = os.environ.get("CLAUDE_QUOTA_GH_BIN")
    if override and os.path.isfile(override):
        return override
    found = shutil.which("gh")
    if found:
        return found
    home = os.path.expanduser("~")
    dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", os.path.join(home, ".local", "bin")]
    names = ["gh"]
    if os.name == "nt":
        names = ["gh.exe", "gh.cmd", "gh"]
        for var in ("ProgramFiles", "ProgramFiles(x86)"):
            base = os.environ.get(var)
            if base:
                dirs.append(os.path.join(base, "GitHub CLI"))
        base = os.environ.get("LOCALAPPDATA")
        if base:
            dirs += [os.path.join(base, "Programs", "GitHub CLI"), os.path.join(base, "GitHubCLI")]
    for d in dirs:
        for name in names:
            candidate = os.path.join(d, name)
            if os.path.isfile(candidate):
                return candidate
    return None


def parse_version(text):
    """"3.4" -> (3, 4); a non-numeric prefix such as "agy-" is ignored ("agy-1.0" -> (1, 0))."""
    try:
        return tuple(int(x) for x in re.sub(r"^[^0-9]*", "", str(text).strip()).split("."))
    except Exception:
        return None


def remote_client_version(source, version_var="CLIENT_VERSION"):
    m = re.search(r'^' + re.escape(version_var) + r'\s*=\s*"([^"]+)"', source, re.M)
    return m.group(1) if m else None


def _normalize_source(text):
    return text.replace("\r\n", "\n")


def _sha256(text):
    return hashlib.sha256(_normalize_source(text).encode("utf-8")).hexdigest()


def classify_gh_error(err):
    e = (err or "").lower()
    if "gh auth login" in e or "http 401" in e or "bad credentials" in e or "not logged in" in e:
        return "gh_unauthenticated"
    if "rate limit" in e:
        return "failed:rate_limited"
    if "http 404" in e or "http 403" in e:
        return "failed:no_access"
    if any(x in e for x in ("could not resolve", "dial tcp", "timed out", "network", "connection", "no such host")):
        return "failed:offline"
    return "failed:gh_error"


def _gh_api(gh, args, deadline):
    """Runs `gh api ...`. Returns (stdout, None) or (None, status) with status in the update_status vocabulary."""
    os.environ.setdefault("GH_PROMPT_DISABLED", "1")
    os.environ.setdefault("GH_NO_UPDATE_NOTIFIER", "1")
    timeout = max(2, min(GH_CALL_TIMEOUT_SEC, deadline - time.time()))
    try:
        rc, out, err = run_cmd([gh, "api"] + args, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "failed:timeout"
    except Exception:
        return None, "failed:gh_error"
    if rc != 0:
        return None, classify_gh_error(err or out)
    return out, None


def remote_constant(source, name):
    """Value of a top-level `NAME = "value"` string constant in a downloaded client, or None when it has none."""
    m = re.search(r'^' + re.escape(name) + r'\s*=\s*"([^"]*)"', source, re.M)
    return m.group(1) if m else None


ROLLBACK_AFTER_FAILS = 5          # consecutive failed reports (not found / unreachable) after an update
ROLLBACK_WINDOW_SEC = 48 * 3600   # only an update this recent is rolled back


def get_report_health_path():
    return os.path.join(get_monitor_dir(), "report_health.json")


def note_report_outcome(ok, http_status=None, script_path=None, state_name="update_state.json"):
    """Counts consecutive failed reports. After a self-update, ROLLBACK_AFTER_FAILS in a row (HTTP 404 or no
    connection) restore the previous client kept as <script>.prev, and updates pause for 24 h. Never raises.
    Returns True when a rollback happened."""
    try:
        path = get_report_health_path()
        state = _load_json_file(path)
        if ok:
            if state.get("fails"):
                _save_json_file(path, {"fails": 0}, "report health")
            return False
        if http_status not in (0, None, 404):
            return False  # auth/validation/server errors: an older client would not help
        fails = int(state.get("fails") or 0) + 1
        script = script_path or os.path.abspath(__file__)
        prev = script + ".prev"
        if (fails >= ROLLBACK_AFTER_FAILS and os.path.isfile(prev)
                and time.time() - os.path.getmtime(script) < ROLLBACK_WINDOW_SEC):
            tmp = script + ".rollback"
            shutil.copy2(prev, tmp)
            shutil.copy2(script, script + ".bad")
            os.replace(tmp, script)
            _save_json_file(get_update_state_path(state_name),
                            {"checked_at": time.time() + 24 * 3600 - UPDATE_CHECK_SEC,
                             "last_status": "rolled_back_auto", "failed": {}}, "update state")
            _save_json_file(path, {"fails": 0}, "report health")
            print(f"ERROR: {fails} failed reports in a row after an update; restored the previous client ({script}.prev).")
            return True
        _save_json_file(path, {"fails": fails}, "report health")
    except Exception:
        pass
    return False


def self_update(script_path=None, repo_path=UPDATE_PATH, version_var="CLIENT_VERSION", current_version=None,
                state_name="update_state.json", reexec_marker="CLAUDE_QUOTA_UPDATED"):
    """Checks the main branch for a newer client and swaps this file in place.
    Returns (status, swapped). status is the update_status reported to the Worker. Never raises.
    The keyword arguments let report_agy.py refresh itself with its own file, version variable and state."""
    try:
        return _self_update(script_path or os.path.abspath(__file__), repo_path, version_var,
                            current_version or CLIENT_VERSION, state_name, reexec_marker)
    except Exception as e:
        return "failed:" + re.sub(r"[^a-z0-9_]+", "_", type(e).__name__.lower())[:30], False


def _self_update(script_path, repo_path, version_var, current_version, state_name, reexec_marker):
    if update_disabled():
        return "disabled", False
    if os.environ.get(reexec_marker):  # we are the freshly swapped-in process: no loop
        return "updated_from_" + os.environ.get(reexec_marker + "_FROM", "?"), False
    state_path = get_update_state_path(state_name)
    state = _load_json_file(state_path)
    now_ts = time.time()
    if now_ts - float(state.get("checked_at") or 0) < UPDATE_CHECK_SEC:
        return state.get("last_status") or "skipped_recent", False

    failed = {k: v for k, v in (state.get("failed") or {}).items()
              if isinstance(v, dict) and now_ts - float(v.get("at") or 0) < UPDATE_RETRY_SAME_SHA_SEC}

    def finish(status, failed_sha=None):
        if failed_sha:
            failed[failed_sha] = {"at": now_ts, "status": status}
        _save_json_file(state_path, {"checked_at": now_ts, "last_status": status, "failed": failed}, "update state")
        return status, False

    gh = find_gh()
    if not gh:
        return finish("gh_missing")
    deadline = time.time() + UPDATE_BUDGET_SEC

    out, err = _gh_api(gh, [f"repos/{UPDATE_REPO}/commits?sha={UPDATE_BRANCH}&path={repo_path}&per_page=1"], deadline)
    if err:
        return finish(err)
    try:
        commit = json.loads(out)[0]
        sha = commit["sha"]
        verified = bool(((commit.get("commit") or {}).get("verification") or {}).get("verified"))
    except Exception:
        return finish("failed:bad_response")
    if sha in failed:
        return finish(failed[sha].get("status") or "failed:previous")

    out, err = _gh_api(gh, ["-H", "Accept: application/vnd.github.raw+json",
                            f"repos/{UPDATE_REPO}/contents/{repo_path}?ref={sha}"], deadline)
    if err:
        return finish(err)
    remote = out
    try:
        with open(script_path, "r", encoding="utf-8", newline="") as f:
            local = f.read()
    except Exception:
        return finish("failed:read_local")
    if _sha256(remote) == _sha256(local):
        return finish("current")

    remote_version = remote_client_version(remote, version_var)
    if parse_version(remote_version) is None:
        return finish("failed:no_version", sha)
    if parse_version(remote_version) < parse_version(current_version):
        return finish("current")  # never downgrade
    if not verified:
        return finish("unverified_commit", sha)
    # A release must never retarget a deployed client: the Worker URL and update repo stay what this install uses.
    # (A public release carries placeholders here; applying it to a private deployment silently broke every machine.)
    for const_name, running in (("DEFAULT_WORKER_URL", DEFAULT_WORKER_URL), ("UPDATE_REPO", UPDATE_REPO)):
        incoming = remote_constant(remote, const_name)
        if incoming is not None and incoming != running:
            return finish("failed:identity_changed", sha)
    try:
        compile(remote, os.path.basename(script_path), "exec")
    except SyntaxError:
        return finish("failed:syntax", sha)

    tmp = script_path + ".new"
    try:
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(remote)
        try:
            proc = subprocess.run([sys.executable, tmp, "--version"], capture_output=True, text=True,
                                  timeout=UPDATE_SMOKE_TIMEOUT_SEC, cwd=get_work_dir(),
                                  env=dict(os.environ, CLAUDE_QUOTA_NO_UPDATE="1"))
            smoke_ok = proc.returncode == 0 and proc.stdout.strip() == remote_version
        except Exception:
            smoke_ok = False
        if not smoke_ok:
            return finish("failed:smoke_test", sha)
        try:
            shutil.copy2(script_path, script_path + ".prev")
            os.replace(tmp, script_path)
        except Exception:
            return finish("failed:write", sha)
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass
    status = "updated_from_" + current_version
    _save_json_file(state_path, {"checked_at": now_ts, "last_status": status, "failed": failed}, "update state")
    return status, True


def update_fields(state_name="update_state.json"):
    status = UPDATE_INFO.get("status")
    if not status:
        return {}
    checked = _load_json_file(get_update_state_path(state_name)).get("checked_at")
    fields = {"update_status": status[:80]}
    if checked:
        fields["update_checked_at"] = int(float(checked) * 1000)
    return fields


# ---------------------------------------------------------------------------
# Codex companion: a machine that has codex gets report_codex.py without re-running setup
# ---------------------------------------------------------------------------

COMPANION_EVERY_SEC = 14 * 60       # at most one companion run per 15-minute cadence
COMPANION_JOB_FRESH_SEC = 20 * 60   # a codex-quota.log written this recently means the Codex job itself is active
COMPANION_TIMEOUT_SEC = 150
CODEX_PLACEHOLDER = ('# Placeholder written by report_quota.py until the verified report_codex.py is downloaded.\n'
                     'CODEX_CLIENT_VERSION = "codex-0.0"\nimport sys\nsys.exit(0)\n')


def cli_installed(name):
    """True when a CLI named `name` exists on PATH or in the usual install dirs (launchd/cron/Task Scheduler give a
    minimal PATH). Existence only: whether it runs is the CLI client's business."""
    if shutil.which(name):
        return True
    home = os.path.expanduser("~")
    dirs = [os.path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
            os.path.join(home, ".npm-global", "bin"), os.path.join(home, ".bun", "bin"), os.path.join(home, ".volta", "bin")]
    dirs += glob.glob(os.path.join(home, ".nvm", "versions", "node", "*", "bin"))
    dirs += glob.glob(os.path.join(home, ".local", "node*", "bin"))
    names = [name]
    if os.name == "nt":
        names = [name + ".exe", name + ".cmd", name]
        for var in ("APPDATA", "LOCALAPPDATA"):
            base = os.environ.get(var)
            if base:
                dirs += [os.path.join(base, "npm"), os.path.join(base, "Programs", name)]
    return any(os.path.isfile(os.path.join(d, n)) for d in dirs for n in names)


def run_codex_companion():
    """Never raises. Only on a machine that has `codex`: downloads report_codex.py when it is missing (through the
    same verified-commit self-update, so it needs `gh` and respects the no_update switches) and runs it, at most
    once per 15 minutes and not while the Codex job of setup is doing it already. Opt out: CLAUDE_QUOTA_NO_CODEX=1."""
    try:
        _run_codex_companion()
    except Exception as e:
        print(f"Codex companion: skipped ({type(e).__name__})")


def _run_codex_companion():
    if os.environ.get("CLAUDE_QUOTA_NO_CODEX") or update_disabled() or not cli_installed("codex"):
        return
    monitor = get_monitor_dir()
    script = os.path.join(monitor, "report_codex.py")
    state_path = os.path.join(monitor, "codex_companion.json")
    now = time.time()
    if now - float(_load_json_file(state_path).get("ran_at") or 0) < COMPANION_EVERY_SEC:
        return
    try:
        if now - os.path.getmtime(os.path.join(monitor, "codex-quota.log")) < COMPANION_JOB_FRESH_SEC:
            return
    except OSError:
        pass
    try:
        with open(script, "r", encoding="utf-8") as f:
            present = "codex-0.0" not in f.read(400)
    except OSError:
        present = False
    if not present:
        placed = not os.path.isfile(script)
        if placed:
            with open(script, "w", encoding="utf-8") as f:
                f.write(CODEX_PLACEHOLDER)
        status, swapped = self_update(script, repo_path="client/report_codex.py", version_var="CODEX_CLIENT_VERSION",
                                      current_version="codex-0.0", state_name="update_state_codex.json",
                                      reexec_marker="CODEX_QUOTA_UPDATED")
        if not swapped:
            if placed:
                try:
                    os.remove(script)
                except OSError:
                    pass
            print(f"Codex companion: report_codex.py not installed ({status})")
            return
        print("Codex companion: downloaded report_codex.py")
    _save_json_file(state_path, {"ran_at": now}, "codex companion state")
    try:
        rc, out, err = run_cmd([sys.executable, script, "--no-jitter"], timeout=COMPANION_TIMEOUT_SEC)
        text = (out + err)[-2000:]
    except subprocess.TimeoutExpired:
        rc, text = None, "timed out"
    try:  # not codex-quota.log: that file's freshness is how a running Codex job is recognised
        with open(os.path.join(monitor, "codex-companion.log"), "w", encoding="utf-8") as f:
            f.write(text)
    except OSError:
        pass
    print(f"Codex companion: ran report_codex.py (exit {rc})")


def reexec_after_update():
    env = dict(os.environ, CLAUDE_QUOTA_UPDATED="1", CLAUDE_QUOTA_UPDATED_FROM=CLIENT_VERSION)
    args = [sys.executable, os.path.abspath(__file__)] + sys.argv[1:]
    if os.name == "nt":  # no real exec on Windows: run the new file and pass its exit code on
        sys.exit(subprocess.call(args, env=env))
    os.execve(sys.executable, args, env)


def report():
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Claude Quota Reporter v{CLIENT_VERSION} running...")

    if check_overload_suppression():
        return 0

    should_run, remaining, reason = check_adaptive_interval()
    if not should_run:
        print(f"[Adaptive Interval] Current burn rate allows sleeping. {reason}. Skipping this tick.")
        return 0

    lock = acquire_lock()
    if lock is None:
        print("Another run is in progress; skipping.")
        return 0
    try:
        status, swapped = self_update()
        UPDATE_INFO["status"] = status
        if status not in ("current", "skipped_recent", "disabled"):
            print(f"Self-update: {status}")
        if swapped:
            print(f"Self-update: client updated from v{CLIENT_VERSION}; restarting with the new version...")
            release_lock(lock)  # the new process takes the lock itself
            lock = None
            try:
                reexec_after_update()
            except Exception as e:  # exec failed: keep running this (old, still working) file
                print(f"Warning: could not restart after the update: {e}")
                UPDATE_INFO["status"] = "failed:exec"
                lock = acquire_lock()
                if lock is None:
                    return 0
        return run_once()
    finally:
        release_lock(lock)


def fetch_usage_for_account(claude_bin, email):
    """Runs /usage and confirms the logged-in account did not change meanwhile. Returns
    (text, failure, email) for a measurement that belongs to `email`, or None when the account kept changing."""
    before = email
    for attempt in range(2):
        text, failure = fetch_usage_text(claude_bin)
        _, after = get_account(claude_bin)
        if before and after == before:
            return text, failure, before
        print(f"Account changed or unreadable while fetching usage ({before} -> {after}); discarding the measurement.")
        before = after or get_account(claude_bin)[1]
        if not before:
            break
    return None


def run_once():
    CLAUDE_LOOKUP["diag"] = None
    claude_bin = find_claude()
    if not claude_bin:
        # Only installed CLIs are reported: a machine without Claude Code sends nothing (no error report, no numbers).
        print("Claude Code (`claude`) is not installed on this machine; nothing to report for it.")
        return 0

    if "--no-jitter" not in sys.argv and not os.environ.get("CLAUDE_QUOTA_NO_JITTER"):
        time.sleep(random.uniform(0, MAX_JITTER_SEC))

    logged_in, email = get_account(claude_bin)
    if logged_in is False:
        print("ERROR: Claude Code is not logged in on this machine (run 'claude' and log in).")
        send_error_report(email, "auth_required", "Claude Code is not logged in on this machine.", "auth_required")
        return 1
    if not email:
        # A data report is never attributed to a remembered email: after an account switch it may be someone else's.
        print("ERROR: could not determine the account email; not reporting.")
        return 1
    print(f"✓ Account Email: {email}")
    previous = load_last_state().get("email")
    if previous and previous != email:
        print(f"  diag: account changed since the last verified run ({previous} -> {email})")

    fetched = fetch_usage_for_account(claude_bin, email)
    if fetched is None:
        print("ERROR: the logged-in account is not stable (switching accounts?); skipping this run without reporting.")
        return 1
    text, failure, email = fetched
    if failure:
        kind, message, token_state = failure
        if kind == "claude_failed":
            forget_claude_path()  # the next run looks for a working claude again
            if CLAUDE_LOOKUP["diag"]:
                message = f"{CLAUDE_LOOKUP['diag']} | {message}"
        print(f"ERROR: {message}")
        send_error_report(email, kind, message, token_state)
        return 1
    fetched_at_ms = int(time.time() * 1000)

    parsed = parse_usage_text(text, claude_version=get_claude_version(claude_bin))
    session, source = parsed["session"], "regex"
    if parsed["parse_status"] == "failed":
        print(f"Parser could not read the /usage text (sha {parsed['raw_sha']}); trying the Haiku fallback...")
        session, reason = llm_fallback(claude_bin, text, email=email)
        source = "llm_fallback"
        if session is None:
            msg = f"Could not parse /usage output (sha {parsed['raw_sha']}); {reason}."
            print(f"ERROR: {msg}")
            send_error_report(email, "parse_error", msg)
            return 1
        parsed["weekly"] = []

    print(f"✓ Current 5-hour Quota: {session['used_percent']}% used, resets at: {session['resets_at']} ({source})")
    payload = build_payload(email, session, parsed["weekly"], fetched_at_ms, source,
                            parsed["parse_status"] if source == "regex" else "llm_verified")
    ok, status, body = post_to_worker(payload)
    note_report_outcome(ok, status)
    if not ok:
        print(f"ERROR: Worker returned HTTP {status}: {body.strip()[:300]}")
        return 1
    print(f"✓ Successfully reported to Worker: HTTP {status} - {body.strip()}")
    save_last_state(email, payload["used_percent"], payload["resets_at"])
    commit_token_cursor(payload.get("token_delta"))
    return 0


def run_daemon():
    print(f"Starting Claude Quota Reporter v{CLIENT_VERSION} in daemon mode...")
    print(f"Adaptive interval bounds: {MIN_REPORT_INTERVAL_SEC}s (2m) - {MAX_REPORT_INTERVAL_SEC}s (15m)")
    while True:
        try:
            report()
        except Exception as e:
            print(f"Error during report execution: {e}")

        state = load_last_state()
        email = state.get("email") or read_config_email()
        entry = state.get("by_email", {}).get(email, {}) if email else {}
        interval = entry.get("next_interval_sec", MAX_REPORT_INTERVAL_SEC)
        interval = max(MIN_REPORT_INTERVAL_SEC, min(MAX_REPORT_INTERVAL_SEC, interval))
        print(f"[Daemon] Sleeping for {interval}s ({interval/60:.1f}m) before next update...")
        time.sleep(interval)


if __name__ == "__main__":
    if "--detect" in sys.argv[1:]:  # used by the setup scripts: prints the claude binary path (empty when not installed)
        with contextlib.redirect_stdout(io.StringIO()):  # the setup scripts read all of stdout as the path
            found = find_claude()
        print(found or "")
        sys.exit(0)
    if "--version" in sys.argv[1:]:  # used by the self-update smoke test: no side effects
        print(CLIENT_VERSION)
        sys.exit(0)
    if "--daemon" in sys.argv[1:]:
        run_daemon()
        sys.exit(0)
    exit_code = report()
    run_codex_companion()  # after the Claude run and its lock: a slow codex never delays or blocks it
    sys.exit(exit_code)
