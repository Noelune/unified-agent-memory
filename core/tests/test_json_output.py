# -*- coding: utf-8 -*-
"""--json output contract for the memory CLI."""
from __future__ import annotations

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import memory


class StatusJsonTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_status_json_emits_one_parseable_object(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            memory.main(["status", "--json"])
        payload = json.loads(buf.getvalue())  # raises if not valid JSON
        self.assertIs(payload["ok"], True)
        self.assertEqual(payload["command"], "status")
        self.assertIn("vault", payload["data"])
        self.assertIn("index", payload["data"])

    def test_status_without_json_is_unchanged_text(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            memory.main(["status"])
        out = buf.getvalue()
        self.assertFalse(out.lstrip().startswith("{"))
        self.assertIn("vault:", out)


class SearchJsonTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_search_json_envelope_and_untrusted_flag(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            memory.main(["search", "记忆", "--json"])
        payload = json.loads(buf.getvalue())
        self.assertIs(payload["ok"], True)
        self.assertEqual(payload["command"], "search")
        self.assertEqual(payload["data"]["query"], "记忆")
        self.assertIn("results", payload["data"])
        for r in payload["data"]["results"]:
            self.assertIs(r["untrusted"], True)
        self.assertNotIn("<memory-data>", buf.getvalue())

    def test_search_json_hybrid_also_works(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            memory.main(["search", "记忆", "--hybrid", "--json"])
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["command"], "search")
        self.assertIn("streams", payload["data"])

    def test_search_without_json_still_wraps_memory_data(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            memory.main(["search", "记忆"])
        self.assertIn("<memory-data>", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
