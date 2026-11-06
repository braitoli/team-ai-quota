#!/usr/bin/env python3
"""
Unit tests for new CLI coding agent collectors (gemini, copilot, cursor),
machine/account labeling across all collectors, and the unified CLI ai_quota.py.
"""

import os
import sys
import json
import sqlite3
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "client"))
import report_quota as rq
import report_codex as rc
import report_agy as ra
import report_gemini as rg
import report_copilot as rcp
import report_cursor as rcu
import ai_quota as aiq


class DeviceLabelingTests(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp_dir.cleanup)
        self.config_path = os.path.join(self.tmp_dir.name, "config.json")

    def test_default_has_no_labels_preserving_backward_compatibility(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(sys, "argv", ["report_quota.py"]), \
             mock.patch.object(rq, "get_ai_quota_config_path", return_value="/nonexistent/config.json"):
            payload = rq.build_payload("dev@example.com", {"used_percent": 15.0, "resets_at": "2026-11-06T12:00:00+00:00"}, [], 1000, "regex", "ok")
            self.assertNotIn("machine_label", payload)
            self.assertNotIn("account_label", payload)

    def test_env_vars_inject_machine_and_account_labels(self):
        env = {
            "QUOTA_MACHINE_LABEL": "MacBookPro-M3",
            "QUOTA_ACCOUNT_LABEL": "LeadDev",
        }
        with mock.patch.dict(os.environ, env), \
             mock.patch.object(rq, "get_ai_quota_config_path", return_value="/nonexistent/config.json"):
            p_claude = rq.build_payload("dev@example.com", {"used_percent": 10.0, "resets_at": None}, [], 1000, "regex", "ok")
            self.assertEqual(p_claude.get("machine_label"), "MacBookPro-M3")
            self.assertEqual(p_claude.get("account_label"), "LeadDev")

            p_codex = rc.build_codex_payload("dev@example.com", {"used_percent": 20.0, "resets_at": None}, None, 1000)
            self.assertEqual(p_codex.get("machine_label"), "MacBookPro-M3")
            self.assertEqual(p_codex.get("account_label"), "LeadDev")

            p_agy = ra.build_agy_payload("dev@example.com", {"pool": "gemini", "used_percent": 30.0, "resets_at": None, "weekly": None, "five_hour_disabled": False}, 1000)
            self.assertEqual(p_agy.get("machine_label"), "MacBookPro-M3")
            self.assertEqual(p_agy.get("account_label"), "LeadDev")

    def test_cli_flags_inject_machine_and_account_labels(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(sys, "argv", ["prog", "--label", "BuildServer-01", "--account-label", "CI-Account"]), \
             mock.patch.object(rq, "get_ai_quota_config_path", return_value="/nonexistent/config.json"):
            p = rq.build_payload("dev@example.com", {"used_percent": 5.0, "resets_at": None}, [], 1000, "regex", "ok")
            self.assertEqual(p.get("machine_label"), "BuildServer-01")
            self.assertEqual(p.get("account_label"), "CI-Account")

    def test_config_file_injects_labels_and_accounts_mapping(self):
        config_data = {
            "machine_label": "ConfigMachine",
            "worker_url": "https://custom.workers.dev/update",
            "api_key": "custom-key-123",
            "accounts": {
                "user1@example.com": "TeamLead",
                "user2@example.com": "BackendDev",
            }
        }
        with open(self.config_path, "w", encoding="utf-8") as f:
            json.dump(config_data, f)

        with mock.patch.dict(os.environ, {"AI_QUOTA_CONFIG_PATH": self.config_path}), \
             mock.patch.object(sys, "argv", ["prog"]):
            self.assertEqual(rq.get_machine_label(), "ConfigMachine")
            self.assertEqual(rq.get_account_label("user1@example.com"), "TeamLead")
            self.assertEqual(rq.get_account_label("user2@example.com"), "BackendDev")
            self.assertEqual(rq.get_worker_url(), "https://custom.workers.dev/update")
            self.assertEqual(rq.get_secret_key(), "custom-key-123")


class GeminiCollectorTests(unittest.TestCase):
    def test_parse_gemini_usage_json(self):
        raw = json.dumps({
            "used_percent": 42.5,
            "resets_at": "2026-11-06T15:00:00Z",
            "weekly_used_percent": 12.0,
            "weekly_resets_at": "2026-11-13T00:00:00Z",
        })
        session, weekly, err = rg.parse_gemini_usage(raw)
        self.assertEqual(err, "")
        self.assertEqual(session["used_percent"], 42.5)
        self.assertTrue(session["resets_at"].startswith("2026-11-06T15:00:00"))
        self.assertEqual(weekly["percent"], 12.0)
        self.assertTrue(weekly["resets_at"].startswith("2026-11-13T00:00:00"))

    def test_build_gemini_payload(self):
        session = {"used_percent": 33.3, "resets_at": "2026-11-06T18:00:00+00:00"}
        weekly = {"percent": 5.0, "resets_at": "2026-11-13T00:00:00+00:00"}
        with mock.patch.object(rq, "get_machine_id", return_value="gemini-m1"):
            payload = rg.build_gemini_payload("gemini@example.com", session, weekly, 1700000000000)

        self.assertEqual(payload["provider"], "gemini")
        self.assertEqual(payload["email"], "gemini@example.com")
        self.assertEqual(payload["used_percent"], 33.3)
        self.assertEqual(payload["limits"][0]["group"], "weekly")
        self.assertEqual(payload["limits"][0]["percent"], 5.0)

    def test_run_gemini_report_with_env_mock(self):
        mock_usage = json.dumps({"used_percent": 25.0, "resets_at": "2026-11-06T12:00:00Z"})
        sent = []
        with mock.patch.dict(os.environ, {
            "GEMINI_USAGE_JSON": mock_usage,
            "GEMINI_ACCOUNT_EMAIL": "test-gemini@example.com",
        }), mock.patch.object(rq, "post_to_worker", side_effect=lambda p: sent.append(p) or (True, 200, "ok")):
            ok = rg.run_gemini_report(force=True)
            self.assertTrue(ok)
            self.assertEqual(len(sent), 1)
            self.assertEqual(sent[0]["provider"], "gemini")
            self.assertEqual(sent[0]["email"], "test-gemini@example.com")
            self.assertEqual(sent[0]["used_percent"], 25.0)


class CopilotCollectorTests(unittest.TestCase):
    def test_parse_copilot_usage(self):
        raw = json.dumps({
            "monthly_used_percent": 68.0,
            "monthly_resets_at": "2026-12-01T00:00:00Z",
            "used_percent": 68.0,
            "resets_at": "2026-12-01T00:00:00Z",
        })
        session, monthly, err = rcp.parse_copilot_usage(raw)
        self.assertEqual(err, "")
        self.assertEqual(session["used_percent"], 68.0)
        self.assertEqual(monthly["percent"], 68.0)
        self.assertTrue(monthly["resets_at"].startswith("2026-12-01T00:00:00"))

    def test_build_copilot_payload(self):
        session = {"used_percent": 45.0, "resets_at": "2026-12-01T00:00:00+00:00"}
        monthly = {"percent": 45.0, "resets_at": "2026-12-01T00:00:00+00:00"}
        with mock.patch.object(rq, "get_machine_id", return_value="copilot-m1"):
            payload = rcp.build_copilot_payload("octocat@users.noreply.github.com", session, monthly, 1700000000000)

        self.assertEqual(payload["provider"], "copilot")
        self.assertEqual(payload["email"], "octocat@users.noreply.github.com")
        self.assertEqual(payload["monthly_used_percent"], 45.0)
        self.assertEqual(payload["limits"][0]["kind"], "monthly")

    def test_run_copilot_report_with_env_mock(self):
        mock_usage = json.dumps({"monthly_used_percent": 15.5, "monthly_resets_at": "2026-12-01T00:00:00Z"})
        sent = []
        with mock.patch.dict(os.environ, {
            "COPILOT_USAGE_JSON": mock_usage,
            "COPILOT_ACCOUNT_EMAIL": "coder@github.com",
        }), mock.patch.object(rq, "post_to_worker", side_effect=lambda p: sent.append(p) or (True, 200, "ok")):
            ok = rcp.run_copilot_report(force=True)
            self.assertTrue(ok)
            self.assertEqual(len(sent), 1)
            self.assertEqual(sent[0]["provider"], "copilot")
            self.assertEqual(sent[0]["email"], "coder@github.com")
            self.assertEqual(sent[0]["monthly_used_percent"], 15.5)


class CursorCollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp_dir.cleanup)
        self.db_path = os.path.join(self.tmp_dir.name, "state.vscdb")
        # Setup sqlite db
        conn = sqlite3.connect(self.db_path)
        cur = conn.cursor()
        cur.execute("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)")
        cur.execute("INSERT INTO ItemTable VALUES ('cursorAuth/cachedEmail', 'cursor-dev@example.com')")
        cur.execute("INSERT INTO ItemTable VALUES ('cursorAuth/usage', '{\"fast_requests_limit\": 500, \"fast_requests_used\": 150, \"monthly_resets_at\": \"2026-12-01T00:00:00Z\"}')")
        conn.commit()
        conn.close()

    def test_read_cursor_email_from_sqlite(self):
        with mock.patch.dict(os.environ, {"CURSOR_STATE_PATH": self.db_path}):
            email = rcu.read_cursor_email()
            self.assertEqual(email, "cursor-dev@example.com")

    def test_fetch_cursor_state_from_sqlite(self):
        with mock.patch.dict(os.environ, {"CURSOR_STATE_PATH": self.db_path}):
            session, monthly, failure = rcu.fetch_cursor_state(None)
            self.assertIsNone(failure)
            self.assertEqual(monthly["percent"], 30.0)  # 150/500 = 30.0%
            self.assertEqual(session["used_percent"], 30.0)

    def test_build_cursor_payload(self):
        session = {"used_percent": 30.0, "resets_at": "2026-12-01T00:00:00+00:00"}
        monthly = {"percent": 30.0, "resets_at": "2026-12-01T00:00:00+00:00"}
        with mock.patch.object(rq, "get_machine_id", return_value="cursor-m1"):
            payload = rcu.build_cursor_payload("cursor-dev@example.com", session, monthly, 1700000000000)

        self.assertEqual(payload["provider"], "cursor")
        self.assertEqual(payload["email"], "cursor-dev@example.com")
        self.assertEqual(payload["monthly_used_percent"], 30.0)
        self.assertEqual(payload["limits"][0]["kind"], "monthly")

    def test_run_cursor_report(self):
        sent = []
        with mock.patch.dict(os.environ, {"CURSOR_STATE_PATH": self.db_path}), \
             mock.patch.object(rq, "post_to_worker", side_effect=lambda p: sent.append(p) or (True, 200, "ok")):
            ok = rcu.run_cursor_report(force=True)
            self.assertTrue(ok)
            self.assertEqual(len(sent), 1)
            self.assertEqual(sent[0]["provider"], "cursor")
            self.assertEqual(sent[0]["email"], "cursor-dev@example.com")


class AIQuotaUnifiedCLITests(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp_dir.cleanup)
        self.config_path = os.path.join(self.tmp_dir.name, "config.json")

    def test_resolve_providers_from_cli_arg(self):
        p = aiq.resolve_providers("gemini,copilot")
        self.assertEqual(p, ["gemini", "copilot"])

    def test_resolve_providers_from_env(self):
        with mock.patch.dict(os.environ, {"QUOTA_PROVIDERS": "codex,cursor"}):
            p = aiq.resolve_providers()
            self.assertEqual(p, ["codex", "cursor"])

    def test_cmd_label_saves_to_config_and_posts_to_server(self):
        mock_args = mock.Mock()
        mock_args.machine = "DevB-MacBookPro"
        mock_args.account = "teamlead@example.com:LeadEngineer"

        with mock.patch.dict(os.environ, {"AI_QUOTA_CONFIG_PATH": self.config_path}), \
             mock.patch.object(aiq.urllib.request, "urlopen") as mock_urlopen:
            mock_resp = mock.MagicMock()
            mock_resp.status = 200
            mock_resp.read.return_value = b'{"success": true}'
            mock_urlopen.return_value.__enter__.return_value = mock_resp

            code = aiq.cmd_label(mock_args)
            self.assertEqual(code, 0)

            # Verify saved locally
            with open(self.config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            self.assertEqual(cfg["machine_label"], "DevB-MacBookPro")
            self.assertEqual(cfg["account_label"], "LeadEngineer")
            self.assertEqual(cfg["accounts"]["teamlead@example.com"], "LeadEngineer")

    def test_cmd_best_queries_route_and_prints_account(self):
        mock_args = mock.Mock()
        mock_args.provider = "claude"

        with mock.patch.object(aiq.urllib.request, "urlopen") as mock_urlopen:
            mock_resp = mock.MagicMock()
            mock_resp.read.return_value = b'{"account": "best-claude@example.com"}'
            mock_urlopen.return_value.__enter__.return_value = mock_resp

            with mock.patch("builtins.print") as mock_print:
                code = aiq.cmd_best(mock_args)
                self.assertEqual(code, 0)
                mock_print.assert_called_with("best-claude@example.com")


if __name__ == "__main__":
    unittest.main()


class TokenDeltaTests(unittest.TestCase):
    def _write(self, d, ts_list):
        from datetime import datetime, timezone
        with open(os.path.join(d, "s.jsonl"), "w") as f:
            for i, ts in enumerate(ts_list):
                iso = datetime.fromtimestamp(ts, timezone.utc).isoformat()
                f.write(json.dumps({"timestamp": iso, "requestId": f"r{i}", "message": {
                    "id": f"m{i}", "usage": {"input_tokens": 10, "output_tokens": 5, "cache_creation_input_tokens": 1,
                                             "cache_read_input_tokens": 999}}}) + "\n")
        os.utime(os.path.join(d, "s.jsonl"), (max(ts_list), max(ts_list)))

    def test_delta_counts_only_window_and_commit_advances_cursor(self):
        with tempfile.TemporaryDirectory() as d:
            now = 1_800_000_000.0
            self._write(d, [now - 400, now - 100, now - 50])
            cur = os.path.join(d, "cursor.json")
            self.assertIsNone(rq.build_token_delta(now, cur, d))  # no cursor yet: never attribute history
            rq.commit_token_cursor(None, cur, now - 200)
            td = rq.build_token_delta(now, cur, d)
            self.assertEqual((td["input"], td["output"], td["msgs"]), (22, 10, 2))
            rq.commit_token_cursor(td, cur)
            td2 = rq.build_token_delta(now + 10, cur, d)
            self.assertEqual(td2["msgs"], 0)
            self.assertEqual(td2["since"], td["until"])

    def test_stale_cursor_is_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            cur = os.path.join(d, "cursor.json")
            rq.commit_token_cursor(None, cur, 1_800_000_000.0 - rq.TOKEN_CURSOR_MAX_GAP_SEC - 5)
            self.assertIsNone(rq.build_token_delta(1_800_000_000.0, cur, d))
