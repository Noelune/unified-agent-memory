# -*- coding: utf-8 -*-
import os
import subprocess
import sys
import threading
import time
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

    def test_file_lock_does_not_break_a_live_old_lock(self):
        """A healthy writer must keep exclusivity even after a long operation."""
        script = """
import os
import time
from pathlib import Path
from unified_memory.common import LOCK_FILE, file_lock

vault = Path(os.environ['UNIFIED_MEMORY_TEST_LOCK_VAULT'])
with file_lock(vault):
    old = time.time() - 601
    os.utime(vault / LOCK_FILE, (old, old))
    print('locked', flush=True)
    time.sleep(3)
"""
        env = os.environ.copy()
        env["UNIFIED_MEMORY_TEST_LOCK_VAULT"] = str(self.vault)
        process = subprocess.Popen(
            [sys.executable, "-c", script],
            cwd=Path(__file__).resolve().parents[1],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(lambda: process.poll() is None and process.kill())
        self.assertEqual(process.stdout.readline().strip(), "locked")

        from unified_memory.common import file_lock
        with self.assertRaises(TimeoutError):
            with file_lock(self.vault, timeout_s=0.2, poll_s=0.02):
                pass

        process.wait(timeout=5)
        stdout, stderr = process.communicate()
        self.assertEqual(process.returncode, 0, stderr)

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
        facts = [line for line in read_maybe(canonical_path(self.vault, "ui")).splitlines() if line.startswith("- ")]
        self.assertTrue(any("prefers light theme in the UI" in line for line in facts))
        self.assertFalse(any("prefers dark theme in the UI" in line for line in facts))

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


if __name__ == "__main__":
    unittest.main()
