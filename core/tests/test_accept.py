# -*- coding: utf-8 -*-
"""`promoter.accept` — the yes button on the 待确认 queue.

Why per-file: the panel asks a yes/no question per row. `apply_pending` executes
the whole pending-list snapshot and archives every source that produced it, so a
per-row accept wired to it would accept the other rows too while looking like it
accepted one. These tests pin the scoping, the refusals, and the one case where
"accepted" must NOT mean "archived": a submission whose facts conflict with
memory needs a human ruling first.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_common import destroy_scratch, make_scratch_vault

from unified_memory import promoter
from unified_memory.common import canonical_dir, canonical_path, read_maybe
from unified_memory.conflict import read_conflicts

A = "dsh-20260814-120000-01.md"
B = "dsh-20260814-120001-01.md"


class AcceptTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        self.inbox = canonical_dir(self.vault) / "Agent提交区"

    def tearDown(self):
        destroy_scratch(self.vault)

    def write_inbox(self, name: str, facts: list[str]) -> Path:
        path = self.inbox / name
        path.write_text("\n".join(f"- {f}" for f in facts) + "\n", encoding="utf-8")
        return path

    def test_accepts_one_submission_and_leaves_the_others_alone(self):
        self.write_inbox(A, ["prefers dark theme in the UI"])
        self.write_inbox(B, ["the build server listens on port 8080"])
        result = promoter.accept(self.vault, A)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["promoted"], 1)
        self.assertIn("prefers dark theme", read_maybe(canonical_path(self.vault, "ui")))
        # The point of the per-file action: B is exactly where it was.
        self.assertTrue((self.inbox / B).is_file())
        self.assertFalse((self.inbox / A).is_file())
        self.assertTrue((self.inbox / "已处理" / A).is_file())
        self.assertFalse((self.inbox / "已处理" / B).exists())

    def test_a_second_accept_is_a_not_found_not_a_double_write(self):
        self.write_inbox(A, ["prefers dark theme in the UI"])
        self.assertTrue(promoter.accept(self.vault, A)["ok"])
        again = promoter.accept(self.vault, A)
        self.assertFalse(again["ok"])
        self.assertEqual(again["reason"], "not-found")
        note = read_maybe(canonical_path(self.vault, "ui"))
        self.assertEqual(note.count("prefers dark theme"), 1)

    def test_refuses_infrastructure_files(self):
        (self.inbox / "前缀登记.md").write_text("# 提交前缀登记\n", encoding="utf-8")
        (self.inbox / "README.md").write_text("# 提交区\n", encoding="utf-8")
        for name in ("前缀登记.md", "README.md"):
            result = promoter.accept(self.vault, name)
            self.assertFalse(result["ok"], name)
            self.assertEqual(result["reason"], "not-a-submission", name)
            self.assertTrue((self.inbox / name).is_file(), name)

    def test_refuses_a_path_instead_of_a_name(self):
        # A traversal name must never reach the join above.
        for name in ("../outside.md", "sub/dir.md", "no-extension"):
            result = promoter.accept(self.vault, name)
            self.assertFalse(result["ok"], name)
            self.assertEqual(result["reason"], "invalid-name", name)

    def test_leaves_a_conflicting_submission_in_the_queue(self):
        # Archiving it would make "waiting for your ruling" look identical to
        # "handled", and the facts are not promoted until the ruling exists.
        canonical_path(self.vault, "ui").write_text(
            read_maybe(canonical_path(self.vault, "ui"))
            + "\n- prefers dark theme in the UI（写入 2026-08-01｜来源：Agent提交区/x.md）\n",
            encoding="utf-8",
        )
        self.write_inbox(A, ["prefers light theme in the UI"])
        result = promoter.accept(self.vault, A)

        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "conflicts")
        self.assertGreaterEqual(result["conflicts"], 1)
        self.assertTrue((self.inbox / A).is_file(), "a conflicted submission must stay")
        self.assertFalse((self.inbox / "已处理" / A).exists())
        self.assertNotIn("prefers light theme", read_maybe(canonical_path(self.vault, "ui")))
        # ...but the conflict itself is queued, so nothing is lost.
        self.assertTrue(read_conflicts(self.vault))

    def test_reports_zero_when_the_submission_carries_no_facts(self):
        (self.inbox / A).write_text("", encoding="utf-8")
        result = promoter.accept(self.vault, A)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["promoted"], 0)
        # It is retired all the same: the user answered the question, and the
        # answer was "nothing worth keeping here".
        self.assertTrue((self.inbox / "已处理" / A).is_file())

    def test_accept_does_not_touch_the_pending_list_snapshot(self):
        # `--apply` consumes 待晋升.md; the per-row action must not invalidate a
        # list the user may be reading in the terminal at the same time.
        from unified_memory.common import situation_dir
        from unified_memory.common import PENDING_FILE

        pending = situation_dir(self.vault) / PENDING_FILE
        pending.write_text("# 待晋升\n\n- something from an earlier review\n", encoding="utf-8")
        before = read_maybe(pending)
        self.write_inbox(A, ["prefers dark theme in the UI"])
        self.assertTrue(promoter.accept(self.vault, A)["ok"])
        self.assertEqual(read_maybe(pending), before)


if __name__ == "__main__":
    unittest.main()
