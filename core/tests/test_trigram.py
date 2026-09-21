# -*- coding: utf-8 -*-
"""trigram tokenizer support for CJK substring recall."""
from __future__ import annotations

import sqlite3
import unittest

from unified_memory import index, schema


class TrigramProbeTest(unittest.TestCase):
    def test_probe_reports_true_on_this_sqlite(self):
        conn = sqlite3.connect(":memory:")
        try:
            self.assertIs(schema.probe_trigram(conn), True)
        finally:
            conn.close()

    def test_probe_reports_false_when_tokenizer_missing(self):
        # A plain sqlite3.Connection has a read-only `execute`, so the
        # monkeypatch below only works on a subclass created via `factory=`.
        class Bare(sqlite3.Connection):
            pass

        conn = sqlite3.connect(":memory:", factory=Bare)
        try:
            # Simulate an older SQLite by making the CREATE fail.
            conn.execute("CREATE TABLE _blocker (x)")
            orig = conn.execute

            def fake(sql, *a, **k):
                if "trigram" in sql:
                    raise sqlite3.OperationalError("no such tokenizer: trigram")
                return orig(sql, *a, **k)

            conn.execute = fake  # type: ignore[method-assign]
            self.assertIs(schema.probe_trigram(conn), False)
        finally:
            conn.close()

    def test_probe_leaves_no_probe_table_behind(self):
        conn = sqlite3.connect(":memory:")
        try:
            schema.probe_trigram(conn)
            names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master").fetchall()}
            self.assertNotIn("_trigram_probe", names)
        finally:
            conn.close()


class TrigramMatchTest(unittest.TestCase):
    def test_trigram_matches_a_cjk_substring(self):
        conn = sqlite3.connect(":memory:")
        try:
            conn.execute("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')")
            conn.execute("INSERT INTO t(x) VALUES (?)", ("记忆系统升级方案",))
            rows = conn.execute("SELECT x FROM t WHERE t MATCH ?", ("忆系统",)).fetchall()
            self.assertEqual(len(rows), 1)
        finally:
            conn.close()


class TrigramSearchTest(unittest.TestCase):
    """Integration: schema DDL + update_memories fill + substring recall."""

    def setUp(self):
        from core.tests.test_common import make_scratch_vault

        self.vault = make_scratch_vault()
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        from core.tests.test_common import destroy_scratch

        destroy_scratch(self.vault)

    def _write_note(self, name, body):
        canonical = index.canonical_dir(self.vault)
        canonical.mkdir(parents=True, exist_ok=True)
        (canonical / name).write_text(body, encoding="utf-8")

    def _tri_count(self):
        conn = schema.get_conn(self.vault)
        try:
            return conn.execute("SELECT COUNT(*) FROM fts_mem_tri").fetchone()[0]
        finally:
            conn.close()

    def test_schema_creates_the_trigram_table(self):
        conn = schema.get_conn(self.vault)
        try:
            row = conn.execute(
                "SELECT name FROM sqlite_master WHERE name = 'fts_mem_tri'"
            ).fetchone()
            self.assertIsNotNone(row, "fts_mem_tri should exist on a trigram-capable SQLite")
        finally:
            conn.close()

    def test_trigram_search_matches_a_cjk_substring(self):
        # 记忆系统升级方案 — the query 忆系统 is a mid-word substring that the
        # default tokenizer cannot match; trigram can.
        self._write_note("方案.md", "# 标题\n- 记忆系统升级方案已落地\n")
        index.update_index(self.vault)
        hits = index.trigram_memory_search(self.vault, "忆系统")
        lines = [h["line"] for h in hits]
        self.assertIn("记忆系统升级方案已落地", lines)
        for key in ("id", "doc", "line", "type", "importance", "source_agent"):
            self.assertIn(key, hits[0])

    def test_trigram_search_returns_empty_when_table_missing(self):
        # Drop the table to simulate an older SQLite that never created it.
        conn = schema.get_conn(self.vault)
        try:
            conn.execute("DROP TABLE IF EXISTS fts_mem_tri")
            conn.commit()
        finally:
            conn.close()
        self.assertEqual(index.trigram_memory_search(self.vault, "忆系统"), [])

    def test_rebuild_syncs_rows_to_the_trigram_table(self):
        # The index is built lazily, and make_scratch_vault seeds a template
        # note, so rows appear only after update_index. The invariant that
        # matters is parity with the base FTS table, plus the new memory line.
        self._write_note("方案.md", "# 标题\n- 记忆系统升级方案已落地\n")
        index.update_index(self.vault)
        conn = schema.get_conn(self.vault)
        try:
            base = conn.execute("SELECT COUNT(*) FROM fts_mem").fetchone()[0]
            tri = conn.execute("SELECT COUNT(*) FROM fts_mem_tri").fetchone()[0]
            lines = [r[0] for r in conn.execute("SELECT line FROM fts_mem_tri").fetchall()]
        finally:
            conn.close()
        self.assertGreater(base, 0)
        self.assertEqual(tri, base)
        self.assertIn("记忆系统升级方案已落地", lines)

    def test_stale_doc_purge_clears_trigram_rows(self):
        self._write_note("方案.md", "# 标题\n- 记忆系统升级方案已落地\n")
        index.update_index(self.vault)
        before = self._tri_count()
        self.assertGreater(before, 0)
        # Delete the note from the vault, then rebuild: the stale-doc purge
        # path (index.py:233) must also clear fts_mem_tri.
        canonical = index.canonical_dir(self.vault)
        (canonical / "方案.md").unlink()
        index.update_index(self.vault)
        after = self._tri_count()
        self.assertLess(after, before)
        conn = schema.get_conn(self.vault)
        try:
            base = conn.execute("SELECT COUNT(*) FROM fts_mem").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(after, base)

    def test_backfills_a_previously_indexed_vault(self):
        # Regression: on an EXISTING database every note is already indexed, so
        # update_memories skips all of them (digest unchanged) and a brand-new
        # fts_mem_tri would stay empty forever. Building once, dropping the
        # trigram table, then re-indexing must repopulate it without a
        # SCHEMA_VERSION bump (which would destroy rows).
        self._write_note("方案.md", "# 标题\n- 记忆系统升级方案已落地\n")
        index.update_index(self.vault)
        conn = schema.get_conn(self.vault)
        try:
            base = conn.execute("SELECT COUNT(*) FROM fts_mem").fetchone()[0]
            self.assertGreater(base, 0)
            conn.execute("DROP TABLE fts_mem_tri")
            conn.commit()
        finally:
            conn.close()
        # This rebuild sees no changed docs, yet must still restore the table.
        index.update_index(self.vault)
        hits = index.trigram_memory_search(self.vault, "忆系统")
        self.assertIn("记忆系统升级方案已落地", [h["line"] for h in hits])
        self.assertEqual(self._tri_count(), base)

    def test_backfill_does_not_reset_existing_data(self):
        # The backfill must never trip _migrate_schema's destructive reset.
        self._write_note("方案.md", "# 标题\n- 记忆系统升级方案已落地\n")
        index.update_index(self.vault)
        conn = schema.get_conn(self.vault)
        try:
            before = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        finally:
            conn.close()
        index.update_index(self.vault)
        conn = schema.get_conn(self.vault)
        try:
            after = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(after, before)
        self.assertGreater(after, 0)

    def test_existing_fts_tables_keep_the_default_tokenizer(self):
        # Regression guard: fts/fts_mem must NOT gain a tokenizer clause.
        # A mid-word CJK substring must still NOT match there (default
        # tokenizer = unicode61, which cannot split 忆系统 out of a run).
        self._write_note("方案.md", "# 标题\n- 记忆系统升级方案已落地\n")
        index.update_index(self.vault)
        conn = schema.get_conn(self.vault)
        try:
            sqls = {
                r[0]: r[1]
                for r in conn.execute(
                    "SELECT name, sql FROM sqlite_master WHERE name IN ('fts', 'fts_mem', 'fts_mem_tri')"
                ).fetchall()
            }
            self.assertNotIn("tokenize", sqls["fts"])
            self.assertNotIn("tokenize", sqls["fts_mem"])
            self.assertIn("tokenize='trigram'", sqls["fts_mem_tri"])
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
