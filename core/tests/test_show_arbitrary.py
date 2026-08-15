# -*- coding: utf-8 -*-
import io
import unittest
from argparse import Namespace
from contextlib import redirect_stdout

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import memory as mem_mod
from unified_memory.common import canonical_dir


class ShowArbitraryTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_show_custom_note(self):
        custom = canonical_dir(self.vault) / "实体.md"
        custom.write_text("- the staging server runs on 127.0.0.1:8080\n", encoding="utf-8")
        buf = io.StringIO()
        with redirect_stdout(buf):
            mem_mod.cmd_show(Namespace(doc="实体.md"))
        out = buf.getvalue()
        self.assertIn("实体.md", out)
        self.assertIn("staging server", out)

    def test_show_rejects_traversal(self):
        with self.assertRaises(SystemExit):
            mem_mod.cmd_show(Namespace(doc="../secret.md"))

    def test_show_rejects_unknown_note(self):
        with self.assertRaises(SystemExit):
            mem_mod.cmd_show(Namespace(doc="nope.md"))


if __name__ == "__main__":
    unittest.main()
