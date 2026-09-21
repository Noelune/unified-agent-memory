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


if __name__ == "__main__":
    unittest.main()
