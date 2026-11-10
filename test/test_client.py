"""Unit tests for client/report_quota.py (v3). Run: python3 -m unittest discover -s test -p "test_client*.py" """
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "test", "fixtures")
spec = importlib.util.spec_from_file_location("report_quota", os.path.join(ROOT, "client", "report_quota.py"))
rq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rq)

NOW = datetime(2026, 10, 28, 0, 10, tzinfo=timezone.utc)  # 07:10 in Asia/Saigon, a Wednesday


def fixture(name):
    with open(os.path.join(FIXTURES, name), "r", encoding="utf-8", newline="") as f:
        return f.read()


def parse(name, now=NOW):
    return rq.parse_usage_text(fixture(name), now=now, claude_version="2.1.312")


class TokenUsageTests(unittest.TestCase):
    def _line(self, ts, mid, rid, inp, out, cc=0, cr=0):
        return json.dumps({"timestamp": ts, "requestId": rid, "message": {"id": mid, "usage": {
            "input_tokens": inp, "output_tokens": out, "cache_creation_input_tokens": cc,
            "cache_read_input_tokens": cr}}}) + "\n"

    def test_sums_window_dedupes_and_skips_cache_reads(self):
        now = datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc).timestamp()
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        os.makedirs(os.path.join(d, "proj", "sub"))
        with open(os.path.join(d, "proj", "a.jsonl"), "w") as f:
            f.write(self._line("2026-11-02T11:30:00Z", "m1", "r1", 10, 100, 5, 99999))
            f.write(self._line("2026-11-02T11:30:01Z", "m1", "r1", 10, 100, 5, 99999))  # streamed duplicate
            f.write(self._line("2026-11-02T10:00:00Z", "m0", "r0", 1000, 1000))  # outside the hour
            f.write("not json with \"usage\"\n")
        with open(os.path.join(d, "proj", "sub", "b.jsonl"), "w") as f:
            f.write(self._line("2026-11-02T11:59:00Z", "m2", "r2", 1, 2, 3))
        for p in (os.path.join(d, "proj", "a.jsonl"), os.path.join(d, "proj", "sub", "b.jsonl")):
            os.utime(p, (now, now))
        r = rq.read_recent_token_usage(now=now, projects_dir=d)
        self.assertEqual(r, {"tokens_1h": 10 + 100 + 5 + 1 + 2 + 3, "msgs_1h": 2})

    def test_missing_dir_gives_zero(self):
        self.assertEqual(rq.read_recent_token_usage(projects_dir="/nonexistent-x"), {"tokens_1h": 0, "msgs_1h": 0})


class ParserTests(unittest.TestCase):
    def test_real_mac_output(self):
        r = parse("usage-01-real-mac.txt")
        self.assertEqual(r["parse_status"], "ok")
        self.assertEqual(r["session"], {"used_percent": 19.0, "resets_at": "2026-10-28T04:40:00+00:00"})
        self.assertEqual(r["weekly"], [{"label": "Current week (Fable)", "used_percent": 0.0,
                                        "resets_at": "2026-10-29T10:00:00+00:00"}])
        self.assertEqual(len(r["raw_sha"]), 12)
        self.assertEqual(r["claude_version"], "2.1.312")

    def test_24h_clock_and_all_models(self):
        r = parse("usage-02-24h-clock.txt")
        self.assertEqual(r["session"], {"used_percent": 62.0, "resets_at": "2026-10-28T16:40:00+00:00"})
        self.assertEqual(r["weekly"][0]["label"], "Current week (all models)")
        self.assertEqual(r["weekly"][0]["resets_at"], "2026-10-31T10:00:00+00:00")

    def test_time_only_is_nearest_future(self):
        r = parse("usage-03-time-only.txt")
        self.assertEqual(r["session"]["resets_at"], "2026-10-28T04:40:00+00:00")
        later = datetime(2026, 10, 28, 6, 0, tzinfo=timezone.utc)  # 13:00 local: 11:40am is tomorrow
        self.assertEqual(parse("usage-03-time-only.txt", later)["session"]["resets_at"], "2026-10-29T04:40:00+00:00")
        just_past = datetime(2026, 10, 28, 4, 45, tzinfo=timezone.utc)  # 5 min after: still today (tolerance)
        self.assertEqual(parse("usage-03-time-only.txt", just_past)["session"]["resets_at"], "2026-10-28T04:40:00+00:00")

    def test_ansi_codes_are_ignored(self):
        r = parse("usage-04-ansi.txt")
        self.assertEqual(r["parse_status"], "ok")
        self.assertEqual(r["session"]["used_percent"], 44.0)

    def test_utc_and_several_weekly_limits(self):
        r = parse("usage-05-utc-weekly-two.txt")
        self.assertEqual(r["session"], {"used_percent": 100.0, "resets_at": "2026-10-28T05:00:00+00:00"})
        self.assertEqual([(w["label"], w["used_percent"], w["resets_at"]) for w in r["weekly"]], [
            ("Current week (all models)", 90.5, "2026-10-30T00:00:00+00:00"),
            ("Current week (Opus)", 71.0, "2026-10-30T12:00:00+00:00"),
        ])

    @unittest.skipIf(rq.ZoneInfo is None, "tz database not available")
    def test_year_rollover_with_dst_zone(self):
        now = datetime(2026, 12, 31, 20, 0, tzinfo=timezone.utc)
        r = parse("usage-06-new-year.txt", now)
        self.assertEqual(r["session"]["resets_at"], "2027-01-01T05:05:00+00:00")

    def test_past_reset_in_same_year_does_not_jump_to_next_year(self):
        now = datetime(2026, 11, 10, 8, 0, tzinfo=timezone.utc)
        dt = rq.parse_reset_phrase("Oct 28 at 11:40am (Asia/Saigon)", now)
        self.assertIsNotNone(dt)
        self.assertEqual(dt.year, 2026)
        self.assertEqual(dt.isoformat(), "2026-10-28T04:40:00+00:00")

    def test_candidate_farther_than_35_days_is_rejected(self):
        now = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)
        dt = rq.parse_reset_phrase("in 40d 0h", now)
        self.assertIsNone(dt)

    def test_idle_zero_without_reset_is_ok_with_null_reset(self):
        r = parse("usage-07-idle-zero-no-reset.txt")
        self.assertEqual(r["parse_status"], "ok")
        self.assertEqual(r["session"], {"used_percent": 0.0, "resets_at": None})

    def test_changed_format_fails_and_never_defaults_to_zero(self):
        r = parse("usage-08-format-changed.txt")
        self.assertEqual(r["parse_status"], "failed")
        self.assertIsNone(r["session"])

    def test_relative_reset(self):
        r = parse("usage-09-relative.txt")
        self.assertEqual(r["session"], {"used_percent": 41.0, "resets_at": "2026-10-28T02:25:00+00:00"})

    def test_crlf_and_decimals(self):
        r = parse("usage-10-crlf-decimals.txt")
        self.assertEqual(r["session"]["used_percent"], 7.5)
        self.assertEqual(r["weekly"][0]["used_percent"], 0.5)

    def test_weekly_reset_missing_is_partial(self):
        r = parse("usage-11-weekly-reset-missing.txt")
        self.assertEqual(r["parse_status"], "partial")
        self.assertEqual(r["session"]["used_percent"], 19.0)
        self.assertIsNone(r["weekly"][0]["resets_at"])

    def test_unknown_timezone_fails(self):
        r = parse("usage-12-unknown-tz.txt")
        self.assertEqual(r["parse_status"], "failed")

    def test_percent_without_any_reset_text_fails_when_not_zero(self):
        r = parse("usage-13-percent-no-reset-text.txt")
        self.assertEqual(r["parse_status"], "failed")

    def test_weekday_reset(self):
        r = parse("usage-14-weekday.txt")
        self.assertEqual(r["weekly"][0]["resets_at"], "2026-10-29T10:00:00+00:00")

    def test_fixed_offset_table_when_tz_database_missing(self):
        with mock.patch.object(rq, "ZoneInfo", None):
            r = parse("usage-01-real-mac.txt")
            self.assertEqual(r["session"]["resets_at"], "2026-10-28T04:40:00+00:00")
            self.assertEqual(parse("usage-12-unknown-tz.txt")["parse_status"], "failed")

    def test_gmt_plus_offset_zone(self):
        text = "Current session: 10% used · resets Oct 28 at 11:40am (GMT+7)\n"
        r = rq.parse_usage_text(text, now=NOW)
        self.assertEqual(r["session"]["resets_at"], "2026-10-28T04:40:00+00:00")

    def test_percent_over_100_is_not_trusted(self):
        r = rq.parse_usage_text("Current session: 250% used · resets 11:40am (UTC)\n", now=NOW)
        self.assertEqual(r["parse_status"], "failed")

    def test_empty_input(self):
        self.assertEqual(rq.parse_usage_text("", now=NOW)["parse_status"], "failed")
        self.assertEqual(rq.parse_usage_text(None, now=NOW)["parse_status"], "failed")


class VerifyLlmTests(unittest.TestCase):
    RAW = fixture("usage-01-real-mac.txt")
    GOOD = {"session_used_percent": 19, "session_resets_phrase": "resets Oct 28 at 11:40am (Asia/Saigon)",
            "session_resets_at": "2026-10-28T11:40:00+07:00"}

    def check(self, **over):
        data = dict(self.GOOD)
        data.update(over)
        return rq.verify_llm_extraction(data, self.RAW, NOW)

    def test_accepts_confirmed_values(self):
        session, reason = self.check()
        self.assertIsNone(reason)
        self.assertEqual(session, {"used_percent": 19.0, "resets_at": "2026-10-28T04:40:00+00:00"})

    def test_rejects_percent_not_in_text(self):
        self.assertIsNotNone(self.check(session_used_percent=25)[1])

    def test_rejects_percent_out_of_range(self):
        self.assertIsNotNone(self.check(session_used_percent=-1)[1])
        self.assertIsNotNone(self.check(session_used_percent=140)[1])

    def test_rejects_non_verbatim_phrase(self):
        self.assertIsNotNone(self.check(session_resets_phrase="resets Oct 28 at 11:45am (Asia/Saigon)")[1])

    def test_rejects_time_that_does_not_match_the_phrase(self):
        self.assertIsNotNone(self.check(session_resets_at="2026-10-28T12:40:00+07:00")[1])

    def test_rejects_wrong_offset(self):
        self.assertIsNotNone(self.check(session_resets_at="2026-10-28T11:40:00+00:00")[1])

    def test_rejects_reset_beyond_8_days_or_in_the_past(self):
        far = datetime(2026, 11, 20, tzinfo=timezone.utc)
        self.assertIsNotNone(rq.verify_llm_extraction(self.GOOD, self.RAW, far)[1])
        self.assertIsNotNone(rq.verify_llm_extraction(self.GOOD, self.RAW, datetime(2026, 10, 28, 6, tzinfo=timezone.utc))[1])

    def test_rejects_naive_or_garbage_dates_and_non_objects(self):
        self.assertIsNotNone(self.check(session_resets_at="2026-10-28T11:40:00")[1])
        self.assertIsNotNone(self.check(session_resets_at="tomorrow")[1])
        self.assertIsNotNone(rq.verify_llm_extraction(["x"], self.RAW, NOW)[1])


class MonitorDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        patcher = mock.patch.object(rq, "get_monitor_dir", return_value=self.tmp.name)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)


def envelope(payload=None, result=None, is_error=False):
    body = {"is_error": is_error, "result": result if result is not None else json.dumps(payload)}
    if payload is not None:
        body["structured_output"] = payload
    return json.dumps(body)


class FallbackTests(MonitorDirCase):
    RAW = fixture("usage-08-format-changed.txt").replace("19 percent", "19%")
    GOOD = {"session_used_percent": 19, "session_resets_phrase": "refresh at eleven forty in the morning",
            "session_resets_at": "2026-10-28T11:40:00+07:00"}

    def raw_good(self):
        return fixture("usage-01-real-mac.txt")

    def run_fallback(self, fake):
        with mock.patch.object(rq, "run_cmd", side_effect=fake) as m:
            result = rq.llm_fallback("/bin/claude", self.RAW_TEXT, NOW)
        return result, m

    def setUp(self):
        super().setUp()
        self.RAW_TEXT = self.raw_good()
        self.good = {"session_used_percent": 19, "session_resets_phrase": "resets Oct 28 at 11:40am (Asia/Saigon)",
                     "session_resets_at": "2026-10-28T11:40:00+07:00"}

    def test_success_uses_haiku_with_schema_and_stdin(self):
        calls = []

        def fake(args, input_text=None, timeout=60):
            calls.append((args, input_text, timeout))
            return 0, envelope(self.good), ""

        (session, reason), _ = self.run_fallback(fake)
        self.assertIsNone(reason)
        self.assertEqual(session["used_percent"], 19.0)
        args, stdin, _ = calls[0]
        self.assertEqual(args[args.index("--model") + 1], "haiku")
        self.assertEqual(args[args.index("--setting-sources") + 1], "")
        self.assertIn("--json-schema", args)
        self.assertIn("Current session: 19% used", stdin)  # text goes through stdin, not argv
        self.assertFalse(any("Current session" in a for a in args))

    def test_result_text_json_is_accepted_when_no_structured_output(self):
        def fake(args, input_text=None, timeout=60):
            return 0, envelope(result="```json\n" + json.dumps(self.good) + "\n```"), ""
        (session, reason), _ = self.run_fallback(fake)
        self.assertIsNone(reason)
        self.assertIsNotNone(session)

    def test_hallucinated_number_is_rejected(self):
        bad = dict(self.good, session_used_percent=27)

        def fake(args, input_text=None, timeout=60):
            return 0, envelope(bad), ""
        (session, reason), _ = self.run_fallback(fake)
        self.assertIsNone(session)
        self.assertIn("percent", reason)

    def test_timeout(self):
        def fake(args, input_text=None, timeout=60):
            raise subprocess.TimeoutExpired(args, timeout)
        (session, reason), _ = self.run_fallback(fake)
        self.assertIsNone(session)
        self.assertIn("timed out", reason)

    def test_non_json_output(self):
        def fake(args, input_text=None, timeout=60):
            return 0, "Sorry, I cannot help with that.", ""
        (session, reason), _ = self.run_fallback(fake)
        self.assertIsNone(session)
        self.assertIn("not valid JSON", reason)

    def test_same_failing_text_is_not_retried_within_6h(self):
        def fake(args, input_text=None, timeout=60):
            return 0, "garbage", ""
        (_, _), m = self.run_fallback(fake)
        self.assertEqual(m.call_count, 1)
        (session, reason), m2 = self.run_fallback(fake)
        self.assertEqual(m2.call_count, 0)
        self.assertIn("skipped", reason)

    def test_three_failures_back_off_even_for_new_text(self):
        def fake(args, input_text=None, timeout=60):
            return 0, "garbage", ""
        for i in range(3):
            with mock.patch.object(rq, "run_cmd", side_effect=fake):
                rq.llm_fallback("/bin/claude", self.RAW_TEXT + f"\nCurrent week: {i}% used", NOW)
        with mock.patch.object(rq, "run_cmd", side_effect=fake) as m:
            session, reason = rq.llm_fallback("/bin/claude", self.RAW_TEXT + "\nCurrent week: 9% used", NOW)
        self.assertEqual(m.call_count, 0)
        self.assertIsNone(session)

    def test_success_resets_the_failure_counter(self):
        with mock.patch.object(rq, "run_cmd", return_value=(0, "garbage", "")):
            rq.llm_fallback("/bin/claude", self.RAW_TEXT, NOW)
        with mock.patch.object(rq, "run_cmd", return_value=(0, envelope(self.good), "")):
            session, _ = rq.llm_fallback("/bin/claude", self.RAW_TEXT + "\nCurrent week: 1% used", NOW)
        self.assertIsNotNone(session)
        state = rq._load_json_file(rq.get_fallback_state_path())["by_email"]["_"]
        self.assertEqual((state["ok"], state["fails"]), (True, 0))
        self.assertEqual(set(state), {"hash", "at", "ok", "fails"})  # no raw text, no secrets

    def test_windows_cmd_shim_skips_fallback(self):
        with mock.patch.object(rq.os, "name", "nt"), mock.patch.object(rq, "run_cmd") as m:
            session, reason = rq.llm_fallback("C:\\npm\\claude.cmd", self.RAW_TEXT, NOW)
        self.assertEqual(m.call_count, 0)
        self.assertIsNone(session)


class CliCallTests(MonitorDirCase):
    def test_usage_text_ok(self):
        with mock.patch.object(rq, "run_cmd", return_value=(0, envelope(result="Current session: 5% used"), "")) as m:
            text, failure = rq.fetch_usage_text("/bin/claude")
        self.assertEqual((text, failure), ("Current session: 5% used", None))
        self.assertEqual(m.call_args[0][0][:4], ["/bin/claude", "-p", "/usage", "--output-format"])
        self.assertNotIn("--model", m.call_args[0][0])

    def test_usage_timeout_twice_reports_usage_timeout_with_diag(self):
        with mock.patch.object(rq, "run_cmd", side_effect=subprocess.TimeoutExpired("claude", 60)) as m, \
                mock.patch.object(rq.time, "sleep") as sleep:
            text, failure = rq.fetch_usage_text("/bin/claude")
        self.assertIsNone(text)
        self.assertEqual(failure[0], "usage_timeout")
        self.assertIn("load avg", failure[1])
        self.assertEqual((m.call_count, sleep.call_args[0][0]), (2, rq.USAGE_RETRY_WAIT_SEC))

    def test_usage_timeout_then_success_retries_once_without_error(self):
        ok = (0, envelope(result="Current session: 5% used"), "")
        with mock.patch.object(rq, "run_cmd", side_effect=[subprocess.TimeoutExpired("claude", 60), ok]) as m, \
                mock.patch.object(rq.time, "sleep") as sleep:
            text, failure = rq.fetch_usage_text("/bin/claude")
        self.assertEqual((text, failure), ("Current session: 5% used", None))
        self.assertEqual((m.call_count, sleep.call_count), (2, 1))

    def test_usage_runs_at_normal_priority_and_worst_case_fits_lock_and_interval(self):
        with mock.patch.object(rq, "run_cmd", return_value=(0, envelope(result="x"), "")) as m:
            rq.fetch_usage_text("/bin/claude")
        self.assertFalse(m.call_args[1].get("low_priority"))
        worst = (rq.MAX_JITTER_SEC + rq.UPDATE_BUDGET_SEC + 2 * rq.USAGE_TIMEOUT_SEC + rq.USAGE_RETRY_WAIT_SEC
                 + 2 * rq.AUTH_STATUS_TIMEOUT_SEC + rq.FALLBACK_TIMEOUT_SEC + rq.CLAUDE_PROBE_BUDGET_SEC)
        self.assertLess(worst, rq.LOCK_STALE_SEC)
        self.assertLess(rq.LOCK_STALE_SEC, rq.REPORT_INTERVAL_SEC)
        self.assertLess(worst, rq.REPORT_INTERVAL_SEC)

    def test_usage_not_logged_in(self):
        out = envelope(result="Not logged in · Please run /login", is_error=True)
        with mock.patch.object(rq, "run_cmd", return_value=(1, out, "")):
            text, failure = rq.fetch_usage_text("/bin/claude")
        self.assertEqual((failure[0], failure[2]), ("auth_required", "auth_required"))

    def test_usage_nonzero_exit_and_garbage(self):
        with mock.patch.object(rq, "run_cmd", return_value=(2, "boom", "segfault")):
            self.assertEqual(rq.fetch_usage_text("/bin/claude")[1][0], "claude_failed")
        with mock.patch.object(rq, "run_cmd", return_value=(0, "not json", "")):
            self.assertEqual(rq.fetch_usage_text("/bin/claude")[1][0], "claude_failed")

    def test_account_from_auth_status(self):
        out = json.dumps({"loggedIn": True, "email": "Dev@Example.com", "orgId": "x"})
        with mock.patch.object(rq, "run_cmd", return_value=(0, out, "")):
            self.assertEqual(rq.get_account("/bin/claude"), (True, "dev@example.com"))

    def test_account_logged_out_and_config_fallback(self):
        out = json.dumps({"loggedIn": False})
        with mock.patch.object(rq, "run_cmd", return_value=(1, out, "")), \
                mock.patch.object(rq, "read_config_email", return_value="a@b.co"):
            self.assertEqual(rq.get_account("/bin/claude"), (False, "a@b.co"))
        with mock.patch.object(rq, "run_cmd", side_effect=OSError("x")), \
                mock.patch.object(rq, "read_config_email", return_value="a@b.co"):
            self.assertEqual(rq.get_account("/bin/claude"), (None, "a@b.co"))

    def test_config_email_reads_only_the_email_key(self):
        cfg = os.path.join(self.tmp.name, ".claude.json")
        with open(cfg, "w") as f:
            json.dump({"oauthAccount": {"emailAddress": "X@Y.io", "accessToken": "SECRET"}}, f)
        with mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": self.tmp.name}):
            self.assertEqual(rq.read_config_email(), "x@y.io")

    def test_lock_prevents_overlap_and_recovers_when_stale(self):
        first = rq.acquire_lock()
        self.assertIsNotNone(first)
        self.assertIsNone(rq.acquire_lock())
        old = os.path.getmtime(first) - rq.LOCK_STALE_SEC - 5
        os.utime(first, (old, old))
        self.assertIsNotNone(rq.acquire_lock())
        rq.release_lock(first)

    def test_find_claude_returns_none_when_it_is_not_installed(self):
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(rq.shutil, "which", return_value=None), \
                mock.patch.object(rq.os.path, "isfile", return_value=False):
            os.environ.pop("CLAUDE_QUOTA_CLAUDE_BIN", None)
            self.assertIsNone(rq.find_claude())

    def test_find_claude_override(self):
        fake = os.path.join(self.tmp.name, "claude")
        open(fake, "w").close()
        with mock.patch.dict(os.environ, {"CLAUDE_QUOTA_CLAUDE_BIN": fake}):
            self.assertEqual(rq.find_claude(), fake)

    def test_find_claude_in_local_node_dir(self):
        # cron's PATH has no ~/.local/node24/bin, so the fallback search must cover it.
        fake = os.path.join(self.tmp.name, ".local", "node24", "bin", "claude")
        os.makedirs(os.path.dirname(fake))
        open(fake, "w").close()
        with mock.patch.dict(os.environ, {"HOME": self.tmp.name}), \
                mock.patch.object(rq.shutil, "which", return_value=None), \
                mock.patch.object(rq.os.path, "isfile", side_effect=lambda p: p == fake):
            os.environ.pop("CLAUDE_QUOTA_CLAUDE_BIN", None)
            self.assertEqual(rq.find_claude(), fake)

    def _file(self, *parts, size=10):
        path = os.path.join(self.tmp.name, *parts)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(b"x" * size)
        return path

    def test_find_claude_skips_a_broken_first_hit_and_remembers_the_working_one(self):
        # Windows: PATH's first claude is npm's shim to a placeholder claude.exe that Windows refuses to run.
        broken, good = self._file("nodejs", "claude.cmd"), self._file(".local", "bin", "claude.exe")
        fail = (1, "", "This version of claude.exe is not compatible with the version of Windows you're running.")

        def run(args, **kwargs):
            return (0, "2.1.318 (Claude Code)\n", "") if args[0] == good else fail
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(rq, "claude_candidates", return_value=[broken, good]), \
                mock.patch.object(rq, "run_cmd", side_effect=run) as m:
            os.environ.pop("CLAUDE_QUOTA_CLAUDE_BIN", None)
            self.assertEqual(rq.find_claude(), good)
            self.assertEqual([c[0][0] for c in m.call_args_list], [[broken, "--version"], [good, "--version"]])
            self.assertIsNone(rq.CLAUDE_LOOKUP["diag"])
            m.reset_mock()
            self.assertEqual(rq.find_claude(), good)  # remembered: no probe on the next run
            self.assertEqual(m.call_count, 0)

    def test_find_claude_still_returns_a_broken_install_with_a_diag(self):
        # Installed but broken must keep sending claude_failed (never look uninstalled), with what was found.
        stub = self._file("nodejs", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe", size=0)
        shim = self._file("nodejs", "claude.cmd", size=345)
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(rq, "claude_candidates", return_value=[shim, stub]), \
                mock.patch.object(rq, "run_cmd", return_value=(1, "", "not compatible")) as m:
            os.environ.pop("CLAUDE_QUOTA_CLAUDE_BIN", None)
            self.assertEqual(rq.find_claude(), shim)
        self.assertEqual(m.call_count, 1)  # the 0-byte placeholder is never run
        diag = rq.CLAUDE_LOOKUP["diag"]
        self.assertIn("found 2", diag)
        self.assertIn("claude.cmd 345B", diag)
        self.assertIn("claude.exe 0B", diag)
        self.assertLess(len(diag), 200)
        self.assertFalse(os.path.exists(rq.get_claude_cache_path()))

    def test_find_claude_does_not_trust_a_remembered_path_that_became_a_placeholder(self):
        good = self._file(".local", "bin", "claude")
        rq._save_json_file(rq.get_claude_cache_path(), {"path": self._file("old", "claude", size=0)}, "t")
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(rq, "claude_candidates", return_value=[good]), \
                mock.patch.object(rq, "run_cmd", return_value=(0, "2.1.318 (Claude Code)", "")):
            os.environ.pop("CLAUDE_QUOTA_CLAUDE_BIN", None)
            self.assertEqual(rq.find_claude(), good)

    def test_candidates_include_npm_platform_binaries_after_the_path_hit(self):
        home = self.tmp.name
        prefix_bin = os.path.join(home, "nodejs")
        shim = self._file("nodejs", "claude", size=300)
        scope = ("nodejs", "node_modules", "@anthropic-ai")
        nested = self._file(*scope, "claude-code", "node_modules", "@anthropic-ai", "claude-code-x-y", "claude")
        hoisted = self._file(*scope, "claude-code-x-z", "claude")
        placeholder = self._file(*scope, "claude-code", "bin", "claude.exe", size=0)
        unix_layout = self._file("usr", "lib", "node_modules", "@anthropic-ai", "claude-code-u", "claude")
        os.makedirs(os.path.join(home, "usr", "bin"))
        with mock.patch.dict(os.environ, {"HOME": home, "PATH": os.pathsep.join([prefix_bin, os.path.join(home, "usr", "bin")])}), \
                mock.patch.object(rq.shutil, "which", return_value=shim):
            found = rq.claude_candidates()
        self.assertEqual(found[0], shim)
        for p in (nested, hoisted, placeholder, unix_layout):
            self.assertIn(p, found)
        self.assertEqual(len(found), len(set(found)))


class RunOnceBase(MonitorDirCase):
    def setUp(self):
        super().setUp()
        env = mock.patch.dict(os.environ, {"CLAUDE_QUOTA_NO_JITTER": "1"})
        env.start()
        self.addCleanup(env.stop)
        self.posted = []

        def post(payload):
            self.posted.append(payload)
            return True, 200, '{"success":true}'
        for target, kwargs in (
            ("find_claude", {"return_value": "/bin/claude"}),
            ("get_account", {"return_value": (True, "dev@example.com")}),
            ("get_claude_version", {"return_value": "2.1.312"}),
            ("post_to_worker", {"side_effect": post}),
        ):
            p = mock.patch.object(rq, target, **kwargs)
            p.start()
            self.addCleanup(p.stop)

    def run_with_text(self, text):
        with mock.patch.object(rq, "fetch_usage_text", return_value=(text, None)):
            return rq.run_once()


class RunOnceTests(RunOnceBase):
    def test_happy_path_payload_matches_server_contract(self):
        self.assertEqual(self.run_with_text(fixture("usage-01-real-mac.txt")), 0)
        p = self.posted[0]
        self.assertEqual((p["email"], p["used_percent"], p["token_state"], p["client_version"]),
                         ("dev@example.com", 19.0, "ok", rq.CLIENT_VERSION))
        self.assertTrue(p["machine_name"])
        self.assertTrue(p["os"])
        self.assertLessEqual(len(p["machine_name"]), 64)
        self.assertEqual(p["parse_source"], "regex")
        self.assertNotIn("low_confidence", p)
        self.assertTrue(p["machine_id"])
        self.assertIsInstance(p["fetched_at"], int)
        self.assertEqual(p["limits"][0]["group"], "weekly")
        self.assertEqual(p["limits"][0]["scope_name"], "Fable")
        self.assertEqual(rq.load_last_state()["email"], "dev@example.com")

    def test_unparsable_text_without_working_fallback_sends_parse_error_not_zero(self):
        with mock.patch.object(rq, "run_cmd", return_value=(0, "garbage", "")):
            self.assertEqual(self.run_with_text(fixture("usage-08-format-changed.txt")), 1)
        p = self.posted[0]
        self.assertEqual(p["error_kind"], "parse_error")
        self.assertNotIn("used_percent", p)

    def test_fallback_success_is_marked_low_confidence(self):
        failed = {"parse_status": "failed", "session": None, "weekly": [], "raw_sha": "abc", "claude_version": None}
        verified = ({"used_percent": 19.0, "resets_at": "2026-10-28T04:40:00+00:00"}, None)
        with mock.patch.object(rq, "parse_usage_text", return_value=failed), \
                mock.patch.object(rq, "llm_fallback", return_value=verified) as fb:
            self.assertEqual(self.run_with_text("whatever the text is"), 0)
        self.assertEqual(fb.call_count, 1)
        p = self.posted[0]
        self.assertEqual((p["parse_source"], p["low_confidence"], p["parse_status"]), ("llm_fallback", True, "llm_verified"))
        self.assertEqual((p["used_percent"], p["limits"]), (19.0, []))

    def test_claude_failure_sends_error_report(self):
        with mock.patch.object(rq, "fetch_usage_text", return_value=(None, ("usage_timeout", "timed out", None))):
            self.assertEqual(rq.run_once(), 1)
        self.assertEqual(self.posted[0]["error_kind"], "usage_timeout")
        self.assertNotIn("used_percent", self.posted[0])

    def test_logged_out_reports_auth_required(self):
        with mock.patch.object(rq, "get_account", return_value=(False, "dev@example.com")):
            self.assertEqual(rq.run_once(), 1)
        p = self.posted[0]
        self.assertEqual((p["token_state"], p["error_kind"]), ("auth_required", "auth_required"))

    def test_missing_email_never_posts(self):
        with mock.patch.object(rq, "get_account", return_value=(True, None)):
            self.assertEqual(rq.run_once(), 1)
        self.assertEqual(self.posted, [])

    def test_claude_failed_forgets_the_remembered_path_and_leads_with_the_lookup_diag(self):
        rq._save_json_file(rq.get_claude_cache_path(), {"path": "/bin/claude"}, "t")

        def lookup():
            rq.CLAUDE_LOOKUP["diag"] = "no claude answered --version; found 1: bin/claude 0B"
            return "/bin/claude"
        failure = ("claude_failed", "`claude -p /usage` failed (exit 1): " + "x" * 200, None)
        with mock.patch.object(rq, "find_claude", side_effect=lookup), \
                mock.patch.object(rq, "fetch_usage_text", return_value=(None, failure)):
            self.assertEqual(rq.run_once(), 1)
        p = self.posted[0]
        self.assertEqual(p["error_kind"], "claude_failed")
        self.assertTrue(p["error"].startswith("no claude answered --version; found 1: bin/claude 0B"))
        self.assertFalse(os.path.exists(rq.get_claude_cache_path()))

    def test_missing_claude_binary_sends_nothing(self):
        # Only installed CLIs are reported: no error report and no numbers for a missing claude.
        with mock.patch.object(rq, "find_claude", return_value=None), \
                mock.patch.object(rq, "read_config_email", return_value="dev@example.com"):
            self.assertEqual(rq.run_once(), 0)
        self.assertEqual(self.posted, [])

    def test_detect_flag_prints_the_binary_path_or_nothing(self):
        env = dict(os.environ, CLAUDE_QUOTA_CLAUDE_BIN=sys.executable)
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "client", "report_quota.py"), "--detect"],
                              capture_output=True, text=True, timeout=20, env=env)
        self.assertEqual((proc.returncode, proc.stdout.strip()), (0, sys.executable))

    def test_detect_prints_only_the_path_even_when_the_found_claude_does_not_run(self):
        # The setup scripts take --detect's whole stdout as the path: probe diag lines must not leak into it.
        home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, home, True)
        os.makedirs(os.path.join(home, "bin"))
        open(os.path.join(home, "bin", "claude"), "w").close()  # a 0-byte placeholder, like npm's
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_QUOTA_CLAUDE_BIN"}
        env.update(HOME=home, USERPROFILE=home, PATH=os.path.join(home, "bin"))
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "client", "report_quota.py"), "--detect"],
                              capture_output=True, text=True, timeout=60, env=env)
        self.assertEqual((proc.returncode, len(proc.stdout.splitlines()), proc.stderr), (0, 1, ""))
        self.assertTrue(os.path.isfile(proc.stdout.strip()))

    def test_version_prefix_is_ignored_when_comparing(self):
        self.assertEqual(rq.parse_version("agy-1.10"), (1, 10))
        self.assertGreater(rq.parse_version("agy-1.10"), rq.parse_version("agy-1.9"))
        self.assertIsNone(rq.parse_version("garbage"))

    def test_client_does_not_touch_tokens_or_anthropic_api(self):
        with open(os.path.join(ROOT, "client", "report_quota.py"), encoding="utf-8") as f:
            src = f.read()
        for forbidden in ("api.anthropic.com", "find-generic-password", "accessToken", ".token_cache",
                          "Credential Manager", "secret-tool"):
            self.assertNotIn(forbidden, src, forbidden)


class AccountSwitchTests(RunOnceBase):
    """The logged-in account can change while a run is in progress; a measurement must never be posted
    under another account's email."""
    TEXT = None

    def run_with_accounts(self, accounts, fetches=None):
        seq = list(accounts)

        def account(_bin):
            return seq.pop(0) if len(seq) > 1 else seq[0]
        fetch = mock.Mock(side_effect=fetches or [(fixture("usage-01-real-mac.txt"), None)] * 4)
        with mock.patch.object(rq, "get_account", side_effect=account), \
                mock.patch.object(rq, "fetch_usage_text", fetch):
            return rq.run_once(), fetch

    def test_stable_account_posts_once_without_retry(self):
        rc, fetch = self.run_with_accounts([(True, "a@x.io")] * 3)
        self.assertEqual((rc, fetch.call_count), (0, 1))
        self.assertEqual(self.posted[0]["email"], "a@x.io")

    def test_switch_during_fetch_is_retried_and_posted_for_the_new_account(self):
        # first read A, after-fetch read B (switched), after-retry read B
        rc, fetch = self.run_with_accounts([(True, "a@x.io"), (True, "b@x.io"), (True, "b@x.io")])
        self.assertEqual((rc, fetch.call_count), (0, 2))
        self.assertEqual([p["email"] for p in self.posted], ["b@x.io"])

    def test_keeps_switching_posts_nothing(self):
        rc, fetch = self.run_with_accounts([(True, "a@x.io"), (True, "b@x.io"), (True, "a@x.io")])
        self.assertEqual(rc, 1)
        self.assertEqual(self.posted, [])

    def test_email_missing_after_switch_posts_nothing_and_ignores_cached_email(self):
        rq.save_last_state("a@x.io", 40.0, "2026-10-28T04:40:00+00:00")
        rc, fetch = self.run_with_accounts([(True, "a@x.io"), (True, None), (True, None)])
        self.assertEqual(rc, 1)
        self.assertEqual(self.posted, [])

    def test_no_email_at_start_never_uses_cached_email_for_data(self):
        rq.save_last_state("a@x.io", 40.0, "2026-10-28T04:40:00+00:00")
        rc, fetch = self.run_with_accounts([(True, None)])
        self.assertEqual((rc, fetch.call_count, self.posted), (1, 0, []))

    def test_failure_report_goes_to_the_confirmed_account_only(self):
        rc, _ = self.run_with_accounts([(True, "a@x.io")] * 3,
                                       fetches=[(None, ("usage_timeout", "timed out", None))])
        self.assertEqual(rc, 1)
        self.assertEqual([(p["email"], p["error_kind"]) for p in self.posted], [("a@x.io", "usage_timeout")])

    def test_cached_email_only_for_fresh_error_reports(self):
        rq.save_last_state("a@x.io", 40.0, "2026-10-28T04:40:00+00:00")
        self.assertEqual(rq.recent_verified_email(), "a@x.io")
        state = rq.load_last_state()
        state["verified_at"] = rq.time.time() - rq.EMAIL_TRUST_SEC - 60
        rq._save_json_file(rq.get_state_file_path(), state, "t")
        self.assertIsNone(rq.recent_verified_email())

    def test_state_is_per_account(self):
        rq.save_last_state("a@x.io", 100.0, "2099-01-01T00:00:00+00:00")
        with mock.patch.object(rq, "read_config_email", return_value="b@x.io"):
            self.assertFalse(rq.check_overload_suppression())
        with mock.patch.object(rq, "read_config_email", return_value="a@x.io"):
            self.assertTrue(rq.check_overload_suppression())
        self.assertEqual(sorted(rq.load_last_state()["by_email"]), ["a@x.io"])

    def test_old_flat_state_is_migrated(self):
        rq._save_json_file(rq.get_state_file_path(), {"email": "a@x.io", "used_percent": 5, "resets_at": "x",
                                                      "last_reported_at": "y"}, "t")
        self.assertEqual(rq.load_last_state()["by_email"]["a@x.io"]["used_percent"], 5)

    def test_fallback_backoff_is_per_account(self):
        raw = "same text"
        for _ in range(rq.FALLBACK_MAX_FAILS):
            rq.record_fallback(raw, False, email="a@x.io")
        self.assertFalse(rq.fallback_allowed("other text", email="a@x.io"))
        self.assertTrue(rq.fallback_allowed("other text", email="b@x.io"))


FAKE_GH = """#!{python}
import os, sys
d = os.environ["FAKE_GH_DIR"]
endpoint = [a for a in sys.argv[2:] if a.startswith("repos/")][0]
kind = "commits" if "/commits?" in endpoint else "source"
err = os.path.join(d, kind + ".err")
if os.path.exists(err):
    sys.stderr.write(open(err).read())
    sys.exit(1)
sys.stdout.write(open(os.path.join(d, "commits.json" if kind == "commits" else "source.py")).read())
"""


def with_version(source, version):
    return source.replace('CLIENT_VERSION = "%s"' % rq.CLIENT_VERSION, 'CLIENT_VERSION = "%s"' % version, 1)


class SelfUpdateTests(MonitorDirCase):
    def setUp(self):
        super().setUp()
        self.gh_dir = tempfile.mkdtemp(dir=self.tmp.name)
        self.install = tempfile.mkdtemp(dir=self.tmp.name)
        self.script = os.path.join(self.install, "report_quota.py")
        with open(os.path.join(ROOT, "client", "report_quota.py"), "r", encoding="utf-8", newline="") as f:
            self.local_source = f.read()
        with open(self.script, "w", encoding="utf-8", newline="") as f:
            f.write(self.local_source)
        gh = os.path.join(self.gh_dir, "gh")
        with open(gh, "w") as f:
            f.write(FAKE_GH.format(python=sys.executable))
        os.chmod(gh, 0o755)
        env = mock.patch.dict(os.environ, {"CLAUDE_QUOTA_GH_BIN": gh, "FAKE_GH_DIR": self.gh_dir}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        for k in ("CLAUDE_QUOTA_NO_UPDATE", "CLAUDE_QUOTA_UPDATED", "CLAUDE_QUOTA_UPDATED_FROM"):
            os.environ.pop(k, None)

    def serve(self, source, verified=True, sha="abc123"):
        with open(os.path.join(self.gh_dir, "source.py"), "w", encoding="utf-8", newline="") as f:
            f.write(source)
        commit = [{"sha": sha, "commit": {"verification": {"verified": verified, "reason": "valid" if verified else "unsigned"}}}]
        with open(os.path.join(self.gh_dir, "commits.json"), "w") as f:
            json.dump(commit, f)

    def age_state(self, mutate):
        path = rq.get_update_state_path()
        with open(path, "r", encoding="utf-8") as f:
            state = json.load(f)
        mutate(state)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(state, f)

    def installed(self):
        with open(self.script, "r", encoding="utf-8", newline="") as f:
            return f.read()

    def test_new_verified_version_is_swapped_and_backup_kept(self):
        newer = with_version(self.local_source, "9.9")
        self.serve(newer)
        self.assertEqual(rq.self_update(self.script), ("updated_from_" + rq.CLIENT_VERSION, True))
        self.assertEqual(self.installed(), newer)
        with open(self.script + ".prev", "r", encoding="utf-8", newline="") as f:
            self.assertEqual(f.read(), self.local_source)
        self.assertFalse(os.path.exists(self.script + ".new"))

    def test_report_restarts_the_new_file_after_a_swap(self):
        self.serve(with_version(self.local_source, "9.9"))
        with mock.patch.object(rq, "get_work_dir", return_value=self.install), \
                mock.patch.object(rq, "check_overload_suppression", return_value=False), \
                mock.patch.object(rq, "self_update", return_value=("updated_from_" + rq.CLIENT_VERSION, True)), \
                mock.patch.object(rq, "reexec_after_update", side_effect=SystemExit(0)) as reexec:
            with self.assertRaises(SystemExit):
                rq.report()
        reexec.assert_called_once()
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "run.lock")), "lock handed over before the restart")

    def test_restarted_process_does_not_check_again_and_reports_the_update(self):
        with mock.patch.dict(os.environ, {"CLAUDE_QUOTA_UPDATED": "1", "CLAUDE_QUOTA_UPDATED_FROM": "3.3"}):
            self.assertEqual(rq.self_update(self.script), ("updated_from_3.3", False))

    def test_unverified_commit_is_not_applied_and_not_retried_for_24h(self):
        self.serve(with_version(self.local_source, "9.9"), verified=False)
        self.assertEqual(rq.self_update(self.script), ("unverified_commit", False))
        self.assertEqual(self.installed(), self.local_source)
        # a new check is allowed after 6 h, but the same sha stays suppressed until 24 h passed
        self.age_state(lambda st: st.update(checked_at=st["checked_at"] - rq.UPDATE_CHECK_SEC - 5))
        self.serve(with_version(self.local_source, "9.9"), verified=True)  # same sha "abc123"
        self.assertEqual(rq.self_update(self.script), ("unverified_commit", False))
        self.assertEqual(self.installed(), self.local_source)
        def age(st):
            st["checked_at"] -= rq.UPDATE_CHECK_SEC + 5
            st["failed"]["abc123"]["at"] -= rq.UPDATE_RETRY_SAME_SHA_SEC + 5
        self.age_state(age)
        self.assertEqual(rq.self_update(self.script)[1], True)

    def test_release_that_changes_worker_url_or_update_repo_is_rejected(self):
        import re as _re
        for const, value in (("DEFAULT_WORKER_URL", "https://claude-quota-monitor.your-worker.workers.dev/update"),
                             ("UPDATE_REPO", "your-org/claude-quota-monitor")):
            with self.subTest(const=const):
                changed = _re.sub(r'^' + const + r' = "[^"]*"', const + ' = "' + value + '"',
                                  with_version(self.local_source, "9.9"), flags=_re.M)
                self.assertNotEqual(changed, with_version(self.local_source, "9.9"))
                self.serve(changed, sha="sha-" + const)
                self.assertEqual(rq.self_update(self.script), ("failed:identity_changed", False))
                self.assertEqual(self.installed(), self.local_source)

    def test_broken_python_keeps_the_old_file(self):
        self.serve(with_version(self.local_source, "9.9") + "\ndef broken(:\n")
        self.assertEqual(rq.self_update(self.script), ("failed:syntax", False))
        self.assertEqual(self.installed(), self.local_source)
        self.assertFalse(os.path.exists(self.script + ".new"))

    def test_file_that_fails_the_version_smoke_test_keeps_the_old_file(self):
        bad = with_version(self.local_source, "9.9").replace('    if "--version" in sys.argv[1:]:', '    if False:')
        self.serve(bad)
        self.assertEqual(rq.self_update(self.script), ("failed:smoke_test", False))
        self.assertEqual(self.installed(), self.local_source)

    def test_gh_missing(self):
        with mock.patch.dict(os.environ, {"CLAUDE_QUOTA_GH_BIN": os.path.join(self.gh_dir, "nope")}), \
                mock.patch.object(rq.shutil, "which", return_value=None), \
                mock.patch.object(rq.os.path, "isfile", side_effect=lambda p: False if p.endswith("gh") else os.path.exists(p)):
            self.assertEqual(rq.self_update(self.script), ("gh_missing", False))
        self.assertEqual(self.installed(), self.local_source)

    def test_gh_not_authenticated(self):
        with open(os.path.join(self.gh_dir, "commits.err"), "w") as f:
            f.write("To get started with GitHub CLI, please run:  gh auth login\n")
        self.assertEqual(rq.self_update(self.script), ("gh_unauthenticated", False))

    def test_offline_and_rate_limit_are_classified(self):
        self.assertEqual(rq.classify_gh_error("dial tcp: lookup api.github.com: no such host"), "failed:offline")
        self.assertEqual(rq.classify_gh_error("gh: API rate limit exceeded (HTTP 403)"), "failed:rate_limited")
        self.assertEqual(rq.classify_gh_error("gh: Not Found (HTTP 404)"), "failed:no_access")

    def test_identical_content_is_a_no_op_even_with_crlf(self):
        self.serve(self.local_source.replace("\n", "\r\n"), verified=False)
        self.assertEqual(rq.self_update(self.script), ("current", False))
        self.assertFalse(os.path.exists(self.script + ".prev"))

    def test_lower_remote_version_is_never_applied(self):
        self.serve(with_version(self.local_source, "1.0") + "\n# older\n")
        self.assertEqual(rq.self_update(self.script), ("current", False))
        self.assertEqual(self.installed(), self.local_source)

    def test_checks_at_most_every_6_hours_and_reports_the_last_status(self):
        self.serve(self.local_source)
        self.assertEqual(rq.self_update(self.script), ("current", False))
        os.remove(os.path.join(self.gh_dir, "commits.json"))  # a second real check would now fail
        self.assertEqual(rq.self_update(self.script), ("current", False))

    def test_disabled_by_env_or_marker_file(self):
        self.serve(with_version(self.local_source, "9.9"))
        with mock.patch.dict(os.environ, {"CLAUDE_QUOTA_NO_UPDATE": "1"}):
            self.assertEqual(rq.self_update(self.script), ("disabled", False))
        open(os.path.join(self.tmp.name, "no_update"), "w").close()
        self.assertEqual(rq.self_update(self.script), ("disabled", False))
        self.assertEqual(self.installed(), self.local_source)

    def test_never_raises(self):
        with mock.patch.object(rq, "find_gh", side_effect=RuntimeError("boom")):
            status, swapped = rq.self_update(self.script)
        self.assertTrue(status.startswith("failed:") and not swapped)

    def test_update_status_is_in_both_payloads(self):
        rq.UPDATE_INFO["status"] = "gh_missing"
        self.addCleanup(rq.UPDATE_INFO.update, {"status": None})
        with mock.patch.object(rq, "get_machine_id", return_value="m1"):
            payload = rq.build_payload("a@x.io", {"used_percent": 5.0, "resets_at": "2026-10-28T04:40:00+00:00"}, [], 1, "regex", "ok")
            sent = []
            with mock.patch.object(rq, "post_to_worker", side_effect=lambda p: sent.append(p) or (True, 200, "")):
                rq.send_error_report("a@x.io", "usage_timeout", "slow")
        self.assertEqual(payload["update_status"], "gh_missing")
        self.assertEqual(sent[0]["update_status"], "gh_missing")

    def test_version_flag_prints_the_version_and_exits_without_side_effects(self):
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "client", "report_quota.py"), "--version"],
                              capture_output=True, text=True, timeout=20)
        self.assertEqual((proc.returncode, proc.stdout.strip()), (0, rq.CLIENT_VERSION))


class TestAdaptiveInterval(unittest.TestCase):
    def test_bounds_and_clamping(self):
        self.assertEqual(rq.compute_adaptive_interval(0.0), rq.MAX_REPORT_INTERVAL_SEC)
        self.assertEqual(rq.compute_adaptive_interval(-5.0), rq.MAX_REPORT_INTERVAL_SEC)
        self.assertEqual(rq.compute_adaptive_interval(None), rq.MAX_REPORT_INTERVAL_SEC)
        self.assertEqual(rq.compute_adaptive_interval(1000.0), rq.MIN_REPORT_INTERVAL_SEC)
        self.assertGreaterEqual(rq.compute_adaptive_interval(50.0), rq.MIN_REPORT_INTERVAL_SEC)
        self.assertLessEqual(rq.compute_adaptive_interval(50.0), rq.MAX_REPORT_INTERVAL_SEC)

    def test_monotonic_interval_decrease(self):
        rates = [0.0, 1.0, 5.0, 10.0, 20.0, 30.0, 50.0, 75.0, 100.0, 200.0]
        intervals = [rq.compute_adaptive_interval(r, 50.0) for r in rates]
        for i in range(len(intervals) - 1):
            self.assertGreaterEqual(intervals[i], intervals[i + 1],
                                    f"Rate {rates[i]} gave interval {intervals[i]} which is not >= {intervals[i+1]} for rate {rates[i+1]}")

    def test_high_utilization_urgency(self):
        normal_int = rq.compute_adaptive_interval(25.0, used_percent=50.0)
        urgent_int = rq.compute_adaptive_interval(25.0, used_percent=95.0)
        self.assertLessEqual(urgent_int, normal_int)
        self.assertLessEqual(urgent_int, 180)

    def test_account_isolation_in_burn_rate(self):
        t0 = 1700000000.0
        entry_a = {}
        rate_a, int_a, s_a = rq.update_account_burn_rate(entry_a, 10.0, "2026-10-28T04:00:00Z", t0)
        entry_a = {"samples": s_a, "burn_rate": rate_a}
        # Account A burns 30% in 1 hour -> rate ~30%/h
        rate_a2, int_a2, s_a2 = rq.update_account_burn_rate(entry_a, 40.0, "2026-10-28T04:00:00Z", t0 + 3600.0)
        self.assertGreater(rate_a2, 20.0)
        self.assertLess(int_a2, 350)

        # Account B is fresh on the same machine
        entry_b = {}
        rate_b, int_b, s_b = rq.update_account_burn_rate(entry_b, 5.0, "2026-10-28T06:00:00Z", t0 + 3600.0)
        # Account B must NOT use Account A's used (40%) to calculate negative rate!
        self.assertEqual(rate_b, 0.0)
        self.assertEqual(int_b, rq.MAX_REPORT_INTERVAL_SEC)

    def test_window_reset_no_negative_burn_rate(self):
        t0 = 1700000000.0
        entry = {}
        r1, _, s1 = rq.update_account_burn_rate(entry, 95.0, "2026-10-28T04:00:00Z", t0)
        entry = {"samples": s1, "burn_rate": r1}
        # After reset, used drops to 5% with new reset time
        r2, int2, s2 = rq.update_account_burn_rate(entry, 5.0, "2026-10-28T09:00:00Z", t0 + 600.0)
        self.assertGreaterEqual(r2, 0.0)
        self.assertGreaterEqual(int2, rq.MIN_REPORT_INTERVAL_SEC)

    def test_asymmetric_ema_fast_attack_and_smooth_decay(self):
        t0 = 1700000000.0
        entry = {"burn_rate": 0.0, "samples": [{"ts": t0, "used": 10.0, "resets_at": "R"}]}
        # Sudden spike: 20% burned in 15 minutes = 80%/h
        r_spike, int_spike, s_spike = rq.update_account_burn_rate(entry, 30.0, "R", t0 + 900.0)
        self.assertGreaterEqual(r_spike, 60.0)
        self.assertLessEqual(int_spike, 160)

        # Then no usage for next 15 minutes (0%/h instant) -> decays gradually
        entry_decay = {"burn_rate": r_spike, "samples": s_spike}
        r_decay, int_decay, s_decay = rq.update_account_burn_rate(entry_decay, 30.0, "R", t0 + 1800.0)
        self.assertLess(r_decay, r_spike)
        self.assertGreater(r_decay, 0.0)
        self.assertGreater(int_decay, int_spike)

    def test_check_adaptive_interval_timing(self):
        tmp_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp_dir)
        state_file = os.path.join(tmp_dir, "last_state.json")
        now = time.time()
        # Account logged in right now
        test_state = {
            "email": "test@x.io",
            "by_email": {
                "test@x.io": {
                    "last_reported_ts": now - 60.0,  # 60s ago
                    "next_interval_sec": 300,        # interval is 300s (5m)
                    "burn_rate": 15.0,
                }
            }
        }
        with open(state_file, "w") as f:
            json.dump(test_state, f)

        with mock.patch.object(rq, "get_state_file_path", return_value=state_file), \
                mock.patch.object(rq, "read_config_email", return_value="test@x.io"), \
                mock.patch.dict(os.environ, {"TEST_ADAPTIVE_CHECK": "1"}):
            should_run, remaining, reason = rq.check_adaptive_interval()
            self.assertFalse(should_run)
            self.assertGreater(remaining, 200)

            # If 310s elapsed, interval is met
            test_state["by_email"]["test@x.io"]["last_reported_ts"] = now - 310.0
            with open(state_file, "w") as f:
                json.dump(test_state, f)
            should_run, remaining, reason = rq.check_adaptive_interval()
            self.assertTrue(should_run)


class CodexCompanionTests(MonitorDirCase):
    """report_quota.py downloads report_codex.py on a machine that has codex and runs it beside the Claude job."""

    def setUp(self):
        super().setUp()
        self.script = os.path.join(self.tmp.name, "report_codex.py")
        env = mock.patch.dict(os.environ, {}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        for var in ("CLAUDE_QUOTA_NO_UPDATE", "CLAUDE_QUOTA_NO_CODEX"):
            os.environ.pop(var, None)
        self.installed = mock.patch.object(rq, "cli_installed", return_value=True)
        self.installed.start()
        self.addCleanup(self.installed.stop)

    def real_script(self):
        with open(self.script, "w") as f:
            f.write('CODEX_CLIENT_VERSION = "codex-1.0"\nprint("real")\n')

    def test_nothing_happens_without_codex(self):
        with mock.patch.object(rq, "cli_installed", return_value=False), \
                mock.patch.object(rq, "self_update") as up, mock.patch.object(rq, "run_cmd") as run:
            rq.run_codex_companion()
        self.assertEqual((up.call_count, run.call_count, os.path.exists(self.script)), (0, 0, False))

    def test_update_opt_out_also_blocks_the_download(self):
        with mock.patch.dict(os.environ, {"CLAUDE_QUOTA_NO_UPDATE": "1"}), \
                mock.patch.object(rq, "self_update") as up, mock.patch.object(rq, "run_cmd") as run:
            rq.run_codex_companion()
        self.assertEqual((up.call_count, run.call_count, os.path.exists(self.script)), (0, 0, False))

    def test_missing_script_is_downloaded_with_the_verified_update_path_then_run(self):
        def fake_update(path, **kw):
            self.assertIn("codex-0.0", open(path).read())  # the harmless placeholder stands in until the swap
            with open(path, "w") as f:
                f.write('CODEX_CLIENT_VERSION = "codex-1.0"\n')
            return "updated_from_codex-0.0", True
        with mock.patch.object(rq, "self_update", side_effect=fake_update) as up, \
                mock.patch.object(rq, "run_cmd", return_value=(0, "ok", "")) as run:
            rq.run_codex_companion()
        kw = up.call_args[1]
        self.assertEqual((kw["repo_path"], kw["version_var"], kw["state_name"]),
                         ("client/report_codex.py", "CODEX_CLIENT_VERSION", "update_state_codex.json"))
        self.assertEqual(run.call_args[0][0], [sys.executable, self.script, "--no-jitter"])

    def test_failed_download_leaves_no_placeholder_and_runs_nothing(self):
        with mock.patch.object(rq, "self_update", return_value=("gh_missing", False)), \
                mock.patch.object(rq, "run_cmd") as run:
            rq.run_codex_companion()
        self.assertFalse(os.path.exists(self.script))
        self.assertEqual(run.call_count, 0)

    def test_a_leftover_placeholder_is_treated_as_missing(self):
        with open(self.script, "w") as f:
            f.write(rq.CODEX_PLACEHOLDER)
        with mock.patch.object(rq, "self_update", return_value=("failed:offline", False)) as up, \
                mock.patch.object(rq, "run_cmd") as run:
            rq.run_codex_companion()
        self.assertEqual((up.call_count, run.call_count), (1, 0))

    def test_installed_script_runs_without_another_download_and_is_throttled(self):
        self.real_script()
        with mock.patch.object(rq, "self_update") as up, mock.patch.object(rq, "run_cmd", return_value=(0, "", "")) as run:
            rq.run_codex_companion()
            rq.run_codex_companion()
        self.assertEqual((up.call_count, run.call_count), (0, 1))

    def test_an_active_codex_job_is_not_duplicated(self):
        self.real_script()
        with open(os.path.join(self.tmp.name, "codex-quota.log"), "w") as f:
            f.write("job ran just now")
        with mock.patch.object(rq, "run_cmd") as run:
            rq.run_codex_companion()
        self.assertEqual(run.call_count, 0)
        old = time.time() - 3600
        os.utime(os.path.join(self.tmp.name, "codex-quota.log"), (old, old))  # job gone quiet: take over
        with mock.patch.object(rq, "run_cmd", return_value=(0, "", "")) as run:
            rq.run_codex_companion()
        self.assertEqual(run.call_count, 1)

    def test_a_failing_or_hanging_companion_never_breaks_the_claude_run(self):
        self.real_script()
        with mock.patch.object(rq, "run_cmd", side_effect=subprocess.TimeoutExpired("x", 1)):
            rq.run_codex_companion()
        os.remove(os.path.join(self.tmp.name, "codex_companion.json"))
        with mock.patch.object(rq, "run_cmd", side_effect=OSError("boom")):
            rq.run_codex_companion()

    def test_cli_installed_finds_a_binary_in_the_usual_dirs(self):
        self.installed.stop()
        fake = os.path.join(self.tmp.name, ".local", "bin", "codex")
        os.makedirs(os.path.dirname(fake))
        open(fake, "w").close()
        with mock.patch.dict(os.environ, {"HOME": self.tmp.name, "USERPROFILE": self.tmp.name, "PATH": ""}), \
                mock.patch.object(rq.shutil, "which", return_value=None):
            self.assertTrue(rq.cli_installed("codex"))
            self.assertFalse(rq.cli_installed("no-such-cli"))
        self.installed.start()


if __name__ == "__main__":
    unittest.main()


class AutoRollbackTests(MonitorDirCase):
    def setUp(self):
        super().setUp()
        self.script = os.path.join(self.tmp.name, "report_quota.py")
        with open(self.script, "w") as f:
            f.write("NEW")
        with open(self.script + ".prev", "w") as f:
            f.write("OLD")

    def read(self):
        with open(self.script) as f:
            return f.read()

    def test_restores_previous_client_after_consecutive_not_found(self):
        for _ in range(rq.ROLLBACK_AFTER_FAILS - 1):
            self.assertFalse(rq.note_report_outcome(False, 404, self.script))
        self.assertEqual(self.read(), "NEW")
        self.assertTrue(rq.note_report_outcome(False, 404, self.script))
        self.assertEqual(self.read(), "OLD")
        self.assertTrue(os.path.isfile(self.script + ".bad"))
        state = rq._load_json_file(rq.get_update_state_path())
        self.assertEqual(state["last_status"], "rolled_back_auto")
        self.assertGreater(state["checked_at"], time.time())  # updates pause for 24 h

    def test_network_errors_count_too(self):
        for _ in range(rq.ROLLBACK_AFTER_FAILS):
            rolled = rq.note_report_outcome(False, None, self.script)
        self.assertTrue(rolled)

    def test_success_resets_the_counter(self):
        for _ in range(rq.ROLLBACK_AFTER_FAILS - 1):
            rq.note_report_outcome(False, 404, self.script)
        rq.note_report_outcome(True, 200, self.script)
        for _ in range(rq.ROLLBACK_AFTER_FAILS - 1):
            self.assertFalse(rq.note_report_outcome(False, 404, self.script))
        self.assertEqual(self.read(), "NEW")

    def test_auth_and_server_errors_never_roll_back(self):
        for status in (401, 403, 400, 500, 503):
            for _ in range(rq.ROLLBACK_AFTER_FAILS + 1):
                self.assertFalse(rq.note_report_outcome(False, status, self.script))
        self.assertEqual(self.read(), "NEW")

    def test_no_rollback_without_backup_or_for_an_old_update(self):
        os.remove(self.script + ".prev")
        for _ in range(rq.ROLLBACK_AFTER_FAILS + 1):
            self.assertFalse(rq.note_report_outcome(False, 404, self.script))
        with open(self.script + ".prev", "w") as f:
            f.write("OLD")
        old = time.time() - rq.ROLLBACK_WINDOW_SEC - 10
        os.utime(self.script, (old, old))
        for _ in range(rq.ROLLBACK_AFTER_FAILS + 1):
            self.assertFalse(rq.note_report_outcome(False, 404, self.script))
        self.assertEqual(self.read(), "NEW")
