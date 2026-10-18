# -*- coding: utf-8 -*-
"""`init --vault` persists the vault and says so when it repoints the machine.

Context: `memory_setup` (the plugin's first-run tool) calls
`unified_memory.memory init --vault <new>` and then relies on every later
call — including its own `status` selfcheck — resolving that same vault. That
works because init writes the `vault:` key. Two behaviours are pinned here:

  1. the key is written line-preservingly (other keys and comments survive,
     re-running does not grow the file);
  2. when a *different* vault was configured before, init prints what it
     replaced. Silently repointing a working machine at another vault is how a
     probe of mine moved this laptop's own vault to a temp directory that was
     then deleted. The overwrite is still the requested action; hiding it is
     the defect.
"""
import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import test_common  # noqa: F401  (importing arms the temp-home guard)
from unified_memory import memory as mem_mod


class InitRemembersVaultTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.vault = self.root / "vault"
        self.config = self.root / "config.yaml"
        self._saved_config = mem_mod.CONFIG_PATH
        mem_mod.CONFIG_PATH = self.config
        self.addCleanup(self._restore)

    def _restore(self):
        mem_mod.CONFIG_PATH = self._saved_config

    def _run_init(self, force=False):
        out = io.StringIO()
        with redirect_stdout(out):
            mem_mod.init_vault(self.vault, force=force)
        return out.getvalue()

    def test_init_writes_the_vault_key(self):
        self._run_init()
        self.assertIn(f"vault: {self.vault}", self.config.read_text(encoding="utf-8"))

    def test_other_keys_and_comments_survive(self):
        self.config.write_text("# my notes\ndigest: enabled\n\nvault: C:\\old\n", encoding="utf-8")
        out = self._run_init()
        text = self.config.read_text(encoding="utf-8")
        self.assertIn("digest: enabled", text)
        self.assertIn("# my notes", text)
        self.assertNotIn("C:\\old", text, "the old vault line is replaced, not kept")
        self.assertEqual(text.count("vault:"), 1, "exactly one vault line after init")
        self.assertIn("C:\\old", out, "the replaced vault is reported, not silently dropped")

    def test_first_init_reports_no_replacement(self):
        out = self._run_init()
        self.assertNotIn("replaced", out)

    def test_same_vault_twice_reports_no_replacement(self):
        self._run_init(force=True)
        out = self._run_init(force=True)
        self.assertNotIn("replaced", out)

    def test_reinit_does_not_grow_the_config(self):
        self._run_init(force=True)
        first = self.config.read_text(encoding="utf-8")
        self._run_init(force=True)
        self.assertEqual(first, self.config.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
