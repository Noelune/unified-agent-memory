# -*- coding: utf-8 -*-
"""Lexical stream (batch A): one table, both languages.

Replaces test_trigram/test_hybrid_trigram, which pinned the three-table
layout. fts_mem (unicode61) returned zero hits on every pure-Chinese query
while holding the top RRF weight; fts_lex stores cjk_tokens output (ASCII
words + overlapping CJK bigrams) and is the only lexical ranker now.
"""
from __future__ import annotations

import sqlite3
import unittest

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import index, search
from unified_memory.common import canonical_path


class LexicalSearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.vault = make_scratch_vault()

    def tearDown(self) -> None:
        destroy_scratch(self.vault)

    def _append(self, text: str) -> None:
        prefs = canonical_path(self.vault, "prefs")
        prefs.write_text(prefs.read_text(encoding="utf-8") + "\n" + text, encoding="utf-8")
        index.update_index(self.vault)

    def test_two_char_chinese_query_matches(self) -> None:
        self._append("- 记忆索引保存在本地 SQLite\n")
        rows = index.lexical_search(self.vault, "记忆", limit=5)
        self.assertTrue(any("记忆索引" in r["line"] for r in rows))

    def test_long_chinese_substring_matches(self) -> None:
        self._append("- 记忆系统使用倒排索引\n")
        rows = index.lexical_search(self.vault, "忆系", limit=5)
        self.assertTrue(any("记忆系统" in r["line"] for r in rows))

    def test_english_word_matches(self) -> None:
        self._append("- prefers indigo terminal prompts\n")
        rows = index.lexical_search(self.vault, "indigo", limit=5)
        self.assertTrue(any("indigo" in r["line"] for r in rows))

    def test_limit_is_respected(self) -> None:
        self._append("- 记忆规则甲\n- 记忆规则乙\n- 记忆规则丙\n")
        self.assertEqual(len(index.lexical_search(self.vault, "记忆规则", limit=2)), 2)

    def test_superseded_lines_are_not_ranked(self) -> None:
        prefs = canonical_path(self.vault, "prefs")
        prefs.write_text(
            prefs.read_text(encoding="utf-8")
            + "\n## 已取代\n\n- 记忆索引保存在本地 SQLite\n",
            encoding="utf-8",
        )
        index.update_index(self.vault)
        self.assertEqual(index.lexical_search(self.vault, "记忆索引", limit=5), [])

    def test_mirror_count_matches_memories(self) -> None:
        self._append("- 记忆规则甲\n- prefers indigo prompts\n")
        conn = index.get_conn(self.vault)
        try:
            total = conn.execute("SELECT COUNT(*) AS c FROM memories").fetchone()["c"]
            mirrored = conn.execute("SELECT COUNT(*) AS c FROM fts_lex").fetchone()["c"]
        finally:
            conn.close()
        self.assertEqual(total, mirrored)

    def test_degrades_to_substring_scan_without_the_table(self) -> None:
        self._append("- 记忆索引保存在本地 SQLite\n")
        conn = index.get_conn(self.vault)
        try:
            conn.execute("DROP TABLE fts_lex")
            conn.commit()
        finally:
            conn.close()
        rows = index.lexical_search(self.vault, "记忆索引", limit=5)
        self.assertTrue(any("记忆索引" in r["line"] for r in rows))

    def test_hybrid_reports_three_streams(self) -> None:
        self._append("- 记忆索引保存在本地 SQLite\n")
        result = search.hybrid_search(self.vault, "记忆索引", limit=5)
        self.assertEqual(set(result["streams"].keys()), {"lexical", "vector", "graph"})
        self.assertGreater(result["streams"]["lexical"], 0)

    def test_old_lexical_tables_are_gone(self) -> None:
        conn = index.get_conn(self.vault)
        try:
            names = {
                r["name"]
                for r in conn.execute(
                    "SELECT name AS name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
        finally:
            conn.close()
        self.assertNotIn("fts_mem", names)
        self.assertNotIn("fts_mem_tri", names)
        self.assertNotIn("fts_mem_bigram", names)
        self.assertIn("fts_lex", names)


if __name__ == "__main__":
    unittest.main()
