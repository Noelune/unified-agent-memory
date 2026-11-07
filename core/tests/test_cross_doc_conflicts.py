# -*- coding: utf-8 -*-
"""Cross-document conflict detection (batch A).

The target-note comparison could never see a contradiction that lived in a
different canonical note: "同步端口为 9443" classifies into env while the old
"同步端口为 8443" sat in rules — invisible forever. review() now recalls
corpus-wide candidates and applies the same subject/value rules.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import promoter

from unified_memory.app.govern.queue import read_conflicts
from unified_memory.infra.vault import canonical_dir, canonical_path, situation_dir

OLD_LINE = "- 同步端口为 8443（写入 2026-01-01｜来源：Agent提交区/old-20260101-01.md）\n"

def _submit(vault: Path, name: str, fact: str) -> None:
    inbox = canonical_dir(vault) / "Agent提交区"
    inbox.mkdir(parents=True, exist_ok=True)
    (inbox / name).write_text("- " + fact + "\n", encoding="utf-8")

class CrossDocConflictTests(unittest.TestCase):
    def setUp(self) -> None:
        self.vault = make_scratch_vault()

    def tearDown(self) -> None:
        destroy_scratch(self.vault)

    def test_contradiction_in_another_note_is_queued(self) -> None:
        rules = canonical_path(self.vault, "rules")
        rules.write_text(
            rules.read_text(encoding="utf-8") + "\n" + OLD_LINE, encoding="utf-8"
        )
        _submit(self.vault, "tester-20260101-01.md", "同步端口为 9443")
        result = promoter.review(self.vault, verbose=False)
        self.assertEqual(result["cross_conflicts"], 1)
        self.assertFalse(any(p["fact"] == "同步端口为 9443" for p in result["pending"]))
        entries = read_conflicts(self.vault)
        self.assertTrue(
            any(
                e.get("新") == "同步端口为 9443" and e.get("跨文档") == "工程执行规则.md"
                for e in entries
            )
        )

    def test_same_sentence_in_another_note_is_not_a_conflict(self) -> None:
        rules = canonical_path(self.vault, "rules")
        rules.write_text(
            rules.read_text(encoding="utf-8")
            + "\n- 备份目录是 D:/backups（写入 2026-01-01｜来源：Agent提交区/old-20260101-01.md）\n",
            encoding="utf-8",
        )
        _submit(self.vault, "tester-20260101-01.md", "备份目录是 D:/backups")
        result = promoter.review(self.vault, verbose=False)
        self.assertEqual(result["cross_conflicts"], 0)
        self.assertTrue(
            any(p["fact"] == "备份目录是 D:/backups" for p in result["pending"])
        )
        self.assertEqual(read_conflicts(self.vault), [])

    def test_lookalike_templates_are_not_conflicts(self) -> None:
        rules = canonical_path(self.vault, "rules")
        rules.write_text(
            rules.read_text(encoding="utf-8")
            + "\n- 默认模型是 openrouter/free（写入 2026-01-01｜来源：Agent提交区/old-20260101-01.md）\n",
            encoding="utf-8",
        )
        _submit(self.vault, "tester-20260101-01.md", "可用模型是 openrouter/free")
        result = promoter.review(self.vault, verbose=False)
        self.assertEqual(result["cross_conflicts"], 0)
        self.assertEqual(read_conflicts(self.vault), [])

    def test_target_note_conflict_still_works(self) -> None:
        env = canonical_path(self.vault, "env")
        env.write_text(
            env.read_text(encoding="utf-8")
            + "\n- 同步端口为 8443（写入 2026-01-01｜来源：Agent提交区/old-20260101-01.md）\n",
            encoding="utf-8",
        )
        _submit(self.vault, "tester-20260101-01.md", "同步端口为 9443")
        result = promoter.review(self.vault, verbose=False)
        self.assertEqual(result["conflicts"], 1)
        entries = read_conflicts(self.vault)
        self.assertTrue(any(e.get("新") == "同步端口为 9443" for e in entries))
        # Same-note hits carry no 跨文档 field.
        self.assertTrue(all(not e.get("跨文档") for e in entries))

if __name__ == "__main__":
    unittest.main()
