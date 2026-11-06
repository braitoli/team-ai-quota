#!/usr/bin/env python3
"""
AI Quota - Unified CLI for AI Coding Agent Quota Monitoring.
Python 3.8+, standard library only.

Subcommands:
  report: Runs enabled collectors for claude, codex, agy, gemini, copilot, cursor.
  label:  Configures machine and account labels locally and syncs with the Worker.
  best:   Queries /api/route for the best account recommendation for a provider.
"""

import os
import sys
import json
import argparse
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import report_quota as rq   # noqa: E402
import report_codex as rc   # noqa: E402
import report_agy as ra     # noqa: E402
import report_gemini as rg  # noqa: E402
import report_copilot as rcp  # noqa: E402
import report_cursor as rcu   # noqa: E402

ALL_PROVIDERS = ["claude", "codex", "agy", "gemini", "copilot", "cursor"]


def get_base_url():
    url = rq.get_worker_url()
    for suffix in ("/update", "/api/update", "/status", "/api/status"):
        if url.endswith(suffix):
            return url[:-len(suffix)]
    return url.rstrip("/")


def auto_detect_providers():
    detected = []
    # Claude
    if hasattr(rq, "find_claude") and rq.find_claude():
        detected.append("claude")
    elif os.environ.get("CLAUDE_BIN"):
        detected.append("claude")

    # Codex
    if hasattr(rc, "find_codex") and rc.find_codex():
        detected.append("codex")
    elif os.environ.get("CODEX_BIN"):
        detected.append("codex")

    # Agy
    if hasattr(ra, "find_agy") and ra.find_agy():
        detected.append("agy")
    elif os.environ.get("AGY_QUOTA_AGY_BIN"):
        detected.append("agy")

    # Gemini
    if rg.find_gemini() or os.environ.get("GEMINI_USAGE_JSON"):
        detected.append("gemini")

    # Copilot
    if rcp.find_gh() or os.environ.get("COPILOT_USAGE_JSON"):
        detected.append("copilot")

    # Cursor
    if rcu.find_cursor() or rcu.find_cursor_state_db() or os.environ.get("CURSOR_USAGE_JSON"):
        detected.append("cursor")

    return detected


def resolve_providers(provider_arg=None):
    if provider_arg:
        return [p.strip().lower() for p in provider_arg.split(",") if p.strip()]

    env_p = os.environ.get("QUOTA_PROVIDERS")
    if env_p:
        return [p.strip().lower() for p in env_p.split(",") if p.strip()]

    cfg = rq.load_ai_quota_config()
    cfg_p = cfg.get("enabled_providers")
    if isinstance(cfg_p, list) and cfg_p:
        return [str(p).strip().lower() for p in cfg_p if str(p).strip()]

    detected = auto_detect_providers()
    return detected if detected else ["claude"]


def cmd_report(args):
    providers = resolve_providers(args.providers)
    if not providers:
        print("No AI coding agent providers detected or specified.")
        return 0

    print(f"Running quota report for providers: {', '.join(providers)}")
    results = {}
    for p in providers:
        try:
            if p == "claude":
                # Check claude
                c_bin = rq.find_claude() if hasattr(rq, "find_claude") else None
                if not c_bin:
                    print("Claude Code (`claude`) is not installed on this machine; skipping.")
                    results[p] = False
                else:
                    results[p] = (rq.run_report(force=args.force) == 0)
            elif p == "codex":
                results[p] = rc.run_codex_report(force=args.force)
            elif p == "agy":
                results[p] = ra.run_agy_report(force=args.force)
            elif p == "gemini":
                results[p] = rg.run_gemini_report(force=args.force)
            elif p == "copilot":
                results[p] = rcp.run_copilot_report(force=args.force)
            elif p == "cursor":
                results[p] = rcu.run_cursor_report(force=args.force)
            else:
                print(f"Warning: unknown provider '{p}'")
                results[p] = False
        except Exception as e:
            print(f"ERROR: Failed reporting for provider '{p}': {e}")
            results[p] = False

    success_count = sum(1 for v in results.values() if v)
    print(f"Report summary: {success_count}/{len(results)} providers reported successfully.")
    return 0 if success_count > 0 or len(results) == 0 else 1


def cmd_label(args):
    cfg_path = rq.get_ai_quota_config_path()
    cfg_dir = os.path.dirname(cfg_path)
    if cfg_dir:
        os.makedirs(cfg_dir, exist_ok=True)

    config = rq.load_ai_quota_config()

    if args.machine:
        config["machine_label"] = args.machine.strip()

    if args.account:
        acct = args.account.strip()
        if ":" in acct:
            email, lbl = acct.split(":", 1)
            email = email.strip().lower()
            lbl = lbl.strip()
            if "accounts" not in config or not isinstance(config["accounts"], dict):
                config["accounts"] = {}
            config["accounts"][email] = lbl
            config["account_label"] = lbl
        else:
            config["account_label"] = acct

    # Save to local file
    try:
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2)
        print(f"✓ Labels saved locally to {cfg_path}")
    except Exception as e:
        print(f"ERROR: Could not write config to {cfg_path}: {e}")
        return 1

    # Attempt to sync with server
    base = get_base_url()
    labels_url = f"{base}/api/labels"
    payload = {
        "machine_id": rq.get_machine_id(),
        **rq.machine_info(),
    }
    if config.get("machine_label"):
        payload["machine_label"] = config["machine_label"]
    if config.get("account_label"):
        payload["account_label"] = config["account_label"]
    if config.get("accounts"):
        payload["accounts"] = config["accounts"]

    req = urllib.request.Request(
        labels_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-api-key": rq.get_secret_key(),
            "User-Agent": "AIQuotaCLI/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
            print(f"✓ Labels synchronized with server ({labels_url}): HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"Notice: server endpoint {labels_url} is not yet implemented (HTTP 404). Local config is active.")
        else:
            print(f"Warning: server returned HTTP {e.code} for {labels_url}")
    except Exception as e:
        print(f"Notice: could not reach server at {labels_url} ({e}). Local config is active.")

    return 0


def cmd_best(args):
    provider = (args.provider or "claude").strip().lower()
    base = get_base_url()
    route_url = f"{base}/api/route?provider={provider}"

    req = urllib.request.Request(
        route_url,
        headers={
            "x-api-key": rq.get_secret_key(),
            "User-Agent": "AIQuotaCLI/1.0",
        },
        method="GET",
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
    except urllib.error.HTTPError as e:
        print(f"ERROR: Server returned HTTP {e.code} for {route_url}")
        return 1
    except Exception as e:
        print(f"ERROR: Failed to connect to {route_url}: {e}")
        return 1

    if not isinstance(data, dict):
        print(f"ERROR: Invalid response from {route_url}")
        return 1

    recommended = data.get("account") or data.get("email") or data.get("recommended") or data.get("best_account")
    if recommended:
        print(recommended)
        return 0

    print(f"ERROR: Server did not return a recommended account for provider '{provider}'. Response: {json.dumps(data)}")
    return 1


def main():
    parser = argparse.ArgumentParser(description="AI Quota CLI - Multi-Agent Quota Monitor")
    subparsers = parser.add_subparsers(dest="subcommand", help="Subcommand to run")

    # report
    p_report = subparsers.add_parser("report", help="Run quota collectors")
    p_report.add_argument("--providers", help="Comma-separated list of providers (claude,codex,agy,gemini,copilot,cursor)")
    p_report.add_argument("--force", action="store_true", help="Force report immediately bypassing jitter/lock")
    p_report.add_argument("--label", "--machine-label", dest="label", help="Machine label")
    p_report.add_argument("--account-label", help="Account label")
    p_report.add_argument("--key", help="Worker API key")
    p_report.add_argument("--url", help="Worker URL")

    # label
    p_label = subparsers.add_parser("label", help="Set machine and account labels")
    p_label.add_argument("--machine", "-m", help="Machine label (e.g. 'Alice-MBP')")
    p_label.add_argument("--account", "-a", help="Account label or email:label (e.g. 'dev@example.com:TeamLead')")
    p_label.add_argument("--key", help="Worker API key")
    p_label.add_argument("--url", help="Worker URL")

    # best
    p_best = subparsers.add_parser("best", help="Get recommended best account for a provider")
    p_best.add_argument("--provider", "-p", default="claude", help="Provider name (default: claude)")
    p_best.add_argument("--key", help="Worker API key")
    p_best.add_argument("--url", help="Worker URL")

    # Default to report if no subcommand given
    if len(sys.argv) == 1 or sys.argv[1].startswith("-"):
        args = parser.parse_args(["report"] + sys.argv[1:])
    else:
        args = parser.parse_args()

    if args.subcommand == "report":
        sys.exit(cmd_report(args))
    elif args.subcommand == "label":
        sys.exit(cmd_label(args))
    elif args.subcommand == "best":
        sys.exit(cmd_best(args))
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
