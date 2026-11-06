"""Unit tests for client/report_agy.py. Run: python3 -m unittest discover -s test -p "test_client*.py" """
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "test", "fixtures")
sys.path.insert(0, os.path.join(ROOT, "client"))
spec = importlib.util.spec_from_file_location("report_agy", os.path.join(ROOT, "client", "report_agy.py"))
ra = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ra)


def fixture(name):
    with open(os.path.join(FIXTURES, name), "r", encoding="utf-8") as f:
        return f.read()


def by_pool(pools):
    return {p["pool"]: p for p in pools}


class ParserTests(unittest.TestCase):
    def test_real_gemini_5h_disabled(self):
        pools, reason = ra.parse_agy_usage(fixture("agy-usage-01-real-gemini-5h-disabled.json"))
        self.assertEqual(reason, "")
        p = by_pool(pools)
        self.assertEqual(set(p), {"gemini", "claude"})
        g = p["gemini"]
        self.assertTrue(g["five_hour_disabled"])
        self.assertIsNone(g["resets_at"])
        self.assertEqual(g["weekly"], {"percent": 100.0, "resets_at": "2026-11-01T12:52:53+00:00"})
        c = p["claude"]
        self.assertFalse(c["five_hour_disabled"])
        self.assertEqual(c["used_percent"], 67.5)
        self.assertEqual(c["resets_at"], "2026-10-28T10:24:27+00:00")
        self.assertEqual(c["weekly"], {"percent": 34.3, "resets_at": "2026-11-04T05:24:27+00:00"})

    def test_both_5h_active(self):
        p = by_pool(ra.parse_agy_usage(fixture("agy-usage-02-both-5h-active.json"))[0])
        self.assertFalse(p["gemini"]["five_hour_disabled"])
        self.assertEqual(p["gemini"]["used_percent"], 20.0)
        self.assertEqual(p["gemini"]["resets_at"], "2026-10-28T09:15:00+00:00")
        self.assertEqual(p["gemini"]["weekly"]["percent"], 58.0)

    def test_unknown_group_and_missing_weekly_ignored(self):
        data = {"status": "SUCCESS", "command": {"data": {"groups": [
            {"name": "Future Models", "buckets": [{"window": "5h", "remaining_fraction": 0.5, "reset_time": "2026-10-28T10:00:00Z"}]},
            {"name": "Gemini Models", "buckets": [{"window": "5h", "remaining_fraction": 0.25, "reset_time": "2026-10-28T10:00:00Z"}]},
        ]}}}
        pools, _ = ra.parse_agy_usage(json.dumps(data))
        self.assertEqual(len(pools), 1)
        self.assertEqual(pools[0]["pool"], "gemini")
        self.assertIsNone(pools[0]["weekly"])
        self.assertEqual(pools[0]["used_percent"], 75.0)

    def test_garbage_and_bad_status(self):
        self.assertEqual(ra.parse_agy_usage("not json")[0], [])
        self.assertEqual(ra.parse_agy_usage("")[0], [])
        self.assertEqual(ra.parse_agy_usage('{"status":"ERROR"}')[0], [])
        self.assertEqual(ra.parse_agy_usage('{"status":"SUCCESS","command":{"data":{"groups":[]}}}')[0], [])

    def test_out_of_range_fraction_skipped(self):
        data = {"command": {"data": {"groups": [{"name": "Gemini Models", "buckets": [
            {"window": "5h", "remaining_fraction": 1.7, "reset_time": "2026-10-28T10:00:00Z"}]}]}}}
        self.assertEqual(ra.parse_agy_usage(json.dumps(data))[0], [])

    def test_leading_noise_before_json(self):
        text = "warning: something\n" + fixture("agy-usage-02-both-5h-active.json")
        self.assertEqual(len(ra.parse_agy_usage(text)[0]), 2)


class PayloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        patcher = mock.patch.object(ra.rq, "get_monitor_dir", return_value=self.tmp.name)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_active_payload(self):
        p = by_pool(ra.parse_agy_usage(fixture("agy-usage-01-real-gemini-5h-disabled.json"))[0])["claude"]
        pl = ra.build_agy_payload("a@b.c", p, 123)
        self.assertEqual((pl["provider"], pl["pool"], pl["email"]), ("agy", "claude", "a@b.c"))
        self.assertEqual(pl["used_percent"], 67.5)
        self.assertEqual(pl["resets_at"], "2026-10-28T10:24:27+00:00")
        self.assertEqual(pl["limits"], [{"kind": "weekly", "group": "weekly", "percent": 34.3,
                                         "resets_at": "2026-11-04T05:24:27+00:00", "is_active": True, "scope_name": "claude"}])
        self.assertNotIn("five_hour_disabled", pl)
        self.assertEqual(pl["token_state"], "ok")

    def test_disabled_payload(self):
        p = by_pool(ra.parse_agy_usage(fixture("agy-usage-01-real-gemini-5h-disabled.json"))[0])["gemini"]
        pl = ra.build_agy_payload("a@b.c", p, 123)
        self.assertTrue(pl["five_hour_disabled"])
        self.assertIsNone(pl["resets_at"])
        self.assertEqual(pl["pool"], "gemini")
        self.assertEqual(pl["limits"][0]["percent"], 100.0)
        self.assertEqual(pl["limits"][0]["scope_name"], "gemini")


class EmailTests(unittest.TestCase):
    def test_reads_only_email(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "tok")
            with open(path, "w") as f:
                json.dump({"token": "SECRET", "id_token_email": "Me@Example.com"}, f)
            with mock.patch.object(ra, "TOKEN_FILE", path):
                self.assertEqual(ra.read_agy_email(), "me@example.com")
            with mock.patch.object(ra, "TOKEN_FILE", os.path.join(d, "missing")):
                self.assertIsNone(ra.read_agy_email())


class RunOnceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        for target, val in (("get_monitor_dir", self.tmp.name),):
            p = mock.patch.object(ra.rq, target, return_value=val)
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)
        self.posts = []
        for p in (mock.patch.object(ra, "find_agy", return_value="/fake/agy"),
                  mock.patch.object(ra, "read_agy_email", return_value="me@example.com"),
                  mock.patch.object(ra.rq, "post_to_worker", side_effect=self._post),
                  mock.patch.object(sys, "argv", ["report_agy.py", "--no-jitter"])):
            p.start()
            self.addCleanup(p.stop)

    def _post(self, payload):
        self.posts.append(payload)
        return True, 200, "ok"

    def test_one_post_per_pool(self):
        with mock.patch.object(ra, "fetch_agy_usage", return_value=(fixture("agy-usage-01-real-gemini-5h-disabled.json"), None)):
            self.assertEqual(ra.run_once(), 0)
        self.assertEqual(sorted(p["pool"] for p in self.posts), ["claude", "gemini"])
        self.assertTrue(all(p["provider"] == "agy" for p in self.posts))

    def test_parse_failure_sends_error_report(self):
        with mock.patch.object(ra, "fetch_agy_usage", return_value=("garbage", None)):
            self.assertEqual(ra.run_once(), 1)
        self.assertEqual(self.posts[0]["error_kind"], "parse_error")
        self.assertEqual(self.posts[0]["provider"], "agy")
        self.assertNotIn("used_percent", self.posts[0])

    def test_fetch_failure_sends_error_report(self):
        with mock.patch.object(ra, "fetch_agy_usage", return_value=("", ("usage_timeout", "timed out", None))):
            self.assertEqual(ra.run_once(), 1)
        self.assertEqual(self.posts[0]["error_kind"], "usage_timeout")

    def test_no_email_no_report(self):
        with mock.patch.object(ra, "read_agy_email", return_value=None):
            self.assertEqual(ra.run_once(), 1)
        self.assertEqual(self.posts, [])

    def test_worker_failure_returns_1(self):
        with mock.patch.object(ra, "fetch_agy_usage", return_value=(fixture("agy-usage-02-both-5h-active.json"), None)), \
             mock.patch.object(ra.rq, "post_to_worker", return_value=(False, 500, "boom")):
            self.assertEqual(ra.run_once(), 1)

    def test_lock_is_separate_from_claude(self):
        claude_lock = ra.rq.acquire_lock()
        try:
            agy_lock = ra.rq.acquire_lock(ra.AGY_LOCK)
            self.assertIsNotNone(agy_lock)
            ra.rq.release_lock(agy_lock)
        finally:
            ra.rq.release_lock(claude_lock)


class MissingAgyTests(unittest.TestCase):
    """A machine without agy sends nothing and never touches gh, the lock or the network."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.posts = []
        for p in (mock.patch.object(ra.rq, "get_monitor_dir", return_value=self.tmp.name),
                  mock.patch.object(ra.rq, "post_to_worker", side_effect=lambda payload: self.posts.append(payload) or (True, 200, "ok")),
                  mock.patch.object(ra, "read_agy_email", return_value="me@example.com"),
                  mock.patch.object(sys, "argv", ["report_agy.py", "--no-jitter"])):
            p.start()
            self.addCleanup(p.stop)

    def test_find_agy_returns_none_when_it_is_not_installed(self):
        with mock.patch.object(ra.shutil, "which", return_value=None), \
             mock.patch.object(ra.os.path, "isfile", return_value=False):
            os.environ.pop("AGY_QUOTA_AGY_BIN", None)
            self.assertIsNone(ra.find_agy())

    def test_missing_agy_binary_sends_nothing(self):
        with mock.patch.object(ra, "find_agy", return_value=None):
            self.assertEqual(ra.run_once(), 0)
        self.assertEqual(self.posts, [])

    def test_report_without_agy_skips_update_and_lock(self):
        with mock.patch.object(ra, "find_agy", return_value=None), \
             mock.patch.object(ra.rq, "self_update", side_effect=AssertionError("must not check for updates")):
            self.assertEqual(ra.report(), 0)
        self.assertEqual(self.posts, [])
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, ra.AGY_LOCK)))

    def test_detect_flag_prints_the_binary_path(self):
        env = dict(os.environ, AGY_QUOTA_AGY_BIN=sys.executable)
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "client", "report_agy.py"), "--detect"],
                              capture_output=True, text=True, timeout=20, env=env)
        self.assertEqual((proc.returncode, proc.stdout.strip()), (0, sys.executable))

    def test_version_flag(self):
        proc = subprocess.run([sys.executable, os.path.join(ROOT, "client", "report_agy.py"), "--version"],
                              capture_output=True, text=True, timeout=20)
        self.assertEqual((proc.returncode, proc.stdout.strip()), (0, ra.AGY_CLIENT_VERSION))


FAKE_GH = """#!{python}
import os, sys
d = os.environ["FAKE_GH_DIR"]
endpoint = [a for a in sys.argv[2:] if a.startswith("repos/")][0]
kind = "commits" if "/commits?" in endpoint else "source"
open(os.path.join(d, "calls.log"), "a").write(endpoint + "\\n")
sys.stdout.write(open(os.path.join(d, "commits.json" if kind == "commits" else "source.py")).read())
"""


class AgyUpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        p = mock.patch.object(ra.rq, "get_monitor_dir", return_value=self.tmp.name)
        p.start()
        self.addCleanup(p.stop)
        self.gh_dir = tempfile.mkdtemp(dir=self.tmp.name)
        self.install = tempfile.mkdtemp(dir=self.tmp.name)
        for name in ("report_quota.py", "report_agy.py"):  # report_agy imports report_quota from its own folder
            shutil.copy(os.path.join(ROOT, "client", name), os.path.join(self.install, name))
        self.script = os.path.join(self.install, "report_agy.py")
        with open(self.script, "r", encoding="utf-8", newline="") as f:
            self.local_source = f.read()
        gh = os.path.join(self.gh_dir, "gh")
        with open(gh, "w") as f:
            f.write(FAKE_GH.format(python=sys.executable))
        os.chmod(gh, 0o755)
        env = mock.patch.dict(os.environ, {"CLAUDE_QUOTA_GH_BIN": gh, "FAKE_GH_DIR": self.gh_dir})
        env.start()
        self.addCleanup(env.stop)
        for k in ("CLAUDE_QUOTA_NO_UPDATE", "AGY_QUOTA_UPDATED", "AGY_QUOTA_UPDATED_FROM"):
            os.environ.pop(k, None)

    def serve(self, version, verified=True, sha="agysha1"):
        source = self.local_source.replace('AGY_CLIENT_VERSION = "%s"' % ra.AGY_CLIENT_VERSION,
                                           'AGY_CLIENT_VERSION = "%s"' % version, 1)
        with open(os.path.join(self.gh_dir, "source.py"), "w", encoding="utf-8", newline="") as f:
            f.write(source)
        with open(os.path.join(self.gh_dir, "commits.json"), "w") as f:
            json.dump([{"sha": sha, "commit": {"verification": {"verified": verified}}}], f)
        return source

    def update(self):
        return ra.rq.self_update(self.script, repo_path=ra.AGY_UPDATE_PATH, version_var="AGY_CLIENT_VERSION",
                                 current_version=ra.AGY_CLIENT_VERSION, state_name=ra.AGY_UPDATE_STATE,
                                 reexec_marker="AGY_QUOTA_UPDATED")

    def installed(self):
        with open(self.script, "r", encoding="utf-8", newline="") as f:
            return f.read()

    def test_new_verified_agy_version_is_swapped_with_its_own_state_and_backup(self):
        newer = self.serve("agy-9.9")
        self.assertEqual(self.update(), ("updated_from_" + ra.AGY_CLIENT_VERSION, True))
        self.assertEqual(self.installed(), newer)
        with open(self.script + ".prev", "r", encoding="utf-8", newline="") as f:
            self.assertEqual(f.read(), self.local_source)
        self.assertTrue(os.path.exists(os.path.join(self.tmp.name, ra.AGY_UPDATE_STATE)))
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "update_state.json")))
        with open(os.path.join(self.gh_dir, "calls.log")) as f:
            self.assertTrue(all("client/report_agy.py" in line for line in f.read().split()))

    def test_unverified_commit_and_lower_version_are_not_applied(self):
        self.serve("agy-9.9", verified=False)
        self.assertEqual(self.update(), ("unverified_commit", False))
        self.assertEqual(self.installed(), self.local_source)
        os.remove(os.path.join(self.tmp.name, ra.AGY_UPDATE_STATE))
        self.serve("agy-0.1", sha="agysha2")
        self.assertEqual(self.update(), ("current", False))
        self.assertEqual(self.installed(), self.local_source)

    def test_broken_python_keeps_the_old_file(self):
        self.serve("agy-9.9")
        with open(os.path.join(self.gh_dir, "source.py"), "a", encoding="utf-8") as f:
            f.write("\ndef broken(:\n")
        self.assertEqual(self.update(), ("failed:syntax", False))
        self.assertEqual(self.installed(), self.local_source)

    def test_update_status_is_in_agy_payloads(self):
        ra.rq.UPDATE_INFO["status"] = "gh_missing"
        self.addCleanup(ra.rq.UPDATE_INFO.update, {"status": None})
        pool = {"pool": "gemini", "used_percent": 5.0, "resets_at": None, "five_hour_disabled": False, "weekly": None}
        with mock.patch.object(ra.rq, "get_machine_id", return_value="m1"):
            payload = ra.build_agy_payload("a@x.io", pool, 1)
        self.assertEqual(payload["update_status"], "gh_missing")


if __name__ == "__main__":
    unittest.main()
