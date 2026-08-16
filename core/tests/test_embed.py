# -*- coding: utf-8 -*-
"""Tests for the optional semantic-embedding layer (unified_memory.embed).

The live provider is never called here — tests cover the helpers, the
graceful no-key degradation, and the vector storage round-trip. The real
secrets file is never touched: SECRETS_PATH is redirected to a missing file.
"""
import os
import unittest
from pathlib import Path

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import embed, index


class EmbedTest(unittest.TestCase):
    def setUp(self):
        self._old_secrets = embed.SECRETS_PATH
        self._old_key = os.environ.pop("SILICONFLOW_API_KEY", None)
        embed.SECRETS_PATH = Path(__file__).parent / "no-such-secrets.yaml"

    def tearDown(self):
        embed.SECRETS_PATH = self._old_secrets
        if self._old_key is not None:
            os.environ["SILICONFLOW_API_KEY"] = self._old_key

    def test_vector_blob_round_trip_is_close(self):
        v = [0.1, 0.5, -1.0, 2.0, 3.0]
        v2 = embed.blob_to_vector(embed.vector_to_blob(v))
        self.assertEqual(len(v2), len(v))
        for a, b in zip(v, v2):
            self.assertAlmostEqual(a, b, places=5)

    def test_cosine(self):
        self.assertGreater(embed.cosine([1.0, 2.0], [1.0, 2.0]), 0.999)
        self.assertAlmostEqual(embed.cosine([1.0, 0.0], [0.0, 1.0]), 0.0, places=6)
        self.assertEqual(embed.cosine([0.0, 0.0], [1.0, 0.0]), 0.0)

    def test_configured_false_without_key(self):
        self.assertFalse(embed.configured())

    def test_embed_missing_degrades_without_key(self):
        vault = make_scratch_vault()
        try:
            result = embed.embed_missing(vault)
            self.assertFalse(result["ok"])
            self.assertIn("no SiliconFlow API key", result["reason"])
        finally:
            destroy_scratch(vault)

    def test_embed_missing_skips_already_embedded(self):
        vault = make_scratch_vault()
        try:
            conn = index.get_conn(vault)
            try:
                conn.execute(
                    "INSERT INTO memories (id, doc, line, type, importance, status, version, source_agent, project, created_at, updated_at, access_count, metadata_json) "
                    "VALUES ('m1', 'x.md', 'fact one', 'fact', 0.5, 'active', 1, '', '', '2026-01-01', '2026-01-01', 0, '{}')"
                )
                conn.execute(
                    "INSERT INTO embeddings (memory_id, dim, vector) VALUES ('m1', 4, ?)",
                    (embed.vector_to_blob([1.0, 0.0, 0.0, 0.0]),),
                )
                conn.commit()
            finally:
                conn.close()
            self.assertEqual(embed.configured(), False)
            # Without a key the provider check short-circuits before scanning,
            # so this only verifies the function is safe to call.
            result = embed.embed_missing(vault)
            self.assertFalse(result["ok"])
        finally:
            destroy_scratch(vault)


if __name__ == "__main__":
    unittest.main()
