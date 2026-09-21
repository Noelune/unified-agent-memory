# -*- coding: utf-8 -*-
"""trigram stream fuses into hybrid search."""
from __future__ import annotations

import os
import unittest
from pathlib import Path

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import index, search, common
from unified_memory import graph as graph_mod


class TrigramFusionTest(unittest.TestCase):
    def test_default_weights_cover_four_streams(self):
        self.assertEqual(len(search.DEFAULT_WEIGHTS), 4)

    def test_rrf_fuse_accepts_four_streams(self):
        streams = [
            [{"id": "a"}], [{"id": "b"}], [{"id": "c"}], [{"id": "a"}],
        ]
        fused = dict(search.rrf_fuse(streams))
        # 'a' appears in streams 0 and 3, so it must outrank single-stream ids.
        self.assertGreater(fused["a"], fused["b"])
        self.assertGreater(fused["a"], fused["c"])


class HybridTrigramStreamTest(unittest.TestCase):
    """The trigram stream is additive: present when available, harmless when not."""

    def setUp(self):
        self.vault = make_scratch_vault()
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

    def test_streams_dict_reports_trigram(self):
        result = search.hybrid_search(self.vault, "anything", limit=5)
        self.assertIn("trigram", result["streams"])

    def test_hybrid_still_works_when_trigram_is_empty(self):
        # Additive: with an empty trigram stream the fusion must reproduce the
        # three-stream result byte for byte. A dropped/absent fts_mem_tri table
        # (older SQLite, un-backfilled vault) is exactly this case.
        prefs = common.canonical_path(self.vault, "prefs")
        prefs.write_text(
            prefs.read_text(encoding="utf-8") + "\n- prefers indigo terminal prompts\n",
            encoding="utf-8",
        )
        index.update_index(self.vault)
        bm25 = index.bm25_memory_search(self.vault, "indigo", limit=20)
        graph = graph_mod.expand_search(self.vault, "indigo", limit=20)
        three = search.rrf_fuse([bm25, [], graph], weights=(1.0, 1.0, 0.8))
        four = search.rrf_fuse([bm25, [], graph, []])
        self.assertEqual(three, four)

        result = search.hybrid_search(self.vault, "indigo", limit=5)
        self.assertEqual(result["ok"], True)
        self.assertTrue(any("indigo" in r["line"] for r in result["results"]))

    def test_trigram_stream_contributes_cjk_hits(self):
        # bm25's tokenizer cannot split CJK, so trigram is the only local
        # stream that can recall a bare CJK substring.
        prefs = common.canonical_path(self.vault, "prefs")
        prefs.write_text(
            prefs.read_text(encoding="utf-8") + "\n- 记忆系统的召回主管道已上线\n",
            encoding="utf-8",
        )
        result = search.hybrid_search(self.vault, "忆系统", limit=5)
        self.assertGreater(result["streams"]["trigram"], 0)
        self.assertTrue(any("忆系统" in r["line"] for r in result["results"]))


if __name__ == "__main__":
    unittest.main()
