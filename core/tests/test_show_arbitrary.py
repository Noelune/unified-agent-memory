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

    def test_show_accepts_the_suffixless_wikilink_spelling(self):
        # `上下文索引.md` links notes the way Obsidian does — `[[实体]]`, no
        # suffix. Refusing that spelling rejected the one form the vault itself
        # writes, so a name copied straight out of the index did not resolve.
        custom = canonical_dir(self.vault) / "我的偏好摘要.md"
        custom.write_text("- prefers terse answers\n", encoding="utf-8")
        buf = io.StringIO()
        with redirect_stdout(buf):
            mem_mod.cmd_show(Namespace(doc="我的偏好摘要"))
        out = buf.getvalue()
        self.assertIn("我的偏好摘要.md", out)
        self.assertIn("terse answers", out)

    def test_show_names_an_unsuffixed_miss_not_found(self):
        # The refusal has to describe the name the caller typed. Before
        # `note_named` was normalized first, a bare name failed the `*.md`
        # shape check and was reported as an invalid name — the wrong reason,
        # and an unactionable one: the caller's spelling was never the problem.
        with self.assertRaises(SystemExit) as raised:
            mem_mod.cmd_show(Namespace(doc="不存在的笔记"))
        message = str(raised.exception)
        self.assertIn("no such canonical note", message)
        self.assertNotIn("invalid document name", message)

    def test_show_rejects_traversal(self):
        with self.assertRaises(SystemExit):
            mem_mod.cmd_show(Namespace(doc="../secret.md"))

    def test_show_rejects_unknown_note(self):
        with self.assertRaises(SystemExit):
            mem_mod.cmd_show(Namespace(doc="nope.md"))


if __name__ == "__main__":
    unittest.main()
