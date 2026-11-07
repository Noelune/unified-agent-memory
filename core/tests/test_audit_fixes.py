# -*- coding: utf-8 -*-
"""Regression tests for the 2026-11-01 audit fixes."""
import contextlib
import io
import os
import unittest
from pathlib import Path
from unittest import mock

from test_common import destroy_scratch, make_scratch_vault

from unified_memory.app.maintain.backfill import run_backfill
from unified_memory.app.maintain.drift import DriftDetector
from unified_memory.app.maintain.health import doctor
from unified_memory.app.query.commands import cmd_audit
from unified_memory.domain.markdown import (
    CREDENTIAL_LINE_RE,
    bare_fact_line,
    fact_lines,
    looks_like_credential,
    redact,
)
from unified_memory.infra.store.ledger import refresh_ledger
from unified_memory.infra.store.schema import get_conn
from unified_memory.infra.vault import indexed_files, unindexed_notes
from unified_memory.infra.config import CONFIG_PATH
from unified_memory.infra.vault import canonical_dir

class RuleLineTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def _note_path(self):
        return canonical_dir(self.vault) / "我的偏好摘要.md"

    def test_backfill_never_touches_rules(self):
        run_backfill(self.vault)  # clear the template's own un-id'ed lines first
        for rule in ("---", "***", "___"):
            self._note_path().write_text(
                "# t\n\n- 偏好事实（写入 2026-01-01｜来源：Agent提交区/x.md）\n" + rule + "\n",
                encoding="utf-8",
            )
            run_backfill(self.vault)
            text = self._note_path().read_text(encoding="utf-8")
            self.assertNotIn(rule + " ^c-", text)

    def test_rules_are_not_fact_lines(self):
        for rule in ("---", "***", "___", "==="):
            self.assertEqual(bare_fact_line(rule), "")

    def test_backfill_still_ids_real_facts(self):
        run_backfill(self.vault)  # clear the template's own un-id'ed lines first
        self._note_path().write_text(
            "# t\n\n- 偏好事实（写入 2026-01-01｜来源：Agent提交区/x.md）\n---\n",
            encoding="utf-8",
        )
        report = run_backfill(self.vault)
        self.assertEqual(report["lines"], 1)

    def test_ledger_never_stores_rule_claims(self):
        self._note_path().write_text(
            "# t\n\n--- ^c-" + "a" * 16 + "\n- 偏好事实 ^c-" + "b" * 16 + "\n",
            encoding="utf-8",
        )
        refresh_ledger(self.vault)
        conn = get_conn(self.vault)
        try:
            rule_rows = conn.execute("SELECT id FROM claims WHERE text = '---'").fetchall()
            real = conn.execute("SELECT id FROM claims WHERE text = '偏好事实'").fetchall()
            self.assertEqual(rule_rows, [])
            self.assertEqual(len(real), 1)
        finally:
            conn.close()

    def test_fact_lines_skips_rule_separators(self):
        self.assertEqual(fact_lines("# h\n---\n- A\n---\n- B\n"), ["A", "B"])

class RedactAuditTest(unittest.TestCase):
    def test_pem_block_redacted(self):
        text = (
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n"
            "-----END RSA PRIVATE KEY-----\n"
        )
        self.assertEqual(redact(text), "<REDACTED_PRIVATE_KEY>\n")
        self.assertTrue(looks_like_credential("-----BEGIN OPENSSH PRIVATE KEY-----"))

    def test_unterminated_pem_redacted(self):
        out = redact("prefix\n-----BEGIN PRIVATE KEY-----\nMIIEow")
        self.assertNotIn("MIIEow", out)
        self.assertIn("<REDACTED_PRIVATE_KEY>", out)

    def test_bearer_redacted(self):
        out = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc")
        self.assertEqual(out, "Authorization: Bearer <REDACTED_BEARER>")

    def test_bearer_gate(self):
        out = redact("Authorization: Bearer eyJ.abc")
        self.assertTrue(out.startswith("Authorization: Bearer "))
        self.assertTrue(looks_like_credential("Authorization: Bearer eyJ.abc"))

    def test_english_keyword_shi_redacted(self):
        secret = "a1b2c3d4e5f6a7b8c9d0"
        self.assertEqual(redact("secret 是 " + secret), "secret 是 <REDACTED>")
        self.assertEqual(redact("appsecret 为 " + secret), "appsecret 为 <REDACTED>")
        self.assertEqual(redact("secret 是必要字段"), "secret 是必要字段")

    def test_chinese_prose_credentials(self):
        self.assertEqual(redact("密码是 MySecret123"), "密码是 <REDACTED>")
        self.assertEqual(redact("口令为 hunter2!"), "口令为 <REDACTED>")
        self.assertEqual(redact("密码是必须的"), "密码是必须的")
        self.assertEqual(redact("token 是一个概念"), "token 是一个概念")

    def test_submit_gate_new_categories(self):
        self.assertIsNotNone(CREDENTIAL_LINE_RE.search("密码是 abc12345"))
        self.assertIsNotNone(CREDENTIAL_LINE_RE.search("appsecret 是 aabbccdd"))
        self.assertIsNotNone(CREDENTIAL_LINE_RE.search("-----BEGIN RSA PRIVATE KEY-----"))
        self.assertIsNotNone(CREDENTIAL_LINE_RE.search("Authorization: Bearer eyJ.abc"))
        self.assertIsNone(CREDENTIAL_LINE_RE.search("密码是必须的"))
        self.assertIsNone(CREDENTIAL_LINE_RE.search("token 是一个概念"))

class DriftVaultResolutionTest(unittest.TestCase):
    def test_drift_reads_config_when_env_missing(self):
        vault = make_scratch_vault()
        try:
            os.environ.pop("UNIFIED_MEMORY_VAULT", None)
            CONFIG_PATH.write_text("vault: " + str(vault) + "\n", encoding="utf-8")
            detector = DriftDetector(repo_root=Path(__file__).resolve().parents[2])
            self.assertIsNotNone(detector._resolve_vault())
        finally:
            os.environ["UNIFIED_MEMORY_VAULT"] = str(vault)
            destroy_scratch(vault)

class IndexBlindSpotTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_knowledge_dirs_are_indexed(self):
        k20 = self.vault / "20-Knowledge"
        (k20 / "Windows与环境").mkdir(parents=True, exist_ok=True)
        (k20 / "Windows与环境" / "note.md").write_text("# t\n\n- 事实\n", encoding="utf-8")
        (k20 / "_backup").mkdir(exist_ok=True)
        (k20 / "_backup" / "hidden.md").write_text("- x\n", encoding="utf-8")
        names = {p.name for p in indexed_files(self.vault)}
        self.assertIn("note.md", names)
        self.assertNotIn("hidden.md", names)

    def test_unindexed_tripwire(self):
        stray = self.vault / "杂项" / "散落笔记.md"
        stray.parent.mkdir(parents=True, exist_ok=True)
        stray.write_text("- 事实\n", encoding="utf-8")
        report = unindexed_notes(self.vault)
        self.assertGreaterEqual(report["count"], 1)
        self.assertTrue(any("散落笔记" in f for f in report["files"]))

    def test_unindexed_excludes_design_areas(self):
        forget = self.vault / "50-Agent-Context" / "记忆遗忘区" / "2026-11"
        forget.mkdir(parents=True, exist_ok=True)
        (forget / "旧副本.md").write_text("- 旧事实\n", encoding="utf-8")
        report = unindexed_notes(self.vault)
        self.assertFalse(any("旧副本" in f for f in report["files"]))

    def test_doctor_flags_unindexed_as_warn(self):
        stray = self.vault / "杂项" / "散落笔记.md"
        stray.parent.mkdir(parents=True, exist_ok=True)
        stray.write_text("- 事实\n", encoding="utf-8")
        with mock.patch("unified_memory.infra.providers.embed.configured", return_value=False):
            report = doctor(self.vault)
        issues = [i for i in report["issues"] if i["code"] == "unindexed-notes"]
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["severity"], "warn")

class CliConsistencyTest(unittest.TestCase):
    def test_health_is_doctor_alias(self):
        from unified_memory.surface import cli
        parser = cli.build_parser()
        args = parser.parse_args(["health"])
        self.assertEqual(args.fn.__name__, "cmd_doctor")

    def test_audit_reports_summary(self):
        rows = [
            {"id": 2, "at": "2026-11-01T12:00:00", "agent": "hermes",
             "action": "promote", "target": "b", "detail": "d"},
            {"id": 1, "at": "2026-11-01T11:00:00", "agent": "codex",
             "action": "promote", "target": "a", "detail": "d"},
        ]
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            with mock.patch.object(query_commands_mod(), "audit_rows", return_value=rows), \
                 mock.patch.object(query_commands_mod(), "ensure_vault"), \
                 mock.patch.object(query_commands_mod(), "resolve_vault", return_value=Path("V")):
                cmd_audit(mock.Mock(json=False, verify=False, limit=0,
                                    agent=None, target=None, since=None))
        out = buf.getvalue()
        self.assertIn("summary: 2 entries", out)
        self.assertIn("byAgent: codex=1, hermes=1", out)

def query_commands_mod():
    from unified_memory.app.query import commands
    return commands

if __name__ == "__main__":
    unittest.main()
