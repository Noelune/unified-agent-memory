# -*- coding: utf-8 -*-
"""Tests for the memory database layer (unified_memory.index)."""
import unittest

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import index, common


class IndexTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def _append(self, doc_id, text):
        path = common.canonical_path(self.vault, doc_id)
        path.write_text(path.read_text(encoding="utf-8") + text, encoding="utf-8")

    def test_update_index_builds_memories_with_types_and_importance(self):
        self._append("prefs", "\n- 用户偏好简体中文回复（写入 2026-08-16｜来源：Agent提交区/claude-20260816-001-01.md）\n")
        self._append("rules", "\n- 部署前必须先验证（写入 2026-08-15｜来源：Agent提交区/codex-20260815-002-01.md）\n")
        index.update_index(self.vault)
        rows = {m["line"]: m for m in index.active_memories(self.vault)}
        self.assertEqual(rows["用户偏好简体中文回复"]["type"], "preference")
        self.assertEqual(rows["用户偏好简体中文回复"]["source_agent"], "claude")
        self.assertGreater(rows["用户偏好简体中文回复"]["importance"], 0.8)
        self.assertEqual(rows["部署前必须先验证"]["type"], "workflow")
        self.assertEqual(rows["部署前必须先验证"]["source_agent"], "codex")

    def test_superseded_section_is_marked(self):
        self._append(
            "env",
            "\n## 已取代\n- 旧版使用 8080 端口（写入 2026-01-01｜来源：Agent提交区/claude-20260101-001-01.md）\n",
        )
        index.update_index(self.vault)
        mems = index.active_memories(self.vault)
        self.assertTrue(all(m["status"] == "active" for m in mems))
        with index.get_conn(self.vault) as conn:
            row = conn.execute(
                "SELECT status FROM memories WHERE line = '旧版使用 8080 端口'"
            ).fetchone()
        self.assertEqual(row["status"], "superseded")

    def test_stale_docs_are_removed(self):
        prefs = common.canonical_path(self.vault, "prefs")
        prefs.write_text("# Preferences\n\n- stable-token-abc\n", encoding="utf-8")
        index.update_index(self.vault)
        with index.get_conn(self.vault) as conn:
            count = conn.execute(
                "SELECT COUNT(*) AS c FROM memories WHERE line = 'stable-token-abc'"
            ).fetchone()["c"]
        self.assertEqual(count, 1)
        prefs.unlink()
        index.update_index(self.vault)
        with index.get_conn(self.vault) as conn:
            count = conn.execute(
                "SELECT COUNT(*) AS c FROM memories WHERE line = 'stable-token-abc'"
            ).fetchone()["c"]
            doc = conn.execute("SELECT COUNT(*) AS c FROM docs WHERE path = ?", (str(prefs),)).fetchone()["c"]
        self.assertEqual(count, 0)
        self.assertEqual(doc, 0)

    def test_fts_search_returns_legacy_shape(self):
        self._append("prefs", "\n- prefers indigo terminal prompts\n")
        result = index.fts_search(self.vault, "indigo", 8)
        self.assertEqual(result["ok"], True)
        self.assertEqual(result["count"], 1)
        self.assertIn("indigo", result["results"][0]["snippet"])
        self.assertIn("index", result)

    def test_record_access_increments_count(self):
        self._append("prefs", "\n- 常用路径是 D:/Projects\n")
        index.update_index(self.vault)
        mems = index.active_memories(self.vault)
        target = next(m for m in mems if m["line"] == "常用路径是 D:/Projects")
        index.record_access(self.vault, [target["id"]])
        index.record_access(self.vault, [target["id"]])
        with index.get_conn(self.vault) as conn:
            count = conn.execute(
                "SELECT access_count FROM memories WHERE id = ?", (target["id"],)
            ).fetchone()["access_count"]
            log_rows = conn.execute("SELECT COUNT(*) AS c FROM access_log").fetchone()["c"]
        self.assertEqual(count, 2)
        self.assertEqual(log_rows, 2)

    def test_index_is_isolated_per_vault(self):
        second = self.vault.parent / "second-vault"
        first_db = index.index_db_for(self.vault)
        second_db = index.index_db_for(second)
        self.assertNotEqual(first_db, second_db)
        self.assertEqual(first_db.name, f"index-{hashlib_hex(self.vault)[:16]}.db")


def hashlib_hex(vault):
    import hashlib
    return hashlib.sha256(str(vault.resolve()).encode("utf-8")).hexdigest()


if __name__ == "__main__":
    unittest.main()
