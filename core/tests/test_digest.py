# -*- coding: utf-8 -*-
"""Tests for the session-digest module (unified_memory.digest).

The live LLM is never called: chat_extract_facts is patched. Tests cover fact
parsing/redaction, archive discovery (date files only), cursor idempotency and
the enable/disable switch.
"""
import contextlib
import io
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import digest, common


class DigestTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        self.arch = common.canonical_dir(self.vault) / "会话归档"
        self.arch.mkdir(parents=True, exist_ok=True)
        # Redirect config path so digest_enabled reads a scratch config. The
        # original value is restored in tearDown: leaving a deleted temp path
        # here would hand the next test (or a later digest_enabled call) a
        # config that no longer exists.
        self._saved_config = common.CONFIG_PATH
        common.CONFIG_PATH = self.vault.parent / "config.yaml"

    def tearDown(self):
        common.CONFIG_PATH = self._saved_config
        destroy_scratch(self.vault)

    def _write_session(self, name, body):
        (self.arch / name).write_text(body, encoding="utf-8")

    def test_parse_facts_rejects_credentials(self):
        facts = digest._parse_facts("- 用户偏好简体中文\n- api_key: shortkey\n- 决策：用向量检索\n")
        self.assertIn("用户偏好简体中文", facts)
        self.assertIn("决策：用向量检索", facts)
        self.assertFalse(any("shortkey" in f for f in facts))

    def test_archive_files_only_accepts_date_names(self):
        self._write_session("2026-08-16.md", "session body\n")
        self._write_session("README.md", "ignore me\n")
        self._write_session("2026-08-15.md", "older\n")
        names = {p.name for p in digest._archive_files(self.vault)}
        self.assertEqual(names, {"2026-08-16.md", "2026-08-15.md"})

    def test_digest_skips_without_api_key(self):
        self._write_session("2026-08-16.md", "body\n")
        with patch("unified_memory.embed.configured", return_value=False):
            report = digest.digest(self.vault)
        self.assertEqual(report["pending"], 1)
        self.assertIn("no SiliconFlow API key", report["skipped"][0])
        inbox = common.canonical_dir(self.vault) / "Agent提交区"
        self.assertEqual(list(inbox.glob("digest-*.md")), [])

    def test_digest_writes_facts_and_advances_cursor(self):
        self._write_session("2026-08-16.md", "body\n")
        with patch("unified_memory.embed.configured", return_value=True), patch(
            "unified_memory.digest.chat_extract_facts", return_value=["用户喜欢深色主题", "决策：用向量检索"]
        ):
            report = digest.digest(self.vault)
        self.assertEqual(report["written"], 1)
        self.assertEqual(report["facts"], 2)
        inbox = common.canonical_dir(self.vault) / "Agent提交区"
        files = list(inbox.glob("digest-*.md"))
        self.assertEqual(len(files), 1)
        self.assertIn("用户喜欢深色主题", files[0].read_text(encoding="utf-8"))
        # Idempotent: cursor advanced, a second run sees nothing new.
        with patch("unified_memory.embed.configured", return_value=True):
            report2 = digest.digest(self.vault)
        self.assertEqual(report2["pending"], 0)

    def test_cursor_is_not_advanced_when_the_inbox_write_fails(self):
        self._write_session("2026-08-16.md", "body\n")
        with patch("unified_memory.embed.configured", return_value=True), patch(
            "unified_memory.digest.chat_extract_facts", return_value=["用户喜欢深色主题"]
        ), patch("unified_memory.digest._write_digest_facts", return_value=0):
            report = digest.digest(self.vault)
        self.assertEqual(report["written"], 0)
        self.assertTrue(any("could not write inbox" in item for item in report["skipped"]))
        # The same archive must still be pending: losing the extracted facts
        # permanently was the previous behaviour.
        with patch("unified_memory.embed.configured", return_value=True), patch(
            "unified_memory.digest.chat_extract_facts", return_value=["用户喜欢深色主题"]
        ):
            second = digest.digest(self.vault)
        self.assertEqual(second["pending"], 1)

    def test_digest_can_be_disabled_via_config(self):
        common.CONFIG_PATH.write_text("digest.enabled: false\n", encoding="utf-8")
        self.assertFalse(digest.digest_enabled(common.CONFIG_PATH))
        digest._set_enabled(common.CONFIG_PATH, True)
        self.assertTrue(digest.digest_enabled(common.CONFIG_PATH))

    def test_cli_on_re_enables_what_off_disabled(self):
        # --off had no counterpart, so the only way back was to hand-edit the
        # config file --off itself had just written.
        common.CONFIG_PATH.write_text("digest.enabled: true\n", encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()) as buf:
            digest.main(["--off", "--vault", str(self.vault)])
        self.assertIn("disabled", buf.getvalue())
        self.assertFalse(digest.digest_enabled(common.CONFIG_PATH))

        with contextlib.redirect_stdout(io.StringIO()) as buf:
            digest.main(["--on", "--vault", str(self.vault)])
        self.assertIn("enabled", buf.getvalue())
        self.assertTrue(digest.digest_enabled(common.CONFIG_PATH))

    def test_cli_rejects_on_and_off_together(self):
        with self.assertRaises(SystemExit):
            digest.main(["--on", "--off", "--vault", str(self.vault)])


if __name__ == "__main__":
    unittest.main()
