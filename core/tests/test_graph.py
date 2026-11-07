# -*- coding: utf-8 -*-
"""Tests for the in-memory concept-expansion stream (unified_memory.graph).

The persisted graph tables are gone (batch A v8): they were write-only.
expand_search now GATES its output — the old version returned a full pool for
any query, including nonsense, which fed RRF a near-uniform vote spread.
"""
import unittest

from unified_memory import common
from unified_memory.infra.store import get_conn, update_index
from test_common import destroy_scratch, make_scratch_vault
from unified_memory.app.retrieve import graph


class GraphTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_tokens_split_ascii_and_cjk(self):
        toks = graph._tokens("HK 服务器用于编译调试 SSH port 22")
        self.assertIn("服务", toks)  # CJK bigram
        self.assertIn("编译", toks)
        self.assertIn("ssh", toks)   # ascii lowercased

    def test_expand_finds_direct_hits(self):
        env = common.canonical_path(self.vault, "env")
        env.write_text(
            env.read_text(encoding="utf-8")
            + "\n- HK 服务器用于编译调试\n- HK 服务器 SSH 端口为 22\n- 显示器黑屏排查步骤\n",
            encoding="utf-8",
        )
        update_index(self.vault)
        results = graph.expand_search(self.vault, "编译", limit=5)
        self.assertTrue(any("编译调试" in r["line"] for r in results))

    def test_expand_one_hop_finds_related(self):
        env = common.canonical_path(self.vault, "env")
        env.write_text(
            env.read_text(encoding="utf-8")
            + "\n- HK 服务器用于编译调试\n- HK 服务器 SSH 端口为 22\n",
            encoding="utf-8",
        )
        update_index(self.vault)
        # "编译" directly hits the first fact; the second shares the HK/服务器
        # concept and should appear via one-hop expansion.
        results = graph.expand_search(self.vault, "编译", limit=5)
        lines = [r["line"] for r in results]
        self.assertTrue(any("SSH 端口" in line for line in lines))

    def test_nonsense_query_returns_empty(self):
        # The batch-A regression guard: a query sharing NO concept with the
        # corpus must return nothing, not a full pool of weak candidates.
        env = common.canonical_path(self.vault, "env")
        env.write_text(
            env.read_text(encoding="utf-8")
            + "\n- HK 服务器用于编译调试\n- 显示器黑屏排查步骤\n",
            encoding="utf-8",
        )
        update_index(self.vault)
        self.assertEqual(graph.expand_search(self.vault, "量子色动力学", limit=10), [])

    def test_pool_is_capped_near_direct_hits(self) -> None:
        env = common.canonical_path(self.vault, "env")
        env.write_text(
            env.read_text(encoding="utf-8")
            + "\n- HK 服务器用于编译调试\n"
            + "".join(f"- 备忘条目编号 {i} 与主题无关\n" for i in range(30)),
            encoding="utf-8",
        )
        update_index(self.vault)
        results = graph.expand_search(self.vault, "编译调试", limit=20)
        # 1 direct hit -> ceil(2.5) candidates at most, not the whole pool.
        self.assertLessEqual(len(results), 3)

    def test_low_relevance_tail_is_cut(self) -> None:
        env = common.canonical_path(self.vault, "env")
        env.write_text(
            env.read_text(encoding="utf-8")
            + "\n- 编译调试专用服务器配置完毕\n"      # direct hit (3 query tokens)
            + "- 配置说明已整理成文档\n"              # one-hop via 配置 (degree 3)
            + "- 配置变更需要记录日志\n",             # one-hop via 配置 (degree 3)
            encoding="utf-8",
        )
        update_index(self.vault)
        results = graph.expand_search(self.vault, "编译调试", limit=10)
        # Direct hit ranks first; the one-hop neighbours share one concept
        # with document frequency 3, so their normalised bonus (6/3 = 2)
        # sits below the 0.5 x top floor (3) and is cut. (memories.line
        # stores the bare fact — no bullet.)
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0]["line"].startswith("编译调试"))

    def test_graph_stats_counts_in_memory(self) -> None:
        env = common.canonical_path(self.vault, "env")
        env.write_text(
            env.read_text(encoding="utf-8")
            + "\n- HK 服务器用于编译调试\n- HK 服务器 SSH 端口为 22\n",
            encoding="utf-8",
        )
        update_index(self.vault)
        stats = graph.graph_stats(self.vault)
        self.assertGreater(stats["nodes"], 0)
        self.assertGreater(stats["edges"], 0)

    def test_graph_tables_are_gone(self) -> None:
        conn = get_conn(self.vault)
        try:
            names = {
                r["name"]
                for r in conn.execute(
                    "SELECT name AS name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
        finally:
            conn.close()
        self.assertNotIn("graph_nodes", names)
        self.assertNotIn("graph_edges", names)


if __name__ == "__main__":
    unittest.main()
