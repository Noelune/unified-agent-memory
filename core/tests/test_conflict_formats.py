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
    classify_against,
    describe,
    entry_key,
    find_conflict,
    read_conflicts,
    remove_conflict,
    same_subject,
    split_change,
    subject_of,
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


class ConflictReadabilityTest(unittest.TestCase):
    """A queued entry is written for a machine; a person still has to rule on it.

    The raw line carries a bullet, a write stamp and an event id. Handing that
    to someone and asking "which is right?" makes them strip the noise first and
    hunt for the one differing substring second — both mechanical, both done
    here so the panel can show the two facts instead of the two records.
    """

    NEW_RAW = (
        "备份：`C:\\hermes\\backups\\adjudicate-20261018-20261018_115737\\`"
        "（三个文件完整副本）"
    )
    OLD_RAW = (
        "- 备份：`C:\\hermes\\backups\\soul\\SOUL.md.bak-20261015-230432`（随时可回滚）"
        "（写入 2026-10-16｜来源：[[Hermes会话自动归档/2026-10-15]]，事件 `86022e98ae62ebed4d8eb4a7`）"
    )

    def test_the_fact_is_shown_without_the_bullet_or_the_write_stamp(self):
        side = describe(self.OLD_RAW)

        self.assertEqual(
            side["text"],
            "备份：`C:\\hermes\\backups\\soul\\SOUL.md.bak-20261015-230432`（随时可回滚）",
        )
        self.assertNotIn("写入", side["text"])
        self.assertNotIn("86022e98", side["text"])

    def test_the_stamp_is_kept_as_answerable_metadata(self):
        side = describe(self.OLD_RAW)

        self.assertEqual(side["recorded"], "2026-10-16")
        self.assertEqual(side["source"], "Hermes会话自动归档/2026-10-15")

    def test_a_parenthetical_that_means_something_survives(self):
        # `（随时可回滚）` is why this backup matters. Treating every trailing
        # parenthetical as provenance would delete the clause the reader needs
        # to judge the line.
        self.assertIn("（随时可回滚）", describe(self.OLD_RAW)["text"])

    def test_a_line_that_is_only_a_stamp_stays_readable(self):
        side = describe("（写入 2026-10-16）")

        self.assertEqual(side["text"], "（写入 2026-10-16）")
        self.assertEqual(side["recorded"], "2026-10-16")

    def test_the_difference_starts_at_a_path_boundary(self):
        change = split_change(describe(self.NEW_RAW)["text"], describe(self.OLD_RAW)["text"])

        self.assertIsNotNone(change)
        self.assertTrue(
            change["prefix"].endswith("backups\\"),
            f"difference starts mid-segment at {change['prefix'][-20:]!r}",
        )
        self.assertTrue(change["new"].startswith("adjudicate-"))
        self.assertTrue(change["old"].startswith("soul\\"))

    def test_the_three_pieces_rebuild_each_side_exactly(self):
        new_side = describe(self.NEW_RAW)["text"]
        old_side = describe(self.OLD_RAW)["text"]
        change = split_change(new_side, old_side)

        self.assertEqual(change["prefix"] + change["new"] + change["suffix"], new_side)
        self.assertEqual(change["prefix"] + change["old"] + change["suffix"], old_side)

    def test_two_identical_sides_have_no_difference_to_mark(self):
        self.assertIsNone(split_change("端口是 8080", "端口是 8080"))

    def test_a_missing_side_is_not_a_difference(self):
        self.assertIsNone(split_change("", "端口是 8080"))
        self.assertIsNone(split_change("端口是 8080", ""))

    def test_the_split_snaps_out_of_the_middle_of_a_word(self):
        # Two values that differ only in trailing digits: character-level, the
        # difference starts inside `backups-2026`. Snapping back to the last
        # separator makes the marked segment `backups-2026`, which is the unit a
        # person actually compares.
        change = split_change("备份：C:\\data\\backups-2026", "备份：C:\\data\\backups-2025")

        self.assertTrue(change["prefix"].endswith("\\"), change)
        self.assertEqual(change["new"], "backups-2026")
        self.assertEqual(change["old"], "backups-2025")

    def test_the_split_never_swallows_the_whole_prefix(self):
        # A long shared path must keep enough context that the two middles are
        # still comparable; collapsing everything into `…` would hide the fact
        # that both live under the same backups directory.
        shared = "备份：" + "\\".join(["C:", "a", "b", "c", "d", "e", "f", "g", "h"])
        change = split_change(shared + "\\one.md", shared + "\\two.md")

        self.assertTrue(change["prefix"].endswith("\\"))
        self.assertGreater(len(change["prefix"]), 10)


class SubjectTest(unittest.TestCase):
    """What a pair of facts is about, as opposed to how much they look alike.

    The queue used to fill with pairs that merely shared a template. On a real
    vault the look-alikes scored HIGHER than the contradictions, so the honest
    question is not "how similar" but "about the same thing".
    """

    # ── reading the subject off a line ─────────────────────────────

    def test_the_head_of_a_sentence_is_what_it_is_about(self):
        self.assertEqual(subject_of("备份目录是 C:/backups"), "备份目录")
        self.assertEqual(subject_of("备份目录已迁移到 D:/backups"), "备份目录")
        self.assertEqual(subject_of("端口：8080"), "端口")

    def test_a_drive_letter_is_not_a_separator(self):
        # `C:` is part of the value. Reading it as the colon leaves the subject
        # as `备份目录是 C`, which matches nothing and silently disables the check.
        self.assertEqual(subject_of("备份目录是 C:/backups"), "备份目录")

    def test_emphasis_markers_are_not_part_of_the_subject(self):
        self.assertEqual(subject_of("**默认模型**：openrouter/free"), "默认模型")

    def test_a_provenance_stamp_is_not_part_of_the_subject(self):
        self.assertEqual(
            subject_of("- 备份目录是 C:/backups（写入 2026-10-16｜来源：[[x]]）"),
            "备份目录",
        )

    def test_a_dated_log_line_has_no_subject(self):
        # The date is when it was written, not what it is about. Treating it as
        # a subject would make every entry of one day contradict every other.
        self.assertEqual(subject_of("2026-09-22：修了端口"), "")
        self.assertEqual(subject_of("2026-09-22：部署在服务器上"), "")

    def test_a_template_placeholder_line_has_no_subject(self):
        # `示例：端口是 1` must stop at the placeholder. Falling through to the
        # verb pattern reads it as `示例：端口`, a subject that exists nowhere.
        self.assertEqual(subject_of("示例：端口是 1"), "")
        self.assertEqual(subject_of("备注：部署在 D:/x"), "")

    def test_a_truncated_path_is_not_a_subject(self):
        self.assertEqual(subject_of("C:/data：备份"), "")

    def test_a_head_that_is_only_punctuation_has_no_subject(self):
        # Nothing but padding before the colon: the "head" is the separator's
        # own whitespace. Returning it would make every such line share a
        # subject, which is the opposite of what the check is for.
        self.assertEqual(subject_of("  ：8080"), "")
        self.assertEqual(subject_of("   "), "")

    def test_a_line_that_states_no_relation_has_no_subject(self):
        self.assertEqual(subject_of("凭据库脚本.py"), "")

    def test_a_dash_separated_fact_has_a_subject(self):
        self.assertEqual(
            subject_of("UNIFIED_MEMORY_REMOTE_URL — optional remote index server URL"),
            "UNIFIED_MEMORY_REMOTE_URL",
        )

    # ── comparing two subjects ─────────────────────────────────────

    def test_a_shared_prefix_is_not_a_shared_subject(self):
        # Straight from the vault: three environment variables that share a
        # prefix scored 0.67-0.79 on their heads and were flagged as conflicts.
        self.assertFalse(
            same_subject("UNIFIED_MEMORY_REMOTE_URL", "UNIFIED_MEMORY_REMOTE_TOKEN")
        )

    def test_a_synonym_is_treated_as_a_different_subject(self):
        # A known cost, pinned so nobody "fixes" it by lowering the threshold:
        # `备份目录`/`备份路径` and `默认模型`/`可用模型` score the same (0.33), so
        # any threshold that reunites the first also fuses the second. The pair
        # stops being a question, but the new line is still written — both
        # readings stay on the page rather than one silently winning.
        self.assertFalse(same_subject("备份目录", "备份路径"))
        self.assertFalse(same_subject("默认模型", "可用模型"))

    def test_an_empty_subject_matches_nothing(self):
        self.assertFalse(same_subject("", "端口"))
        self.assertFalse(same_subject("端口", ""))
        self.assertFalse(same_subject("", ""))

    # ── deciding with it ───────────────────────────────────────────

    def test_a_new_value_for_the_same_subject_is_a_conflict(self):
        self.assertEqual(
            classify_against("备份目录是 C:/backups", ["备份目录已迁移到 D:/backups"]),
            ("conflict", "备份目录已迁移到 D:/backups"),
        )
        self.assertEqual(
            classify_against(
                "UNIFIED_MEMORY_TIMEOUT — seconds (default 10)",
                ["UNIFIED_MEMORY_TIMEOUT — seconds (default 5)"],
            ),
            ("conflict", "UNIFIED_MEMORY_TIMEOUT — seconds (default 5)"),
        )

    def test_a_shared_template_alone_is_not_a_conflict(self):
        # The complaint that started this: same value, different key, queued as
        # a decision somebody had to make.
        self.assertEqual(
            classify_against(
                "**默认模型**：openrouter/free", ["**可用模型**：openrouter/free"]
            ),
            ("new", None),
        )

    def test_an_unreadable_subject_falls_back_to_similarity(self):
        # Neither line states a relation, so there is no subject to compare and
        # the pair goes back to being a question. A question can be answered; a
        # dropped contradiction cannot be recovered.
        self.assertEqual(
            classify_against("备份 C:/backups", ["备份 D:/backups"]),
            ("conflict", "备份 D:/backups"),
        )

    def test_the_look_alike_does_not_hide_the_real_match(self):
        # A different-subject line comes first and scores above the threshold.
        # Skipping it must not end the search: the later line is the one this
        # fact actually contradicts.
        self.assertEqual(
            classify_against(
                "备份目录是 C:/backups",
                ["默认模型：C:/backups", "备份目录是 D:/backups"],
            ),
            ("conflict", "备份目录是 D:/backups"),
        )

    def test_an_identical_line_is_a_duplicate_before_any_subject_check(self):
        self.assertEqual(classify_against("端口是 8080", ["端口是 8080"]), ("duplicate", "端口是 8080"))


if __name__ == "__main__":
    unittest.main()
