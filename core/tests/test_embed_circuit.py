# -*- coding: utf-8 -*-
"""Embedding provider: short query timeout + circuit breaker.

The recall hot path used to inherit the 15 s batch timeout and retry a dead
provider on every single query. These tests pin the two guards that keep a
network problem from becoming a per-turn stall:

  * a query vector gets ``QUERY_TIMEOUT_S`` (sub-second), not the batch budget;
  * two consecutive failures open a circuit for ``CIRCUIT_COOLDOWN_S``, so the
    next queries return "no vector stream" immediately instead of timing out.
"""
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import embed as emb


class EmbedCircuitTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()
        emb.reset_circuit()

    def tearDown(self):
        emb.reset_circuit()
        destroy_scratch(self.vault)

    def _fail_urlopen(self, req, timeout=None):
        raise urllib.error.URLError("provider down")

    def test_query_path_uses_the_short_timeout(self):
        seen = {}

        def fake_urlopen(req, timeout=None):
            seen["timeout"] = timeout
            raise urllib.error.URLError("provider down")

        with patch.object(emb.urllib.request, "urlopen", side_effect=fake_urlopen), patch.object(
            emb, "get_api_key", return_value="test-key"
        ):
            emb.embed_query_cached(self.vault, "a topic nobody cached")
        self.assertEqual(seen["timeout"], emb.QUERY_TIMEOUT_S)
        self.assertLess(emb.QUERY_TIMEOUT_S, emb.TIMEOUT_S, "query budget must be shorter than the batch budget")

    def test_batch_path_keeps_the_long_timeout(self):
        seen = {}

        def fake_urlopen(req, timeout=None):
            seen["timeout"] = timeout
            raise urllib.error.URLError("provider down")

        with patch.object(emb.urllib.request, "urlopen", side_effect=fake_urlopen), patch.object(
            emb, "get_api_key", return_value="test-key"
        ):
            emb.embed_texts(["a fact worth embedding"])
        self.assertEqual(seen["timeout"], emb.TIMEOUT_S)

    def test_circuit_opens_after_the_configured_failures(self):
        self.assertFalse(emb.circuit_open())
        with patch.object(emb.urllib.request, "urlopen", side_effect=self._fail_urlopen), patch.object(
            emb, "get_api_key", return_value="test-key"
        ):
            for _ in range(emb.CIRCUIT_FAILURES - 1):
                self.assertIsNone(emb.embed_texts(["x fact"]))
                self.assertFalse(emb.circuit_open(), "still under the threshold")
            self.assertIsNone(emb.embed_texts(["x fact"]))
        self.assertTrue(emb.circuit_open())

    def test_open_circuit_skips_the_network_entirely(self):
        with patch.object(emb.urllib.request, "urlopen", side_effect=self._fail_urlopen), patch.object(
            emb, "get_api_key", return_value="test-key"
        ):
            for _ in range(emb.CIRCUIT_FAILURES):
                emb.embed_texts(["x fact"])
        self.assertTrue(emb.circuit_open())
        with patch.object(emb.urllib.request, "urlopen") as urlopen:
            self.assertIsNone(emb.embed_texts(["another fact"]))
            self.assertIsNone(emb.embed_query_cached(self.vault, "another topic"))
        self.assertEqual(urlopen.call_count, 0, "an open circuit must not touch the network")

    def test_success_resets_the_failure_streak(self):
        with patch.object(emb.urllib.request, "urlopen", side_effect=self._fail_urlopen), patch.object(
            emb, "get_api_key", return_value="test-key"
        ):
            emb.embed_texts(["x fact"])
        self.assertFalse(emb.circuit_open())

        vector = [0.1] * emb.EMBED_DIMS
        payload = {'data': [{'index': 0, 'embedding': vector}]}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                import json

                return json.dumps(payload).encode("utf-8")

        with patch.object(emb.urllib.request, "urlopen", return_value=FakeResponse()), patch.object(
            emb, "get_api_key", return_value="test-key"
        ):
            self.assertIsNotNone(emb.embed_texts(["x fact"]))
        # One failure + one success must not trip the breaker.
        self.assertFalse(emb.circuit_open())

    def test_reset_circuit_closes_it(self):
        with patch.object(emb.urllib.request, "urlopen", side_effect=self._fail_urlopen), patch.object(
            emb, "get_api_key", return_value="test-key"
        ):
            for _ in range(emb.CIRCUIT_FAILURES):
                emb.embed_texts(["x fact"])
        self.assertTrue(emb.circuit_open())
        emb.reset_circuit()
        self.assertFalse(emb.circuit_open())

    def test_no_api_key_never_trips_the_breaker(self):
        with patch.object(emb, "get_api_key", return_value=""):
            for _ in range(emb.CIRCUIT_FAILURES + 3):
                self.assertIsNone(emb.embed_texts(["x fact"]))
        self.assertFalse(emb.circuit_open(), "a missing key is a configuration state, not an outage")


if __name__ == "__main__":
    unittest.main()
