# -*- coding: utf-8 -*-
import os
import unittest
from pathlib import Path

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import memory as mem_mod
from unified_memory.common import canonical_dir, canonical_path, resolve_vault


class MemoryCoreTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_init_creates_structure(self):
        ctx = canonical_dir(self.vault)
        for name in mem_mod.CANONICAL_DOCS.values():
            self.assertTrue((ctx / name).is_file(), name)
        self.assertTrue((ctx / "Agent提交区").is_dir())
        self.assertTrue((ctx / "情境信息").is_dir())
        self.assertTrue((ctx / "记忆遗忘区").is_dir())

    def test_resolve_vault_from_env(self):
        self.assertEqual(resolve_vault(), self.vault)

    def test_submit_writes_inbox_file(self):
        result = mem_mod.cmd_submit(type("A", (), {"agent": "dsh", "fact": "- the test server runs on 127.0.0.1:9999"})())
        # cmd_submit prints; verify the file exists
        inbox = canonical_dir(self.vault) / "Agent提交区"
        files = list(inbox.glob("dsh-*.md"))
        self.assertEqual(len(files), 1)
        text = files[0].read_text(encoding="utf-8")
        self.assertIn("test server runs on 127.0.0.1:9999", text)

    def test_submit_rejects_credentials(self):
        with self.assertRaises(SystemExit):
            mem_mod.cmd_submit(type("A", (), {"agent": "dsh", "fact": "- api_key: replace-with-your-real-key"})())

    def test_show_prints_document(self):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            mem_mod.cmd_show(type("A", (), {"doc": "index"}))
        self.assertIn("上下文索引", buf.getvalue())

    def test_search_wraps_in_memory_data(self):
        import io
        from contextlib import redirect_stdout
        # seed a fact
        prefs = canonical_path(self.vault, "prefs")
        prefs.write_text(prefs.read_text(encoding="utf-8") + "\n- prefers indigo-colored terminal prompts\n", encoding="utf-8")
        buf = io.StringIO()
        with redirect_stdout(buf):
            mem_mod.cmd_search(type("A", (), {"query": "indigo", "limit": 8, "remote": False})())
        out = buf.getvalue()
        self.assertTrue(out.startswith("<memory-data>"))
        self.assertIn("indigo", out)
        self.assertTrue(out.rstrip().endswith("</memory-data>"))

    def test_remote_reports_not_configured(self):
        with self.assertRaises(SystemExit) as cm:
            mem_mod.cmd_search(type("A", (), {"query": "x", "limit": 8, "remote": True})())
        self.assertIn("remote index is not configured", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
