# -*- coding: utf-8 -*-
import unittest
from pathlib import Path

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import promoter
from unified_memory.common import canonical_path, read_maybe


class RepairExistingTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def seed(self, doc, facts):
        path = canonical_path(self.vault, doc)
        path.write_text(path.read_text(encoding="utf-8") + "".join(f"- {f}\n" for f in facts), encoding="utf-8")

    def test_dry_run_changes_nothing(self):
        self.seed("rules", ["verify builds before claiming success（示例）"])
        before = read_maybe(canonical_path(self.vault, "rules"))
        promoter.repair_existing(self.vault, dry_run=True)
        self.assertEqual(read_maybe(canonical_path(self.vault, "rules")), before)

    def test_removes_duplicates_and_placeholders_with_backup(self):
        self.seed("ui", [
            "prefers dark theme in the UI（写入 2026-08-01｜来源：Agent提交区/x.md）",
            "prefers dark theme in the UI（写入 2026-08-02｜来源：Agent提交区/y.md）",
            "示例：a placeholder（示例，替换为你的内容）",
        ])
        result = promoter.repair_existing(self.vault, dry_run=False)
        text = read_maybe(canonical_path(self.vault, "ui"))
        self.assertIn("prefers dark theme in the UI（写入 2026-08-01｜来源：Agent提交区/x.md）", text)
        self.assertNotIn("（写入 2026-08-02｜来源：Agent提交区/y.md）", text)
        self.assertNotIn("示例：a placeholder", text)
        self.assertGreaterEqual(result["removed_items"], 2)
        backup = Path(result["backup_root"])
        self.assertTrue(backup.is_dir())
        self.assertGreaterEqual(len(list(backup.glob("*.md"))), 1)

    def test_keeps_real_urls_with_example(self):
        self.seed("env", ["the docs mirror lives at https://example.com/docs"])
        promoter.repair_existing(self.vault, dry_run=False)
        self.assertIn("https://example.com/docs", read_maybe(canonical_path(self.vault, "env")))


if __name__ == "__main__":
    unittest.main()
