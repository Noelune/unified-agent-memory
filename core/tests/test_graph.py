# -*- coding: utf-8 -*-
"""Tests for the optional concept graph (unified_memory.graph)."""
import unittest

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import graph, index, common


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

    def test_build_graph_and_expand(self):
        env = common.canonical_path(self.vault, "env")
        env.write_text(
            env.read_text(encoding="utf-8")
            + "\n- HK 服务器用于编译调试\n- HK 服务器 SSH 端口为 22\n- 显示器黑屏排查步骤\n",
            encoding="utf-8",
        )
        index.update_index(self.vault)
        nodes = graph.build_graph(self.vault)
        self.assertGreaterEqual(nodes, 3)
        results = graph.expand_search(self.vault, "编译", limit=5)
        self.assertTrue(any("编译调试" in r["line"] for r in results))

    def test_graph_is_bounded(self):
        env = common.canonical_path(self.vault, "env")
        lines = "".join(
            f"- 记忆 索引 路径 环境 服务 工具 配置 备份 规则 项目 模块 {i}\n"
            for i in range(80)
        )
        env.write_text(env.read_text(encoding="utf-8") + lines, encoding="utf-8")
        index.update_index(self.vault)
        graph.build_graph(self.vault)
        stats = graph.graph_stats(self.vault)
        self.assertGreater(stats["nodes"], 0)
        self.assertLessEqual(stats["edges"], graph.MAX_GRAPH_EDGES)

    def test_expand_one_hop_finds_related(self):
        env = common.canonical_path(self.vault, "env")
        env.write_text(
            env.read_text(encoding="utf-8")
            + "\n- HK 服务器用于编译调试\n- HK 服务器 SSH 端口为 22\n",
            encoding="utf-8",
        )
        index.update_index(self.vault)
        # "编译" directly hits the first fact; the second shares the HK/服务器
        # concept and should appear via one-hop expansion.
        results = graph.expand_search(self.vault, "编译", limit=5)
        lines = [r["line"] for r in results]
        self.assertTrue(any("SSH 端口" in line for line in lines))


if __name__ == "__main__":
    unittest.main()
