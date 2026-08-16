# -*- coding: utf-8 -*-
"""Tests for hybrid retrieval (unified_memory.search)."""
import os
import unittest
from pathlib import Path

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import search, common


class RrfFuseTest(unittest.TestCase):
    def test_multi_stream_agreement_ranks_higher(self):
        a = [{"id": "x1"}, {"id": "x2"}, {"id": "x3"}]
        b = [{"id": "x3"}, {"id": "x1"}]
        c = []
        fused = search.rrf_fuse([a, b, c])
        self.assertEqual(fused[0][0], "x1")  # appears in both streams at top ranks
        self.assertEqual(fused[1][0], "x3")

    def test_missing_stream_is_ignored(self):
        fused = search.rrf_fuse([[], [], []])
        self.assertEqual(fused, [])

    def test_weights_affect_ranking(self):
        a = [{"id": "only-in-a"}]
        b = [{"id": "in-b"}]
        fused = search.rrf_fuse([a, b], weights=(2.0, 1.0, 1.0))
        self.assertEqual(fused[0][0], "only-in-a")


class HybridSearchTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        # Isolate from any real SiliconFlow key so tests never hit the network.
        import unified_memory.embed as emb

        self._old_secrets = emb.SECRETS_PATH
        self._old_key = os.environ.pop("SILICONFLOW_API_KEY", None)
        emb.SECRETS_PATH = Path(__file__).parent / "no-such-secrets.yaml"

    def tearDown(self):
        import unified_memory.embed as emb

        emb.SECRETS_PATH = self._old_secrets
        if self._old_key is not None:
            os.environ["SILICONFLOW_API_KEY"] = self._old_key
        destroy_scratch(self.vault)

    def test_hybrid_without_vectors_returns_bm25(self):
        prefs = common.canonical_path(self.vault, "prefs")
        prefs.write_text(prefs.read_text(encoding="utf-8") + "\n- prefers indigo terminal prompts\n", encoding="utf-8")
        result = search.hybrid_search(self.vault, "indigo", limit=5)
        self.assertEqual(result["ok"], True)
        self.assertEqual(result["streams"]["vector"], 0)
        self.assertTrue(any("indigo" in r["line"] for r in result["results"]))

    def test_hybrid_diversifies_per_doc(self):
        # Many facts in one note; hybrid must not flood a single doc.
        prefs = common.canonical_path(self.vault, "prefs")
        lines = "".join(f"\n- fact number {i} about quantum toggles\n" for i in range(10))
        prefs.write_text(prefs.read_text(encoding="utf-8") + lines, encoding="utf-8")
        result = search.hybrid_search(self.vault, "quantum", limit=20)
        docs = {r["doc"] for r in result["results"]}
        self.assertLessEqual(len(docs), len(result["results"]))
        # With a single note, at most MAX_PER_DOC results survive.
        self.assertLessEqual(len(result["results"]), search.MAX_PER_DOC)

    def test_render_hybrid_redacts(self):
        out = search.render_hybrid(
            [{"doc": "n.md", "line": "api_key: secret-here", "type": "fact", "importance": 0.5}],
            "q",
        )
        self.assertIn("<memory-data>", out)
        self.assertIn("<REDACTED>", out)
        self.assertNotIn("secret-here", out)

    def test_format_budget_caps_results(self):
        prefs = common.canonical_path(self.vault, "prefs")
        prefs.write_text(
            prefs.read_text(encoding="utf-8")
            + "\n- prefers indigo terminal prompts\n- prefers amber terminal prompts\n",
            encoding="utf-8",
        )
        result = search.hybrid_search(self.vault, "terminal", limit=5, budget=30)
        self.assertLessEqual(len(result["results"]), 5)
        # Budget is applied; at least one result fits in 30 "tokens" (~120 chars).
        self.assertGreater(len(result["results"]), 0)


if __name__ == "__main__":
    unittest.main()
