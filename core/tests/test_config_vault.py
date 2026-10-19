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
import argparse
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


class UseExistingVaultTest(unittest.TestCase):
    """`memory use --vault` points a machine at a vault it already has.

    The plugin's reuse path skips `init` on purpose (it either refuses or copies
    the template over the user's notes), so on that path nothing else would
    persist `vault:`. Without it every reader still resolves the old path, and
    the PATH shim — which runs without UNIFIED_MEMORY_VAULT — resolves the
    default vault instead of the one the user just adopted.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.vault = self.root / "vault"
        (self.vault / "50-Agent-Context").mkdir(parents=True)
        # A vault the readers can actually resolve: the index is what `use`
        # checks before it repoints `vault:`.
        (self.vault / "50-Agent-Context" / "上下文索引.md").write_text(
            "# 上下文索引\n", encoding="utf-8"
        )
        self.config = self.root / "config.yaml"
        self._saved_config = mem_mod.CONFIG_PATH
        mem_mod.CONFIG_PATH = self.config
        self.addCleanup(self._restore)

    def _restore(self):
        mem_mod.CONFIG_PATH = self._saved_config

    def _run_use(self, vault=None):
        out = io.StringIO()
        with redirect_stdout(out):
            mem_mod.cmd_use(argparse.Namespace(vault=str(vault or self.vault)))
        return out.getvalue()

    def _written_vault(self) -> Path:
        """The `vault:` value as written, resolved for comparison.

        `cmd_use` stores and prints `Path(args.vault).expanduser().resolve()`,
        so an assertion must resolve too: on macOS `/var` is a symlink to
        `/private/var`, and a Windows CI runner's temp dir is an 8.3 short name.
        Both differ from the unresolved temp path the test holds, which is why
        the raw `assertIn(str(self.vault), ...)` passed locally and failed on
        every other machine.
        """
        text = self.config.read_text(encoding="utf-8")
        for line in text.splitlines():
            if line.startswith("vault:"):
                return Path(line.split("vault:", 1)[1].strip())
        raise AssertionError(f"no vault: key written — config is {text!r}")

    def test_use_writes_the_vault_key(self):
        self._run_use()
        self.assertEqual(self._written_vault().resolve(), self.vault.resolve())

    def test_use_keeps_other_keys_and_does_not_touch_the_vault(self):
        self.config.write_text("# my notes\ndigest: enabled\n\nvault: C:\\old\n", encoding="utf-8")
        before = sorted(p.name for p in (self.vault / "50-Agent-Context").iterdir())
        out = self._run_use()
        text = self.config.read_text(encoding="utf-8")
        self.assertIn("digest: enabled", text)
        self.assertIn("# my notes", text)
        self.assertEqual(text.count("vault:"), 1)
        self.assertIn("C:\\old", out, "the replaced vault is reported")
        after = sorted(p.name for p in (self.vault / "50-Agent-Context").iterdir())
        self.assertEqual(before, after, "use must not write into the vault")

    def test_use_refuses_a_path_without_the_memory_structure(self):
        empty = self.root / "empty"
        empty.mkdir()
        self.config.write_text("vault: C:\\keep\n", encoding="utf-8")
        with self.assertRaises(SystemExit) as raised:
            self._run_use(empty)
        self.assertIn("memory init", str(raised.exception))
        self.assertEqual(self.config.read_text(encoding="utf-8"), "vault: C:\\keep\n")

    def test_use_refuses_a_path_containing_a_hash(self):
        # Every reader splits the config line on "#" before stripping quotes, so
        # a vault under "C:\notes #2" would be silently truncated to "C:\notes".
        # Refusing at the write is the only place that can be seen.
        hashed = self.root / "notes #2"
        (hashed / "50-Agent-Context").mkdir(parents=True)
        self.config.write_text("vault: C:\\keep\n", encoding="utf-8")
        with self.assertRaises(SystemExit) as raised:
            self._run_use(hashed)
        self.assertIn("#", str(raised.exception))
        self.assertEqual(self.config.read_text(encoding="utf-8"), "vault: C:\\keep\n")

    def test_use_refuses_a_path_the_readers_would_rewrite(self):
        # "#" is not the only character the readers touch: common.parse_config
        # strips a quote from either end of the value, so a folder named
        # `notes'` is stored and then resolved as `notes`. Checking the value
        # the reader would see covers today's rules and any later ones.
        quoted = self.root / "notes'"
        (quoted / "50-Agent-Context").mkdir(parents=True)
        (quoted / "50-Agent-Context" / "上下文索引.md").write_text("# 索引\n", encoding="utf-8")
        self.config.write_text("vault: C:\\keep\n", encoding="utf-8")
        with self.assertRaises(SystemExit) as raised:
            self._run_use(quoted)
        self.assertIn("read back as", str(raised.exception))
        self.assertEqual(self.config.read_text(encoding="utf-8"), "vault: C:\\keep\n")

    def test_use_refuses_a_path_with_a_line_separator(self):
        # The readers split the file with str.splitlines(), which also breaks on
        # U+2028 and friends. A value carrying one of those is written as two
        # lines and read back as the first half only — the same failure as "#",
        # through a different door, so the check has to reuse their splitting.
        split = self.root / "vault\u2028x"
        (split / "50-Agent-Context").mkdir(parents=True)
        (split / "50-Agent-Context" / "上下文索引.md").write_text("# 索引\n", encoding="utf-8")
        self.config.write_text("vault: C:\\keep\n", encoding="utf-8")
        with self.assertRaises(SystemExit) as raised:
            self._run_use(split)
        self.assertIn("read back as", str(raised.exception))
        self.assertEqual(self.config.read_text(encoding="utf-8"), "vault: C:\\keep\n")

    def test_use_quotes_the_path_in_its_advice(self):
        # The message is copy-pasteable, and vaults with spaces are the norm.
        spaced = self.root / "empty vault"
        spaced.mkdir()
        with self.assertRaises(SystemExit) as raised:
            self._run_use(spaced)
        # The advice quotes the resolved path — see `_written_vault`.
        self.assertIn(f'memory init --vault "{spaced.resolve()}"', str(raised.exception))

    def test_use_refuses_a_vault_without_the_context_index(self):
        # A folder that merely has 50-Agent-Context is not a memory vault: the
        # readers resolve 50-Agent-Context/上下文索引.md, so pointing `vault:`
        # there would make every later call read an empty memory while reporting
        # success. The plugin refuses this state; the CLI has to agree.
        half = self.root / "half-built"
        (half / "50-Agent-Context").mkdir(parents=True)
        self.config.write_text("vault: C:\\keep\n", encoding="utf-8")
        with self.assertRaises(SystemExit) as raised:
            self._run_use(half)
        self.assertIn("上下文索引.md", str(raised.exception))
        self.assertIn("memory init", str(raised.exception))
        self.assertEqual(self.config.read_text(encoding="utf-8"), "vault: C:\\keep\n")

    def test_use_twice_does_not_grow_the_config(self):
        self._run_use()
        first = self.config.read_text(encoding="utf-8")
        self._run_use()
        self.assertEqual(first, self.config.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
