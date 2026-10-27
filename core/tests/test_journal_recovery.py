# -*- coding: utf-8 -*-
"""Journal recovery (batch B): a crash between intent and commit must not
leave canonical notes half-written.

infra.vault.apply writes `intent` before the first file and `commit` after the
last; recover() rolls an uncommitted intent back to before_text. These tests
rebind the journal base to a temp dir and exercise recover() and apply()
directly — no real vault, no real ~/.unified-memory.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from test_common import destroy_scratch, make_scratch_vault
from unified_memory.domain.model import Change, ChangeSet
from unified_memory.infra import journal, vault as vault_mod


class JournalRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = Path(self._tmp.name) / "vault"
        (self.vault / "50-Agent-Context").mkdir(parents=True)
        self.note = self.vault / "50-Agent-Context" / "我的偏好摘要.md"
        self.note.write_text("- 原有事实一条\n", encoding="utf-8")
        self._base = journal.JOURNAL_BASE
        journal.JOURNAL_BASE = Path(self._tmp.name) / "journal"

    def tearDown(self) -> None:
        journal.JOURNAL_BASE = self._base
        self._tmp.cleanup()

    def _changeset(self) -> ChangeSet:
        return ChangeSet(
            actor="test", reason="recover",
            changes=(
                Change(op="rewrite_doc", doc=self.note,
                       before_text="- 原有事实一条\n",
                       after_text="- 原有事实一条\n- 新增事实\n"),
            ),
        )

    def test_committed_apply_writes_intent_then_commit(self) -> None:
        vault_mod.apply(self.vault, self._changeset())
        self.assertIn("- 新增事实", self.note.read_text(encoding="utf-8"))
        records = journal._read(journal.journal_path(self.vault))
        self.assertEqual([r["kind"] for r in records], ["intent", "commit"])
        self.assertEqual(records[0]["changes"][0]["after_text"],
                         "- 原有事实一条\n- 新增事实\n")
        # Recovery after a clean commit does nothing.
        report = journal.recover(self.vault)
        self.assertFalse(report["recovered"])
        self.assertIn("- 新增事实", self.note.read_text(encoding="utf-8"))

    def test_crash_before_any_write_rolls_nothing(self) -> None:
        # Intent recorded, process died before the first file write.
        journal.write_intent(self.vault, self._changeset())
        report = journal.recover(self.vault)
        self.assertTrue(report["recovered"])
        self.assertEqual(report["restored"], 0)  # current == before: nothing to undo
        self.assertEqual(self.note.read_text(encoding="utf-8"), "- 原有事实一条\n")

    def test_crash_mid_apply_restores_before_text(self) -> None:
        # Intent recorded, the file was already rewritten, then the process
        # died before the commit. Recovery must undo the applied write.
        journal.write_intent(self.vault, self._changeset())
        self.note.write_text("- 原有事实一条\n- 新增事实\n", encoding="utf-8")
        report = journal.recover(self.vault)
        self.assertTrue(report["recovered"])
        self.assertEqual(report["restored"], 1)
        self.assertEqual(self.note.read_text(encoding="utf-8"), "- 原有事实一条\n")

    def test_replayed_recovery_is_idempotent(self) -> None:
        journal.write_intent(self.vault, self._changeset())
        self.note.write_text("- 原有事实一条\n- 新增事实\n", encoding="utf-8")
        journal.recover(self.vault)
        report = journal.recover(self.vault)
        self.assertFalse(report["recovered"])  # rollback record closed the intent
        self.assertEqual(self.note.read_text(encoding="utf-8"), "- 原有事实一条\n")

    def test_no_journal_means_nothing_to_recover(self) -> None:
        report = journal.recover(self.vault)
        self.assertFalse(report["recovered"])

    def test_absent_file_is_restored_to_absent(self) -> None:
        # A plan may create a file that did not exist (before_text == "").
        # Rolling that back means REMOVING it, not writing an empty file.
        changeset = ChangeSet(
            actor="test", reason="recover",
            changes=(Change(op="rewrite_doc", doc=self.vault / "50-Agent-Context" / "新建笔记.md",
                            before_text="", after_text="- 凭空事实\n"),),
        )
        journal.write_intent(self.vault, changeset)
        created = self.vault / "50-Agent-Context" / "新建笔记.md"
        created.write_text("- 凭空事实\n", encoding="utf-8")  # crash mid-apply
        journal.recover(self.vault)
        self.assertFalse(created.exists())


class ApplyUnderJournalTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = Path(self._tmp.name) / "vault"
        self.note = self.vault / "50-Agent-Context" / "笔记.md"
        self.note.parent.mkdir(parents=True)
        self.note.write_text("- 第一条\n", encoding="utf-8")
        self._base = journal.JOURNAL_BASE
        journal.JOURNAL_BASE = Path(self._tmp.name) / "journal"

    def tearDown(self) -> None:
        journal.JOURNAL_BASE = self._base
        self._tmp.cleanup()

    def test_apply_without_lock_still_journals(self) -> None:
        changeset = ChangeSet(
            actor="test", reason="apply",
            changes=(Change(op="rewrite_doc", doc=self.note,
                            before_text="- 第一条\n", after_text="- 第一条\n- 第二条\n"),),
        )
        vault_mod.apply(self.vault, changeset, take_lock=False)
        self.assertIn("- 第二条", self.note.read_text(encoding="utf-8"))
        records = journal._read(journal.journal_path(self.vault))
        self.assertEqual([r["kind"] for r in records], ["intent", "commit"])

    def test_stale_plan_is_refused(self) -> None:
        # No replan callback: if the world moved, the executor refuses rather
        # than writes over a file it did not read.
        changeset = ChangeSet(
            actor="test", reason="apply",
            changes=(Change(op="rewrite_doc", doc=self.note,
                            before_text="- 第一条\n", after_text="- 过期内容\n"),),
        )
        self.note.write_text("- 世界已经变了\n", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            vault_mod.apply(self.vault, changeset, take_lock=False)
        self.assertEqual(self.note.read_text(encoding="utf-8"), "- 世界已经变了\n")
        # And the journal holds no intent for the refused plan.
        records = journal._read(journal.journal_path(self.vault))
        self.assertEqual(records, [])


if __name__ == "__main__":
    unittest.main()
