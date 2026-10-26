# -*- coding: utf-8 -*-
"""Hot-path budget + concept-level query cache (batch A).

A cold query embed used to cost 477 ms — 85% of a 560 ms median recall — on
the synchronous retrieval path, and the 7-day exact-string cache almost never
hit (23 entries after weeks of use). The wait is now capped at 0.12 s and the
cache keys on the query's concept set, so paraphrases share one vector.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import embed, index


class HotPathBudgetTests(unittest.TestCase):
    def test_query_timeout_is_capped_for_the_hot_path(self) -> None:
        # Worst case = timeout + local streaming must stay near 150 ms.
        self.assertLessEqual(embed.QUERY_TIMEOUT_S, 0.15)
        self.assertLess(embed.QUERY_TIMEOUT_S, embed.TIMEOUT_S)


class ConceptCacheKeyTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = Path(self._tmp.name) / "vault"
        self.vault.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_same_concept_set_shares_one_key(self) -> None:
        self.assertEqual(
            embed._cache_key("备份目录"),
            embed._cache_key("目录 备份"),
        )

    def test_different_concepts_get_different_keys(self) -> None:
        self.assertNotEqual(
            embed._cache_key("备份目录"),
            embed._cache_key("校园网代理"),
        )

    def test_model_id_is_part_of_the_key(self) -> None:
        before = embed._cache_key("备份目录")
        original = embed.EMBED_MODEL
        try:
            embed.EMBED_MODEL = "other/model"
            self.assertNotEqual(before, embed._cache_key("备份目录"))
        finally:
            embed.EMBED_MODEL = original

    def test_paraphrases_reuse_one_provider_call(self) -> None:
        vault = make_scratch_vault()
        try:
            calls = []

            def fake_embed_texts(texts, timeout_s=embed.TIMEOUT_S):
                calls.append(list(texts))
                return [[0.1] * embed.EMBED_DIMS for _ in texts]

            with patch.object(embed, "embed_texts", fake_embed_texts), patch.object(
                embed, "get_api_key", lambda: "stub-key"
            ):
                first = embed.embed_query_cached(vault, "备份目录")
                second = embed.embed_query_cached(vault, "目录 备份")
                third = embed.embed_query_cached(vault, "校园网代理")
            self.assertEqual(len(calls), 2)  # one per distinct concept set
            # The second call read the CACHE: same vector up to the Float32
            # roundtrip the BLOB storage performs.
            self.assertEqual(len(first), len(second))
            self.assertTrue(
                all(abs(a - b) < 1e-5 for a, b in zip(first, second)),
                "paraphrase must reuse the cached vector",
            )
            conn = index.get_conn(vault)
            try:
                rows = conn.execute(
                    "SELECT model_id FROM query_cache"
                ).fetchall()
            finally:
                conn.close()
            self.assertEqual({r["model_id"] for r in rows}, {embed.EMBED_MODEL})
        finally:
            destroy_scratch(vault)


if __name__ == "__main__":
    unittest.main()
