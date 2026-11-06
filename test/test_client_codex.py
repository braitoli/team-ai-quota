"""Unit tests for client/report_codex.py. Run: python3 -m unittest discover -s test -p "test_client*.py" """
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from datetime import datetime, timezone
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "client"))
spec = importlib.util.spec_from_file_location("report_codex", os.path.join(ROOT, "client", "report_codex.py"))
rc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rc)

NOW = datetime(2026, 11, 4, 4, 0, tzinfo=timezone.utc)
FIVE_H_RESET = int(datetime(2026, 11, 4, 7, 0, tzinfo=timezone.utc).timestamp())
WEEK_RESET = int(datetime(2026, 11, 9, 4, 0, tzinfo=timezone.utc).timestamp())


def rate_result(primary=(49, 300, FIVE_H_RESET), secondary=(8, 10080, WEEK_RESET)):
    def win(t):
        return None if t is None else {"usedPercent": t[0], "windowDurationMins": t[1], "resetsAt": t[2]}
    snap = {"limitId": "codex", "limitName": None, "primary": win(primary), "secondary": win(secondary),
            "planType": "team", "rateLimitReachedType": None}
    return {"rateLimits": snap, "rateLimitsByLimitId": {"codex": snap}, "ordinaryUsageAllowed": True}


def live_result():
    """49% / 8% with resets relative to the real clock (run_once parses against the current time)."""
    now = int(time.time())
    return rate_result(primary=(49, 300, now + 3600), secondary=(8, 10080, now + 86400))


class ParserTests(unittest.TestCase):
    def test_real_shape_five_hour_and_weekly(self):
        session, weekly, reason = rc.parse_codex_limits(rate_result(), now=NOW)
        self.assertEqual(reason, "")
        self.assertEqual(session, {"used_percent": 49.0, "resets_at": "2026-11-04T07:00:00+00:00"})
        self.assertEqual(weekly, {"percent": 8.0, "resets_at": "2026-11-09T04:00:00+00:00"})

    def test_windows_are_told_apart_by_duration_not_by_position(self):
        session, weekly, _ = rc.parse_codex_limits(
            rate_result(primary=(8, 10080, WEEK_RESET), secondary=(49, 300, FIVE_H_RESET)), now=NOW)
        self.assertEqual((session["used_percent"], weekly["percent"]), (49.0, 8.0))

    def test_falls_back_to_the_codex_entry_by_limit_id(self):
        result = rate_result()
        result["rateLimits"] = None
        self.assertEqual(rc.parse_codex_limits(result, now=NOW)[0]["used_percent"], 49.0)

    def test_no_weekly_window_is_fine(self):
        session, weekly, reason = rc.parse_codex_limits(rate_result(secondary=None), now=NOW)
        self.assertEqual((session["used_percent"], weekly, reason), (49.0, None, ""))

    def test_no_five_hour_window_is_a_parse_failure_not_a_zero(self):
        session, weekly, reason = rc.parse_codex_limits(rate_result(primary=None), now=NOW)
        self.assertIsNone(session)
        self.assertIn("5h", reason)

    def test_garbage_is_a_parse_failure(self):
        for bad in (None, {}, {"rateLimits": {"primary": {"usedPercent": "x", "windowDurationMins": 300}}},
                    {"rateLimits": {"primary": {"usedPercent": True, "windowDurationMins": 300}}}):
            session, _, reason = rc.parse_codex_limits(bad, now=NOW)
            self.assertIsNone(session)
            self.assertTrue(reason)

    def test_an_expired_window_means_idle_not_the_old_percent(self):
        past = int(NOW.timestamp()) - 600
        session, weekly, _ = rc.parse_codex_limits(rate_result(primary=(49, 300, past), secondary=(8, 10080, past)), now=NOW)
        self.assertEqual(session, {"used_percent": 0.0, "resets_at": None})
        self.assertIsNone(weekly)

    def test_idle_window_without_reset_time(self):
        session, _, _ = rc.parse_codex_limits(rate_result(primary=(0, 300, None)), now=NOW)
        self.assertEqual(session, {"used_percent": 0.0, "resets_at": None})

    def test_percent_is_clamped(self):
        session, _, _ = rc.parse_codex_limits(rate_result(primary=(130, 300, FIVE_H_RESET)), now=NOW)
        self.assertEqual(session["used_percent"], 100.0)


class PayloadTests(unittest.TestCase):
    def test_payload_matches_the_server_contract(self):
        session, weekly, _ = rc.parse_codex_limits(rate_result(), now=NOW)
        with mock.patch.object(rc.rq, "get_machine_id", return_value="mid"):
            p = rc.build_codex_payload("dev@example.com", session, weekly, 1234)
        self.assertEqual((p["provider"], p["email"], p["used_percent"], p["resets_at"]),
                         ("codex", "dev@example.com", 49.0, "2026-11-04T07:00:00+00:00"))
        self.assertNotIn("pool", p)
        self.assertNotIn("telemetry", p)  # Claude's local session logs say nothing about Codex usage
        self.assertEqual(p["client_version"], rc.CODEX_CLIENT_VERSION)
        self.assertEqual(p["token_state"], "ok")
        self.assertEqual(p["limits"], [{"kind": "weekly", "group": "weekly", "percent": 8.0,
                                        "resets_at": "2026-11-09T04:00:00+00:00", "is_active": True, "scope_name": None}])

    def test_no_weekly_means_no_limits(self):
        with mock.patch.object(rc.rq, "get_machine_id", return_value="mid"):
            p = rc.build_codex_payload("a@b.co", {"used_percent": 1.0, "resets_at": None}, None, 1)
        self.assertEqual(p["limits"], [])


FAKE_APP_SERVER = textwrap.dedent('''\
    #!{shebang}
    import json, os, sys, time
    mode = os.environ.get("CODEX_FAKE_MODE", "ok")
    if "--version" in sys.argv:
        print("codex-cli 0.165.0"); sys.exit(0)
    if mode == "broken":
        sys.stderr.write("not compatible with the version of Windows"); sys.exit(1)
    for line in sys.stdin:
        msg = json.loads(line)
        if "id" not in msg:
            continue
        if mode == "hang":
            time.sleep(60)
        method = msg["method"]
        if method == "initialize":
            result = {{"userAgent": "fake"}}
        elif method == "account/read":
            result = {{"account": None, "requiresOpenaiAuth": True}} if mode == "loggedout" else \\
                {{"account": {{"type": "chatgpt", "email": "Dev@Example.com", "planType": "team"}}, "requiresOpenaiAuth": True}}
        elif method == "account/rateLimits/read":
            if mode == "ratelimit_error":
                print(json.dumps({{"id": msg["id"], "error": {{"code": -32603, "message": "backend unavailable"}}}}), flush=True)
                continue
            snap = {{"limitId": "codex", "primary": {{"usedPercent": 49, "windowDurationMins": 300, "resetsAt": {five}}},
                    "secondary": {{"usedPercent": 8, "windowDurationMins": 10080, "resetsAt": {week}}}}}
            result = {{"rateLimits": snap, "rateLimitsByLimitId": {{"codex": snap}}}}
        else:
            print(json.dumps({{"id": msg["id"], "error": {{"code": -32601, "message": "unknown"}}}}), flush=True)
            continue
        print(json.dumps({{"id": msg["id"], "result": result}}), flush=True)
''')


@unittest.skipIf(os.name == "nt", "the fake CLI is a POSIX shebang script")
class AppServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = os.path.join(self.tmp, "codex")
        future = int(datetime.now(timezone.utc).timestamp()) + 3600
        with open(self.bin, "w") as f:
            f.write(FAKE_APP_SERVER.format(shebang=sys.executable, five=future, week=future + 86400))
        os.chmod(self.bin, os.stat(self.bin).st_mode | stat.S_IEXEC)
        for target, kwargs in (("get_monitor_dir", {"return_value": self.tmp}),):
            p = mock.patch.object(rc.rq, target, **kwargs)
            p.start()
            self.addCleanup(p.stop)

    def fetch(self, mode):
        with mock.patch.dict(os.environ, {"CODEX_FAKE_MODE": mode}):
            return rc.fetch_codex_state(self.bin)

    def test_reads_email_plan_and_limits_from_the_app_server(self):
        email, result, failure = self.fetch("ok")
        self.assertIsNone(failure)
        self.assertEqual(email, "dev@example.com")
        self.assertEqual(result["rateLimits"]["primary"]["usedPercent"], 49)

    def test_logged_out_is_auth_required(self):
        email, result, failure = self.fetch("loggedout")
        self.assertIsNone(email)
        self.assertEqual((failure[0], failure[2]), ("auth_required", "auth_required"))

    def test_rate_limit_error_is_reported_with_its_message(self):
        _, _, failure = self.fetch("ratelimit_error")
        self.assertEqual(failure[0], "usage_error")
        self.assertIn("backend unavailable", failure[1])

    def test_silent_server_times_out_and_is_killed(self):
        with mock.patch.object(rc, "CODEX_TIMEOUT_SEC", 2):
            _, _, failure = self.fetch("hang")
        self.assertEqual(failure[0], "usage_timeout")

    def test_a_node_script_codex_runs_when_the_scheduler_path_has_no_node(self):
        # launchd/cron/Task Scheduler give a minimal PATH; npm's codex is `#!/usr/bin/env node`, and node lives
        # beside it (e.g. /opt/homebrew/bin). Here "fakenode" plays node and is only reachable via the script's dir.
        bindir = os.path.join(self.tmp, "nodebin")
        os.makedirs(bindir)
        os.symlink(sys.executable, os.path.join(bindir, "fakenode"))
        script = os.path.join(bindir, "codex")
        future = int(datetime.now(timezone.utc).timestamp()) + 3600
        with open(script, "w") as f:
            f.write(FAKE_APP_SERVER.format(shebang="/usr/bin/env fakenode", five=future, week=future + 86400))
        os.chmod(script, os.stat(script).st_mode | stat.S_IEXEC)
        with mock.patch.dict(os.environ, {"PATH": "/usr/bin:/bin", "CODEX_FAKE_MODE": "ok"}):
            email, result, failure = rc.fetch_codex_state(script)
        self.assertIsNone(failure)
        self.assertEqual(email, "dev@example.com")

    def test_broken_binary_is_codex_failed(self):
        _, _, failure = self.fetch("broken")
        self.assertEqual(failure[0], "codex_failed")


class RunOnceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.posted = []

        def post(payload):
            self.posted.append(payload)
            return True, 200, '{"success":true}'
        env = mock.patch.dict(os.environ, {"CLAUDE_QUOTA_NO_JITTER": "1"})
        env.start()
        self.addCleanup(env.stop)
        for obj, target, kwargs in (
            (rc.rq, "get_monitor_dir", {"return_value": self.tmp}),
            (rc.rq, "post_to_worker", {"side_effect": post}),
            (rc.rq, "get_machine_id", {"return_value": "mid"}),
            (rc, "find_codex", {"return_value": "/bin/codex"}),
        ):
            p = mock.patch.object(obj, target, **kwargs)
            p.start()
            self.addCleanup(p.stop)

    def test_happy_path_posts_one_report(self):
        with mock.patch.object(rc, "fetch_codex_state", return_value=("dev@example.com", live_result(), None)):
            self.assertEqual(rc.run_once(), 0)
        self.assertEqual(len(self.posted), 1)
        self.assertEqual((self.posted[0]["provider"], self.posted[0]["used_percent"]), ("codex", 49.0))

    def test_failure_sends_an_error_report_with_the_account(self):
        failure = ("usage_timeout", "timed out", None)
        with mock.patch.object(rc, "fetch_codex_state", return_value=("dev@example.com", None, failure)):
            self.assertEqual(rc.run_once(), 1)
        p = self.posted[0]
        self.assertEqual((p["provider"], p["error_kind"], p["email"]), ("codex", "usage_timeout", "dev@example.com"))
        self.assertNotIn("used_percent", p)

    def test_logged_out_reports_auth_required_only_when_the_account_is_known(self):
        failure = ("auth_required", "Codex is not logged in.", "auth_required")
        with mock.patch.object(rc, "fetch_codex_state", return_value=(None, None, failure)):
            self.assertEqual(rc.run_once(), 1)
        self.assertEqual(self.posted, [])  # no email: nothing to attribute the error to

    def test_a_broken_codex_still_reports_under_the_last_known_account(self):
        with mock.patch.object(rc, "fetch_codex_state", return_value=("dev@example.com", live_result(), None)):
            self.assertEqual(rc.run_once(), 0)
        self.posted.clear()
        failure = ("codex_failed", "codex app-server exited (exit 127) before answering", None)
        with mock.patch.object(rc, "fetch_codex_state", return_value=(None, None, failure)):
            self.assertEqual(rc.run_once(), 1)
        self.assertEqual((self.posted[0]["error_kind"], self.posted[0]["email"]), ("codex_failed", "dev@example.com"))

    def test_a_stale_remembered_account_is_not_used(self):
        rc.rq._save_json_file(rc.get_codex_state_path(), {"email": "old@example.com", "verified_at": time.time() - rc.rq.EMAIL_TRUST_SEC - 60}, "t")
        with mock.patch.object(rc, "fetch_codex_state", return_value=(None, None, ("codex_failed", "x", None))):
            self.assertEqual(rc.run_once(), 1)
        self.assertEqual(self.posted, [])

    def test_unparsable_limits_send_parse_error_not_zero(self):
        with mock.patch.object(rc, "fetch_codex_state", return_value=("dev@example.com", rate_result(primary=None), None)):
            self.assertEqual(rc.run_once(), 1)
        self.assertEqual(self.posted[0]["error_kind"], "parse_error")
        self.assertNotIn("used_percent", self.posted[0])

    def test_missing_codex_sends_nothing(self):
        with mock.patch.object(rc, "find_codex", return_value=None):
            self.assertEqual(rc.run_once(), 0)
        self.assertEqual(self.posted, [])

    def test_worker_failure_returns_1(self):
        with mock.patch.object(rc, "fetch_codex_state", return_value=("dev@example.com", live_result(), None)), \
                mock.patch.object(rc.rq, "post_to_worker", return_value=(False, 500, "boom")):
            self.assertEqual(rc.run_once(), 1)


class FindCodexTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        p = mock.patch.object(rc.rq, "get_monitor_dir", return_value=self.tmp)
        p.start()
        self.addCleanup(p.stop)

    def _file(self, *parts, size=10):
        path = os.path.join(self.tmp, *parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(b"x" * size)
        return path

    def test_override_wins(self):
        fake = self._file("mine", "codex")
        with mock.patch.dict(os.environ, {"CODEX_QUOTA_CODEX_BIN": fake}):
            self.assertEqual(rc.find_codex(), fake)

    def test_skips_a_broken_first_hit_and_returns_one_that_runs(self):
        broken, good = self._file("a", "codex"), self._file("b", "codex")

        def run(args, **kwargs):
            return (0, "codex-cli 0.165.0\n", "") if args[0] == good else (1, "", "not compatible")
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(rc, "codex_candidates", return_value=[broken, good]), \
                mock.patch.object(rc.rq, "run_cmd", side_effect=run):
            os.environ.pop("CODEX_QUOTA_CODEX_BIN", None)
            self.assertEqual(rc.find_codex(), good)

    def test_installed_but_broken_is_still_returned_so_it_reports_codex_failed(self):
        only = self._file("a", "codex")
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(rc, "codex_candidates", return_value=[only]), \
                mock.patch.object(rc.rq, "run_cmd", return_value=(1, "", "nope")):
            os.environ.pop("CODEX_QUOTA_CODEX_BIN", None)
            self.assertEqual(rc.find_codex(), only)

    def test_not_installed_is_none(self):
        with mock.patch.dict(os.environ, {}, clear=False), mock.patch.object(rc, "codex_candidates", return_value=[]):
            os.environ.pop("CODEX_QUOTA_CODEX_BIN", None)
            self.assertIsNone(rc.find_codex())

    def test_detect_flag_prints_only_the_path(self):
        env = dict(os.environ, CODEX_QUOTA_CODEX_BIN=sys.executable)
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "client", "report_codex.py"), "--detect"],
                              capture_output=True, text=True, timeout=30, env=env)
        self.assertEqual((proc.returncode, proc.stdout.strip()), (0, sys.executable))

    def test_version_flag_has_no_side_effects(self):
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "client", "report_codex.py"), "--version"],
                              capture_output=True, text=True, timeout=30)
        self.assertEqual((proc.returncode, proc.stdout.strip()), (0, rc.CODEX_CLIENT_VERSION))

    def test_client_does_not_read_auth_files_or_tokens(self):
        with open(os.path.join(ROOT, "client", "report_codex.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("auth.json", src)
        self.assertNotIn("access_token", src)
        self.assertNotIn("refresh_token", src)


if __name__ == "__main__":
    unittest.main()
