# -*- coding: utf-8 -*-
"""The conflict queue is written in two shapes; both must be readable.

`情境信息/事实冲突待裁决.md` is written by this core (one JSON line per conflict)
and by other runtimes (a `##` heading with one field per line). The reader used
to accept only the first, so on a vault that held one pending conflict in the
second shape it returned `[]` — and `adjudicate` printed "no pending conflicts"
while the conflict sat in plain sight.

These tests are about that gap, and about the two things that follow from it:
a decision must dequeue the entry, and it must write to the note the entry
actually names.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import promoter
from unified_memory.common import (
    ADJUDICATED_FILE,
    CONFLICT_FILE,
    canonical_dir,
    read_maybe,
    situation_dir,
)
from unified_memory.conflict import (
    append_conflict,
    entry_key,
    find_conflict,
    read_conflicts,
    remove_conflict,
)

BLOCK = (
    "# 事实冲突待裁决队列\n"
    "\n"
    "（当前无待裁决冲突）\n"
    "\n"
    "---\n"
    "## 2026-10-19 03:01 冲突 #20261019030125-1\n"
    "- 状态：[待裁决]\n"
    "- 新提交：备份目录已迁移到 D:/backups\n"
    "- 来源：[[Hermes会话自动归档/2026-10-18]]\n"
    "- 既有：- 备份目录是 C:/backups（写入 2026-10-16）\n"
    "- 所在：50-Agent-Context\\常用路径与环境.md\n"
)


class ConflictFormatTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        self.queue = situation_dir(self.vault) / CONFLICT_FILE

    def tearDown(self):
        destroy_scratch(self.vault)

    # ── reading ────────────────────────────────────────────────────

    def test_reads_a_hand_written_block(self):
        self.queue.write_text(BLOCK, encoding="utf-8")

        entries = read_conflicts(self.vault)

        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["新"], "备份目录已迁移到 D:/backups")
        self.assertEqual(entry["旧"], "- 备份目录是 C:/backups（写入 2026-10-16）")
        self.assertEqual(entry["来源"], "[[Hermes会话自动归档/2026-10-18]]")
        self.assertEqual(entry["目标"], "50-Agent-Context\\常用路径与环境.md")

    def test_reads_both_shapes_from_the_same_file(self):
        append_conflict(self.vault, "端口改为 9090", "端口是 8080", "a.md", "env")
        self.queue.write_text(
            read_maybe(self.queue) + "\n" + BLOCK, encoding="utf-8"
        )

        entries = read_conflicts(self.vault)

        self.assertEqual(len(entries), 2)
        self.assertEqual([e["format"] for e in entries], ["json", "block"])

    def test_a_value_may_contain_the_field_separator(self):
        # `- 新提交：备份：`C:\...`` — the value starts with its own label and
        # contains both a full-width and an ASCII colon. Splitting on the first
        # colon only is what keeps the path intact.
        self.queue.write_text(BLOCK, encoding="utf-8")

        self.assertEqual(
            read_conflicts(self.vault)[0]["新"], "备份目录已迁移到 D:/backups"
        )

    def test_a_block_marked_resolved_is_not_pending(self):
        self.queue.write_text(
            BLOCK.replace("- 状态：[待裁决]", "- 状态：[已裁决]"), encoding="utf-8"
        )

        self.assertEqual(read_conflicts(self.vault), [])

    def test_a_heading_with_no_facts_is_not_a_decision(self):
        self.queue.write_text(
            "## 2026-10-19 03:01 冲突 #20261019030125-1\n- 状态：[待裁决]\n",
            encoding="utf-8",
        )

        self.assertEqual(read_conflicts(self.vault), [])

    def test_the_key_prefers_the_human_stamp(self):
        self.queue.write_text(BLOCK, encoding="utf-8")

        self.assertEqual(entry_key(read_conflicts(self.vault)[0]), "20261019030125-1")

    def test_a_json_entry_still_gets_a_stable_key(self):
        append_conflict(self.vault, "端口改为 9090", "端口是 8080", "a.md", "env")

        first = entry_key(read_conflicts(self.vault)[0])
        second = entry_key(read_conflicts(self.vault)[0])

        self.assertTrue(first)
        self.assertEqual(first, second, "the same entry must key the same twice")
        self.assertIsNotNone(find_conflict(self.vault, first))

    def test_dequeuing_by_hand_removes_the_whole_block(self):
        self.queue.write_text(BLOCK, encoding="utf-8")
        entry = read_conflicts(self.vault)[0]

        remove_conflict(self.vault, entry)

        text = read_maybe(self.queue)
        self.assertEqual(read_conflicts(self.vault), [])
        self.assertNotIn("20261019030125-1", text)
        self.assertNotIn("新提交", text)
        # The `---` that introduced the block must go with it: a file of
        # left-over rules reads as corruption, not as a clean queue.
        self.assertNotIn("---", text)

    def test_removing_one_json_entry_leaves_the_other(self):
        append_conflict(self.vault, "端口改为 9090", "端口是 8080", "a.md", "env")
        append_conflict(self.vault, "端口改为 9191", "端口是 8181", "b.md", "env")

        remove_conflict(self.vault, read_conflicts(self.vault)[0])

        remaining = read_conflicts(self.vault)
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["新"], "端口改为 9191")

    # ── deciding ───────────────────────────────────────────────────

    def test_use_new_writes_to_the_note_the_entry_names(self):
        # The block's `所在` is a vault-relative PATH, not a doc id. Ignoring it
        # and falling back to classification removes the old line from one note
        # and appends the new fact to a different one.
        #
        # The note here is deliberately NOT the one classification would pick:
        # `备份目录…` classifies as `env` (→ 常用路径与环境.md), while the entry
        # names 项目笔记.md. A test whose `所在` agrees with classification
        # passes either way and proves nothing — it cannot tell "read the path
        # the entry carries" from "guess from the fact text".
        note = canonical_dir(self.vault) / "项目笔记.md"
        note.write_text(
            "\n- 备份目录是 C:/backups（写入 2026-10-16｜来源：Agent提交区/x.md）\n",
            encoding="utf-8",
        )
        # The starter vault ships 常用路径与环境.md, so "the file is absent" is
        # not a usable check; compare what was in it before and after instead.
        classified = canonical_dir(self.vault) / "常用路径与环境.md"
        before_classified = read_maybe(classified)
        self.queue.write_text(
            BLOCK.replace(
                "50-Agent-Context\\常用路径与环境.md",
                "50-Agent-Context\\项目笔记.md",
            ),
            encoding="utf-8",
        )

        entry = read_conflicts(self.vault)[0]
        self.assertEqual(promoter.classify(entry["新"]), "env")
        result = promoter.decide(self.vault, entry, "用新")

        self.assertTrue(result["ok"])
        self.assertTrue(
            result["target"].endswith("项目笔记.md"),
            f"wrote to {result['target']!r} instead of the note the entry named",
        )
        text = read_maybe(note)
        self.assertIn("备份目录已迁移到 D:/backups", text)
        self.assertNotIn("备份目录是 C:/backups", text)
        # The classified note must stay untouched: the decision belongs to the
        # note that recorded the contradiction, not to whichever note happens to
        # match a keyword.
        self.assertEqual(read_maybe(classified), before_classified)
        self.assertFalse((situation_dir(self.vault) / "未归类事实.md").exists())

    def test_keep_both_appends_without_touching_the_old_line(self):
        env = canonical_dir(self.vault) / "常用路径与环境.md"
        env.write_text(
            "\n- 备份目录是 C:/backups（写入 2026-10-16｜来源：Agent提交区/x.md）\n",
            encoding="utf-8",
        )
        self.queue.write_text(BLOCK, encoding="utf-8")

        result = promoter.decide(self.vault, read_conflicts(self.vault)[0], "并存")

        self.assertTrue(result["ok"])
        text = read_maybe(env)
        self.assertIn("备份目录是 C:/backups", text)
        self.assertIn("备份目录已迁移到 D:/backups", text)

    def test_keep_old_leaves_memory_alone_but_clears_the_queue(self):
        env = canonical_dir(self.vault) / "常用路径与环境.md"
        before = "\n- 备份目录是 C:/backups（写入 2026-10-16｜来源：Agent提交区/x.md）\n"
        env.write_text(before, encoding="utf-8")
        self.queue.write_text(BLOCK, encoding="utf-8")

        result = promoter.decide(self.vault, read_conflicts(self.vault)[0], "保留旧")

        self.assertTrue(result["ok"])
        self.assertFalse(result["applied"])
        self.assertEqual(read_maybe(env), before)
        self.assertEqual(read_conflicts(self.vault), [])
        self.assertIn(
            "保留旧",
            read_maybe(situation_dir(self.vault) / ADJUDICATED_FILE),
        )

    def test_an_unknown_choice_is_refused_not_treated_as_skip(self):
        self.queue.write_text(BLOCK, encoding="utf-8")
        entry = read_conflicts(self.vault)[0]

        result = promoter.decide(self.vault, entry, "用旧的")

        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "unknown-choice")
        self.assertEqual(len(read_conflicts(self.vault)), 1, "the queue must be untouched")

    def test_a_target_outside_the_vault_is_never_written(self):
        outside = self.vault.parent / "escaped.md"
        self.queue.write_text(
            BLOCK.replace(
                "- 所在：50-Agent-Context\\常用路径与环境.md",
                "- 所在：../escaped.md",
            ),
            encoding="utf-8",
        )

        result = promoter.decide(self.vault, read_conflicts(self.vault)[0], "用新")

        self.assertTrue(result["ok"])
        self.assertFalse(outside.exists(), "a hand-edited record must not reach outside the vault")

    def test_a_past_block_decision_stops_the_fact_returning(self):
        # The adjudication log is written in two shapes too. Reading only the
        # `｜新：` one meant a `保留旧` decision from the other runtime was
        # invisible, so the same conflict came back on every pass.
        (situation_dir(self.vault) / ADJUDICATED_FILE).write_text(
            "# 事实冲突已裁决\n\n"
            "## 2026-08-06 裁决 #1（自动保守裁决，保留旧）\n\n"
            "- **新提交**：端口是 8080\n"
            "- **既有**：端口是 9090\n",
            encoding="utf-8",
        )

        self.assertIn("端口是 8080", promoter._adjudicated_facts(self.vault))


if __name__ == "__main__":
    unittest.main()
