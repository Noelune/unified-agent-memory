# -*- coding: utf-8 -*-
"""auto_promote archive consistency (batch A).

The old auto_promote archived EVERY source file even when one of its facts
was queued as a conflict — the queue then referenced a submission that no
longer existed in the inbox, severing the trail a reader needs to adjudicate.
Conflicted sources now stay until fully resolved.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import promoter
from unified_memory.common import canonical_dir, canonical_path
from unified_memory.app.govern.queue import read_conflicts


class AutoPromoteArchiveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.vault = make_scratch_vault()

    def tearDown(self) -> None:
        destroy_scratch(self.vault)

    def test_mixed_submission_is_held_not_archived(self) -> None:
        env = canonical_path(self.vault, "env")
        env.write_text(
            env.read_text(encoding="utf-8")
            + "\n- 同步端口为 8443（写入 2026-01-01｜来源：Agent提交区/old-20260101-01.md）\n",
            encoding="utf-8",
        )
        inbox = canonical_dir(self.vault) / "Agent提交区"
        submission = inbox / "tester-20260101-01.md"
        submission.write_text(
            "- 同步端口为 9443\n"
            "- 构建产物必须经过 typecheck 才能合并\n",
            encoding="utf-8",
        )
        promoted = promoter.auto_promote(self.vault, verbose=False)
        self.assertEqual(promoted, 1)
        self.assertTrue(submission.exists(), "conflicted source must stay in the inbox")
        queued = read_conflicts(self.vault)
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0].get("新"), "同步端口为 9443")

    def test_clean_submission_still_archives(self) -> None:
        inbox = canonical_dir(self.vault) / "Agent提交区"
        submission = inbox / "tester-20260101-01.md"
        submission.write_text(
            "- 构建产物必须经过 typecheck 才能合并\n", encoding="utf-8"
        )
        promoted = promoter.auto_promote(self.vault, verbose=False)
        self.assertEqual(promoted, 1)
        self.assertFalse(submission.exists(), "clean source should be archived")
        self.assertEqual(read_conflicts(self.vault), [])

    def test_adjudication_releases_the_held_source(self) -> None:
        env = canonical_path(self.vault, "env")
        env.write_text(
            env.read_text(encoding="utf-8")
            + "\n- 同步端口为 8443（写入 2026-01-01｜来源：Agent提交区/old-20260101-01.md）\n",
            encoding="utf-8",
        )
        inbox = canonical_dir(self.vault) / "Agent提交区"
        submission = inbox / "tester-20260101-01.md"
        submission.write_text("- 同步端口为 9443\n", encoding="utf-8")
        promoter.auto_promote(self.vault, verbose=False)
        self.assertTrue(submission.exists())
        entry = read_conflicts(self.vault)[0]
        promoter.decide(self.vault, entry, "用新")
        # The decision retires the old line; the next pass finds no conflict
        # and archives the source.
        result = promoter.review(self.vault, verbose=False)
        self.assertEqual(result["conflicts"], 0)
        self.assertEqual(result["pending"], [])
        promoter.auto_promote(self.vault, verbose=False)
        self.assertFalse(submission.exists())


if __name__ == "__main__":
    unittest.main()
