# -*- coding: utf-8 -*-
import threading
import unittest
from pathlib import Path

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import memory as mem_mod, promoter
from unified_memory.common import canonical_dir, canonical_path, read_maybe, situation_dir
from unified_memory.conflict import append_conflict, read_conflicts, remove_conflict, similarity


class PromoterTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def write_inbox(self, name, facts):
        path = canonical_dir(self.vault) / "Agent提交区" / name
        path.write_text("\n".join(f"- {f}" for f in facts) + "\n", encoding="utf-8")
        return path

    def seed_canonical(self, doc, fact):
        path = canonical_path(self.vault, doc)
        path.write_text(
            path.read_text(encoding="utf-8") + f"\n- {fact}（写入 2026-08-01｜来源：Agent提交区/x.md）\n",
            encoding="utf-8",
        )

    def test_bigram_similarity(self):
        self.assertEqual(similarity("hello world", "hello world"), 1.0)
        self.assertGreater(similarity("the server is on port 8080", "the server is on port 8081"), 0.5)
        self.assertLess(similarity("cats like fish", "build server on port 8080"), 0.5)

    def test_review_classifies_and_writes_pending_list(self):
        self.write_inbox("dsh-20260814-120000-01.md", ["prefers dark theme in the UI"])
        result = promoter.review(self.vault, verbose=False)
        self.assertEqual(result["pending"][0]["doc"], "ui")
        promoter.write_pending_list(self.vault, result)
        pending_file = situation_dir(self.vault) / "待晋升.md"
        self.assertIn("prefers dark theme", read_maybe(pending_file))

    def test_pending_facts_keep_field_markers_and_fullwidth_separators(self):
        fact = "release label contains 来源:local｜目标:safe"
        self.write_inbox("dsh-20260814-120000-01.md", [fact])
        result = promoter.review(self.vault, verbose=False)
        promoter.write_pending_list(self.vault, result)
        self.assertEqual(promoter.parse_pending_list(self.vault)[0]["内容"], fact)

    def test_review_detects_duplicate(self):
        self.seed_canonical("ui", "prefers dark theme in the UI")
        self.write_inbox("dsh-20260814-120000-01.md", ["prefers dark theme in the UI"])
        result = promoter.review(self.vault, verbose=False)
        self.assertEqual(result["duplicates"], 1)
        self.assertEqual(result["pending"], [])

    def test_review_detects_conflict_and_queues_it(self):
        self.seed_canonical("ui", "prefers dark theme in the UI")
        self.write_inbox("dsh-20260814-120000-01.md", ["prefers light theme in the UI"])
        result = promoter.review(self.vault, verbose=False)
        self.assertEqual(result["conflicts"], 1)
        conflict_file = situation_dir(self.vault) / "事实冲突待裁决.md"
        self.assertIn("prefers light theme", read_maybe(conflict_file))

    def test_repeated_review_does_not_duplicate_the_same_conflict(self):
        self.seed_canonical("ui", "prefers dark theme in the UI")
        self.write_inbox("dsh-20260814-120000-01.md", ["prefers light theme in the UI"])
        promoter.review(self.vault, verbose=False)
        promoter.review(self.vault, verbose=False)
        self.assertEqual(len(read_conflicts(self.vault)), 1)

    def test_concurrent_conflict_appends_do_not_drop_entries(self):
        start = threading.Barrier(8)
        errors = []

        def append(index):
            try:
                start.wait()
                append_conflict(
                    self.vault,
                    f"new concurrent fact {index}",
                    f"old concurrent fact {index}",
                    f"source-{index}.md",
                    "env",
                )
            except Exception as exc:  # retain worker failures for the main assertion
                errors.append(exc)

        workers = [threading.Thread(target=append, args=(index,)) for index in range(8)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=10)

        self.assertEqual(errors, [])
        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual({item["新"] for item in read_conflicts(self.vault)}, {f"new concurrent fact {index}" for index in range(8)})

    def test_apply_promotes_and_archives(self):
        src = self.write_inbox("dsh-20260814-120000-01.md", ["the build cache directory lives at <your-home>/.cache"])
        result = promoter.review(self.vault, verbose=False)
        promoter.write_pending_list(self.vault, result)
        n = promoter.apply_pending(self.vault, verbose=False)
        self.assertEqual(n, 1)
        env_doc = canonical_path(self.vault, "env")
        self.assertIn("build cache directory lives at <your-home>/.cache", read_maybe(env_doc))
        self.assertFalse(src.exists(), "inbox file must be archived")
        done = canonical_dir(self.vault) / "Agent提交区" / "已处理" / src.name
        self.assertTrue(done.is_file())

    def test_archive_preserves_existing_processed_file_with_the_same_name(self):
        src = self.write_inbox("dsh-20260814-120000-01.md", ["new source content"])
        done = canonical_dir(self.vault) / "Agent提交区" / "已处理"
        done.mkdir(parents=True, exist_ok=True)
        (done / src.name).write_text("old archived content\n", encoding="utf-8")
        promoter.archive_sources(self.vault, {src.name})
        archived = sorted(done.glob("dsh-20260814-120000-01*.md"))
        self.assertFalse(src.exists())
        self.assertEqual(len(archived), 2)
        self.assertEqual({p.read_text(encoding="utf-8") for p in archived}, {"old archived content\n", "- new source content\n"})

    def test_apply_archives_every_source_from_the_review_snapshot(self):
        self.seed_canonical("ui", "prefers dark theme in the UI")
        duplicate = self.write_inbox("dsh-20260814-120000-01.md", ["prefers dark theme in the UI"])
        pending = self.write_inbox("dsh-20260814-120000-02.md", ["prefers compact controls in the UI"])
        result = promoter.review(self.vault, verbose=False)
        promoter.write_pending_list(self.vault, result)
        late = self.write_inbox("dsh-20260814-120000-03.md", ["arrived after review"])
        promoter.apply_pending(self.vault, verbose=False)
        done = canonical_dir(self.vault) / "Agent提交区" / "已处理"
        self.assertTrue((done / duplicate.name).is_file())
        self.assertTrue((done / pending.name).is_file())
        self.assertTrue(late.is_file(), "apply must not archive files that arrived after review")

    def test_promote_dedups_repeated_pending_entries(self):
        entries = [
            {"doc": "env", "fact": "the same fact token", "source": "x.md"},
            {"doc": "env", "fact": "the same fact token", "source": "x.md"},
        ]
        promoted = promoter.promote(self.vault, entries)
        self.assertEqual(len(promoted), 1)
        text = read_maybe(canonical_path(self.vault, "env"))
        self.assertEqual(text.count("the same fact token"), 1)

    def test_auto_promotes_in_one_step(self):
        # Use a fact that classifies to rules but is NOT a template placeholder,
        # so the assertion is real (the old test matched a template line).
        self.write_inbox("dsh-20260814-120000-01.md", ["every deploy must pass the audit gate before release"])
        n = promoter.auto_promote(self.vault, verbose=False)
        self.assertEqual(n, 1)
        rules_doc = canonical_path(self.vault, "rules")
        self.assertIn("every deploy must pass the audit gate before release", read_maybe(rules_doc))
        # It must be classified, not dumped into 未归类事实.md.
        self.assertNotIn(
            "every deploy must pass the audit gate before release",
            read_maybe(situation_dir(self.vault) / "未归类事实.md"),
        )
        # The source filename must be preserved in the write stamp.
        self.assertIn("来源：Agent提交区/dsh-20260814-120000-01.md", read_maybe(rules_doc))

    def test_file_lock_is_exclusive(self):
        from unified_memory.common import file_lock
        with file_lock(self.vault):
            with self.assertRaises(TimeoutError):
                with file_lock(self.vault, timeout_s=0.3, poll_s=0.05):
                    pass

    def test_adjudicate_resolves_conflict(self):
        from unittest.mock import patch
        self.seed_canonical("ui", "prefers dark theme in the UI")
        self.write_inbox("dsh-20260814-120000-01.md", ["prefers light theme in the UI"])
        promoter.review(self.vault, verbose=False)
        with patch("builtins.input", return_value="用新"):
            promoter.adjudicate(self.vault)
        ui_doc = canonical_path(self.vault, "ui")
        self.assertIn("prefers light theme", read_maybe(ui_doc))
        adjudicated = situation_dir(self.vault) / "事实冲突已裁决.md"
        self.assertIn("用新", read_maybe(adjudicated))

    def test_adjudicate_use_new_replaces_the_conflicting_old_fact(self):
        from unittest.mock import patch
        self.seed_canonical("ui", "prefers dark theme in the UI")
        self.write_inbox("dsh-20260814-120000-01.md", ["prefers light theme in the UI"])
        promoter.review(self.vault, verbose=False)
        with patch("builtins.input", return_value="用新"):
            promoter.adjudicate(self.vault)
        text = read_maybe(canonical_path(self.vault, "ui"))
        # "Replaces" means it leaves the active region — not that the line is
        # erased. `promote` has always retired a superseded value into 已取代;
        # this path used to delete it, so the note claimed the old value had
        # never existed and the only trace was the adjudication log.
        active, _, history = text.partition("## 已取代")
        active_facts = [line for line in active.splitlines() if line.startswith("- ")]
        self.assertTrue(any("prefers light theme in the UI" in line for line in active_facts))
        self.assertFalse(any("prefers dark theme in the UI" in line for line in active_facts))
        self.assertIn("prefers dark theme in the UI", history)

    def test_adjudicate_keep_both_retains_the_conflicting_old_fact(self):
        from unittest.mock import patch
        self.seed_canonical("ui", "prefers dark theme in the UI")
        self.write_inbox("dsh-20260814-120000-01.md", ["prefers light theme in the UI"])
        promoter.review(self.vault, verbose=False)
        with patch("builtins.input", return_value="并存"):
            promoter.adjudicate(self.vault)
        facts = [line for line in read_maybe(canonical_path(self.vault, "ui")).splitlines() if line.startswith("- ")]
        self.assertTrue(any("prefers dark theme in the UI" in line for line in facts))
        self.assertTrue(any("prefers light theme in the UI" in line for line in facts))

    def test_remove_conflict_only_removes_the_exact_entry(self):
        append_conflict(self.vault, "the relay uses a local broker", "old broker fact", "a.md", "env")
        append_conflict(self.vault, "the relay uses a local broker with TLS", "other broker fact", "b.md", "env")
        first, second = read_conflicts(self.vault)
        remove_conflict(self.vault, first)
        self.assertEqual(read_conflicts(self.vault), [second])

    def test_conflict_facts_keep_fullwidth_separator_characters(self):
        fact = "feature｜fix is the release branch label"
        append_conflict(self.vault, fact, "old branch label", "a.md", "env")
        self.assertEqual(read_conflicts(self.vault)[0]["新"], fact)

    def test_review_detects_supersession_not_conflict(self):
        # A replacement cue ("instead of") with a similar fact is a supersession,
        # routed to the pending list — not to the conflict queue.
        self.seed_canonical("coord", "the relay broker listens on 19121")
        self.write_inbox("dsh-20260814-120000-01.md", ["the relay broker now listens on 19999 instead of 19121"])
        result = promoter.review(self.vault, verbose=False)
        self.assertEqual(result["conflicts"], 0)
        self.assertEqual(result["supersessions"], 1)
        self.assertEqual(result["pending"][0]["supersede"], "the relay broker listens on 19121")
        self.assertEqual(len(read_conflicts(self.vault)), 0)

    def test_apply_moves_superseded_fact_under_deprecated_section(self):
        self.seed_canonical("coord", "the relay broker listens on 19121")
        self.write_inbox("dsh-20260814-120000-01.md", ["the relay broker now listens on 19999 instead of 19121"])
        result = promoter.review(self.vault, verbose=False)
        promoter.write_pending_list(self.vault, result)
        promoter.apply_pending(self.vault, verbose=False)
        text = read_maybe(canonical_path(self.vault, "coord"))
        self.assertIn("the relay broker now listens on 19999", text)
        self.assertIn("## 已取代", text)
        self.assertIn("the relay broker listens on 19121", text)

    def test_chinese_fact_classifies_to_env(self):
        self.write_inbox("claude-20260814-120000-01.md", ["服务端口已改为 9090"])
        result = promoter.review(self.vault, verbose=False)
        self.assertEqual(result["pending"][0]["doc"], "env")

    def test_chinese_preference_classifies_to_prefs(self):
        self.write_inbox("claude-20260814-120000-01.md", ["用户偏好简体中文回复"])
        result = promoter.review(self.vault, verbose=False)
        self.assertEqual(result["pending"][0]["doc"], "prefs")


class HistorySectionTest(unittest.TestCase):
    """A note's 已取代 section is history, not truth.

    Every assertion here is a defect that shipped in 0.8.0. The common cause:
    three places treated "the note" as "the note's active region", and the
    boundary between the two was never named. A note that had grown a 已取代
    section once — i.e. any note that had ever been superseded — silently
    stopped accepting new facts.
    """

    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def write_inbox(self, name, facts):
        path = canonical_dir(self.vault) / "Agent提交区" / name
        path.write_text("\n".join(f"- {f}" for f in facts) + "\n", encoding="utf-8")
        return path

    def seed_with_history(self, doc, active, retired):
        path = canonical_path(self.vault, doc)
        path.write_text(
            path.read_text(encoding="utf-8")
            + f"\n- {active}（写入 2026-08-01｜来源：Agent提交区/x.md）\n"
            + "\n## 已取代\n\n"
            + f"- {retired}（写入 2026-07-01｜来源：Agent提交区/y.md）\n",
            encoding="utf-8",
        )
        return path

    def test_promote_puts_new_facts_above_the_history_heading(self):
        # The note already ends with 已取代 (a very ordinary state). Appending
        # to EOF put the new fact under that heading, where the index marks it
        # superseded — so it was written, stamped and locked, and unreachable.
        path = self.seed_with_history(
            "coord",
            "the relay broker listens on 19121",
            "the relay broker once used port 19000",
        )
        self.write_inbox("dsh-20260814-120000-01.md", ["the relay broker drains its queue every 30 seconds"])
        result = promoter.review(self.vault, verbose=False)
        promoter.write_pending_list(self.vault, result)
        promoter.apply_pending(self.vault, verbose=False)

        text = read_maybe(path)
        heading = text.index("## 已取代")
        self.assertLess(
            text.index("the relay broker drains its queue every 30 seconds"),
            heading,
            "new fact landed under 已取代 — it is now invisible to search",
        )
        self.assertGreater(text.index("the relay broker once used port 19000"), heading)

    def test_promote_leaves_exactly_one_history_section(self):
        path = self.seed_with_history("coord", "the relay broker listens on 19121", "the relay broker listens on 19000")
        # A supersession arriving at a note that already has the section must
        # merge into it, not create a second one at EOF.
        self.write_inbox(
            "dsh-20260814-120000-01.md",
            ["the relay broker now listens on 19999 instead of 19121"],
        )
        result = promoter.review(self.vault, verbose=False)
        promoter.write_pending_list(self.vault, result)
        promoter.apply_pending(self.vault, verbose=False)

        text = read_maybe(path)
        self.assertEqual(text.count("## 已取代"), 1)
        self.assertLess(text.index("the relay broker now listens on 19999"), text.index("## 已取代"))
        self.assertGreater(text.index("the relay broker listens on 19121"), text.index("## 已取代"))

    def test_review_does_not_treat_history_as_an_existing_fact(self):
        # The retired line is not in the comparison pool, so resubmitting it is
        # a new fact rather than a duplicate of itself. Reading the whole file
        # made every retired value answer "already known" and swallow the
        # submission — the revert could never be recorded.
        self.seed_with_history(
            "env",
            "the build server listens on 9090",
            "the deploy key rotates monthly on the first Monday",
        )
        self.write_inbox("dsh-20260814-120000-01.md", ["the deploy key rotates monthly on the first Monday"])
        result = promoter.review(self.vault, verbose=False)
        self.assertEqual(result["duplicates"], 0, "history was treated as a live fact")
        self.assertEqual(len(result["pending"]), 1)

    def test_adjudication_is_final(self):
        # `保留旧` and `跳过` leave both the inbox file and the canonical note
        # untouched, so without a record of the decision the next pass reaches
        # the same verdict forever. This is the loop the report called
        # "conflict 复现".
        self.seed_with_history("env", "the build server listens on 9090", "the build server listens on 8080")
        append_conflict(
            self.vault,
            "the build server listens on 8080",
            "the build server listens on 9090",
            "dsh-20260814-120000-01.md",
            "env",
        )
        self.assertEqual(len(read_conflicts(self.vault)), 1)

        answers = iter(["保留旧"])
        import builtins

        real_input = builtins.input
        builtins.input = lambda *_a, **_k: next(answers, "跳过")
        try:
            promoter.adjudicate(self.vault)
        finally:
            builtins.input = real_input

        self.assertEqual(len(read_conflicts(self.vault)), 0)
        self.write_inbox("dsh-20260814-120000-01.md", ["the build server listens on 8080"])
        again = promoter.review(self.vault, verbose=False)
        self.assertEqual(again["conflicts"], 0)
        self.assertEqual(len(read_conflicts(self.vault)), 0, "adjudicated conflict came back")
        self.assertEqual(again["adjudicated"], 1)

    def test_active_fact_lines_skips_history(self):
        path = self.seed_with_history("env", "active line", "retired line")
        facts = promoter.active_fact_lines(read_maybe(path))
        self.assertIn("active line", facts)
        self.assertNotIn("retired line", facts)


class SettledSourceArchiveTest(unittest.TestCase):
    """A ruled-on submission must leave the inbox — but only when it is spent.

    `decide` dequeued the conflict and wrote the note, yet left the submission
    in ``Agent提交区`` forever. `doctor` kept counting it as pending work, so the
    panel said the queue was clear while the counts said otherwise.
    """

    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def inbox(self):
        return canonical_dir(self.vault) / "Agent提交区"

    def write_inbox(self, name, facts):
        path = self.inbox() / name
        path.write_text("\n".join(f"- {f}" for f in facts) + "\n", encoding="utf-8")
        return path

    def seed_canonical(self, doc, fact):
        path = canonical_path(self.vault, doc)
        path.write_text(
            path.read_text(encoding="utf-8") + f"\n- {fact}（写入 2026-08-01｜来源：Agent提交区/x.md）\n",
            encoding="utf-8",
        )

    def test_a_fully_ruled_submission_is_archived(self):
        self.seed_canonical("ui", "prefers dark theme in the UI")
        self.write_inbox("dsh-20260814-120000-01.md", ["prefers light theme in the UI"])
        promoter.review(self.vault, verbose=False)
        entry = read_conflicts(self.vault)[0]

        result = promoter.decide(self.vault, entry, "用新")
        self.assertTrue(result["ok"])
        self.assertEqual(read_conflicts(self.vault), [])
        # Gone from the inbox: nothing in it is undecided any more.
        self.assertFalse((self.inbox() / "dsh-20260814-120000-01.md").exists())
        self.assertTrue(
            (self.inbox() / "已处理" / "dsh-20260814-120000-01.md").exists(),
            "the submission must be archived, not deleted",
        )

    def test_a_half_ruled_submission_stays_in_the_inbox(self):
        # One ruling is not the whole file. Archiving it here would silently
        # drop the fact nobody has decided on yet, so it must stay put and be
        # picked up by the next `review --apply`.
        self.seed_canonical("ui", "prefers dark theme in the UI")
        self.write_inbox(
            "dsh-20260814-120000-02.md",
            ["prefers light theme in the UI", "the release branch is called stable"],
        )
        promoter.review(self.vault, verbose=False)
        entry = read_conflicts(self.vault)[0]

        promoter.decide(self.vault, entry, "用新")

        staying = self.inbox() / "dsh-20260814-120000-02.md"
        self.assertTrue(staying.exists(), "an undecided fact was archived away")
        self.assertIn("release branch is called stable", read_maybe(staying))


if __name__ == "__main__":
    unittest.main()
