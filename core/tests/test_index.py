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

    def test_hermes_stamp_attributes_date_and_agent(self):
        self._append(
            "env",
            "\n- 线上 Hermes 归档在 D 盘（写入 2026-09-22｜来源：[[Agent提交区/dsh-20260921-223255-01.md]]）\n",
        )
        index.update_index(self.vault)
        with index.get_conn(self.vault) as conn:
            row = conn.execute(
                "SELECT created_at, source_agent FROM memories WHERE line LIKE '%Hermes 归档%'"
            ).fetchone()
        self.assertTrue(row["created_at"].startswith("2026-09-22"))
        self.assertEqual(row["source_agent"], "dsh")

    def test_versioned_line_is_superseded(self):
        self._append(
            "env",
            "\n- 旧端口是 8080（写入 2026-01-01｜来源：[[Agent提交区/x-1.md]]｜有效至 2026-02-01）\n",
        )
        index.update_index(self.vault)
        with index.get_conn(self.vault) as conn:
            row = conn.execute(
                "SELECT status FROM memories WHERE line = '旧端口是 8080'"
            ).fetchone()
        self.assertEqual(row["status"], "superseded")
        self.assertNotIn("旧端口是 8080", [m["line"] for m in index.active_memories(self.vault)])

    def test_access_count_survives_a_note_edit(self):
        self._append("prefs", "\n- 用户偏好深色终端\n")
        index.update_index(self.vault)
        target = next(m for m in index.active_memories(self.vault) if m["line"] == "用户偏好深色终端")
        index.record_access(self.vault, [target["id"]])
        index.record_access(self.vault, [target["id"]])
        # Edit the same note (adds a different fact) -> full note rebuild.
        self._append("prefs", "\n- 用户偏好等宽字体\n")
        index.update_index(self.vault)
        with index.get_conn(self.vault) as conn:
            count = conn.execute(
                "SELECT access_count FROM memories WHERE id = ?", (target["id"],)
            ).fetchone()["access_count"]
        self.assertEqual(count, 2, "a note edit must not reset reinforcement history")

    def test_embedding_survives_a_note_edit(self):
        self._append("prefs", "\n- 用户偏好深色终端\n")
        index.update_index(self.vault)
        target = next(m for m in index.active_memories(self.vault) if m["line"] == "用户偏好深色终端")
        with index.get_conn(self.vault) as conn:
            conn.execute(
                "INSERT INTO embeddings (memory_id, dim, vector) VALUES (?, 4, ?)",
                (target["id"], b"\0" * 16),
            )
            conn.commit()
        self._append("prefs", "\n- 用户偏好等宽字体\n")
        index.update_index(self.vault)
        with index.get_conn(self.vault) as conn:
            vectors = conn.execute(
                "SELECT COUNT(*) FROM embeddings WHERE memory_id = ?", (target["id"],)
            ).fetchone()[0]
        self.assertEqual(vectors, 1, "an edit must not force a paid re-embed of unchanged lines")

    def test_sync_conflict_copy_is_not_indexed(self):
        ctx = common.canonical_dir(self.vault)
        (ctx / "prefs 2.md").write_text(
            "# conflict copy\n\n- unique-conflict-copy-token\n", encoding="utf-8"
        )
        index.update_index(self.vault)
        with index.get_conn(self.vault) as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM memories WHERE line = 'unique-conflict-copy-token'"
            ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_cjk_bigram_search_matches_a_two_char_query(self):
        self._append("env", "\n- 记忆索引保存在本地 SQLite\n")
        index.update_index(self.vault)
        rows = index.bm25_bigram_search(self.vault, "记忆", limit=5)
        self.assertTrue(any("记忆索引" in row["line"] for row in rows))

    def test_fts_search_returns_the_matched_line(self):
        self._append("env", "\n- 记忆索引保存在本地 SQLite\n")
        result = index.fts_search(self.vault, "记忆", 5)
        self.assertTrue(result["results"])
        self.assertTrue(any("记忆索引" in r["snippet"] for r in result["results"]))

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
