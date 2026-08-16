# -*- coding: utf-8 -*-
"""Tests for the session-digest module (unified_memory.digest).

The live LLM is never called: chat_extract_facts is patched. Tests cover fact
parsing/redaction, archive discovery (date files only), cursor idempotency and
the enable/disable switch.
"""
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
        # Redirect config path so digest_enabled reads a scratch config.
        common.CONFIG_PATH = self.vault.parent / "config.yaml"

    def tearDown(self):
        destroy_scratch(self.vault)

    def _write_session(self, name, body):
        (self.arch / name).write_text(body, encoding="utf-8")

    def test_parse_facts_rejects_credentials(self):
        facts = digest._parse_facts("- 用户偏好简体中文\n- api_key: sk-super-secret-123\n- 决策：用向量检索\n")
        self.assertIn("用户偏好简体中文", facts)
        self.assertIn("决策：用向量检索", facts)
        self.assertFalse(any("sk-super" in f for f in facts))

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

    def test_digest_can_be_disabled_via_config(self):
        common.CONFIG_PATH.write_text("digest.enabled: false\n", encoding="utf-8")
        self.assertFalse(digest.digest_enabled(common.CONFIG_PATH))
        digest._set_enabled(common.CONFIG_PATH, True)
        self.assertTrue(digest.digest_enabled(common.CONFIG_PATH))


if __name__ == "__main__":
    unittest.main()
