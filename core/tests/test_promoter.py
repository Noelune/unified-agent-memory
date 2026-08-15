# -*- coding: utf-8 -*-
import os
import unittest

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import memory as mem_mod, promoter
from unified_memory.common import canonical_dir, canonical_path, read_maybe, situation_dir
from unified_memory.conflict import similarity


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


if __name__ == "__main__":
    unittest.main()
