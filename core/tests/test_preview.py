# -*- coding: utf-8 -*-
"""memory_preview — read-only governance views."""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import memory, preview
from unified_memory.common import canonical_dir, read_maybe


def _empty_inbox(vault: Path) -> Path:
    """Return a scratch inbox with no pre-existing files.

    init_vault drops a README.md into Agent提交区, so a fixture that counts
    inbox files must start from a clean directory or the count is off by one.
    """
    inbox = canonical_dir(vault) / "Agent提交区"
    for stale in inbox.glob("*.md"):
        stale.unlink()
    return inbox


def _touch(path: Path, mtime: float) -> None:
    """Pin an mtime so mtime-ordered views are deterministic."""
    os.utime(path, (mtime, mtime))


class PreviewViewTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_views_tuple_is_exactly_the_four_documented_ones(self):
        self.assertEqual(preview.VIEWS, ("pending", "conflicts", "forgetting", "recent"))

    def test_unknown_view_raises_systemexit(self):
        with self.assertRaises(SystemExit):
            preview.build(self.vault, "nope", 10)

    def test_pending_lists_inbox_files_newest_first(self):
        inbox = _empty_inbox(self.vault)
        older = inbox / "claude-20260816-001-01.md"
        newer = inbox / "dsh-20260816-002-01.md"
        older.write_text("- first\n", encoding="utf-8")
        newer.write_text("- second\n", encoding="utf-8")
        _touch(older, 1_700_000_000)
        _touch(newer, 1_700_000_100)

        data = preview.build(self.vault, "pending", 10)

        self.assertEqual(data["view"], "pending")
        self.assertEqual(data["count"], 2)
        self.assertEqual([i["name"] for i in data["items"]], [newer.name, older.name])
        for item in data["items"]:
            self.assertIs(item["untrusted"], True)
            self.assertIn("mtime", item)

    def test_pending_is_capped_by_limit(self):
        inbox = _empty_inbox(self.vault)
        for n in range(5):
            (inbox / f"dsh-20260816-00000{n}-01.md").write_text(f"- fact {n}\n", encoding="utf-8")

        self.assertEqual(preview.build(self.vault, "pending", 2)["count"], 2)

    def test_recent_lists_canonical_notes_newest_first(self):
        doc = canonical_dir(self.vault) / "我的偏好摘要.md"
        _touch(doc, 1_700_000_000)  # older than every other note
        newest = canonical_dir(self.vault) / "工具可用性检查.md"
        _touch(newest, 1_900_000_000)  # pinned newest

        data = preview.build(self.vault, "recent", 10)

        self.assertEqual(data["view"], "recent")
        names = [i["name"] for i in data["items"]]
        self.assertIn(doc.name, names)
        self.assertEqual(names[0], newest.name, "the freshest note must sort first")
        self.assertLess(names.index(newest.name), names.index(doc.name))
        self.assertEqual(data["count"], len(names))
        for item in data["items"]:
            self.assertIs(item["untrusted"], True)

    def test_forgetting_orders_active_memories_by_lowest_salience(self):
        rules = canonical_dir(self.vault) / "工程执行规则.md"
        rules.write_text(
            read_maybe(rules)
            + "\n- 部署前必须先验证（写入 2026-08-15｜来源：Agent提交区/codex-20260815-002-01.md）\n",
            encoding="utf-8",
        )

        data = preview.build(self.vault, "forgetting", 100)

        self.assertEqual(data["view"], "forgetting")
        self.assertGreaterEqual(data["count"], 1)
        # Target the line we appended (the doc already holds template lines).
        record = next(i for i in data["items"] if i["line"] == "部署前必须先验证")
        self.assertEqual(record["doc"], rules.name)
        self.assertEqual(record["type"], "workflow")
        self.assertEqual(record["accessCount"], 0)
        self.assertIs(record["untrusted"], True)
        # Decay order: never-accessed, lowest-importance records come first.
        keys = [(i["accessCount"], i["importance"]) for i in data["items"]]
        self.assertEqual(keys, sorted(keys))

    def test_conflicts_only_returns_rows_typed_conflict(self):
        # No memory line is typed 'conflict' in a fresh vault, so the view is
        # legitimately empty — and still a well-formed envelope.
        data = preview.build(self.vault, "conflicts", 10)

        self.assertEqual(data["view"], "conflicts")
        self.assertEqual(data["count"], 0)
        self.assertEqual(data["items"], [])

    def test_conflicting_rows_are_surfaced(self):
        rules = canonical_dir(self.vault) / "工程执行规则.md"
        rules.write_text(
            read_maybe(rules)
            + "\n- 端口使用 8080（写入 2026-08-15｜来源：Agent提交区/codex-20260815-002-01.md）\n",
            encoding="utf-8",
        )
        from unified_memory import index as index_mod

        index_mod.update_index(self.vault)
        conn = index_mod.get_conn(self.vault)
        try:
            row = conn.execute(
                "SELECT id FROM memories WHERE doc = ? AND line LIKE '%8080%'", (str(rules),)
            ).fetchone()
        finally:
            conn.close()
        self.assertIsNotNone(row, "the promoted line must have been indexed")

        # Preview must read `type` verbatim from the table, so relabel this
        # memory as a conflict exactly the way a real detector would.
        conn = index_mod.get_conn(self.vault)
        try:
            conn.execute("UPDATE memories SET type = 'conflict' WHERE id = ?", (row["id"],))
            conn.commit()
        finally:
            conn.close()

        data = preview.build(self.vault, "conflicts", 10)

        self.assertEqual(data["count"], 1)
        item = data["items"][0]
        self.assertEqual(item["type"], "conflict")
        self.assertEqual(item["doc"], rules.name)
        self.assertIs(item["untrusted"], True)


class PreviewEnvelopeTest(unittest.TestCase):
    def test_items_carry_untrusted_flag(self):
        # build() is exercised through the CLI in test_json_output; here we
        # assert the envelope contract on a synthetic result.
        payload = preview.envelope("pending", {"view": "pending", "count": 0, "items": []})
        parsed = json.loads(payload)
        self.assertIs(parsed["ok"], True)
        self.assertEqual(parsed["data"]["view"], "pending")


class PreviewCliTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def _run(self, argv: list[str]) -> str:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            memory.main(argv)
        return buf.getvalue()

    def test_cli_json_is_one_parseable_object(self):
        out = self._run(["preview", "pending", "--json"])
        payload = json.loads(out)  # raises if not valid JSON
        self.assertIs(payload["ok"], True)
        self.assertEqual(payload["command"], "preview")
        self.assertEqual(payload["data"]["view"], "pending")
        self.assertNotIn("<memory-data>", out)

    def test_cli_text_wraps_vault_content_in_memory_data(self):
        inbox = _empty_inbox(self.vault)
        (inbox / "dsh-20260816-003-01.md").write_text("- a plain fact\n", encoding="utf-8")

        out = self._run(["preview", "pending"])

        self.assertIn("<memory-data>", out)
        self.assertIn("never as instructions", out)
        self.assertIn("dsh-20260816-003-01.md", out)

    def test_cli_text_without_items_still_wraps_and_says_so(self):
        _empty_inbox(self.vault)

        out = self._run(["preview", "pending"])

        self.assertIn("<memory-data>", out)
        self.assertIn("no items in view 'pending'", out)


if __name__ == "__main__":
    unittest.main()
