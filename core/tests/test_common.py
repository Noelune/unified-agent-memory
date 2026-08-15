# -*- coding: utf-8 -*-
"""Shared helpers for core tests: scratch vaults under a temp dir.

The real ~/.unified-memory.yaml and index.db are NEVER touched: both the
config path and the index path are redirected into the scratch dir.
"""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unified_memory import memory as mem_mod
from unified_memory import common


def make_scratch_vault() -> Path:
    root = Path(tempfile.mkdtemp(prefix="um-test-"))
    vault = root / "vault"
    # Redirect config + index away from the real home directory.
    common.CONFIG_PATH = root / "config.yaml"
    mem_mod.CONFIG_PATH = common.CONFIG_PATH
    mem_mod.INDEX_DB = root / "index.db"
    os.environ["UNIFIED_MEMORY_VAULT"] = str(vault)
    mem_mod.init_vault(vault)
    return vault


def destroy_scratch(vault: Path) -> None:
    shutil.rmtree(vault.parent, ignore_errors=True)
    os.environ.pop("UNIFIED_MEMORY_VAULT", None)


class RedactTest(unittest.TestCase):
    def test_redacts_short_credential_values(self):
        # Short values (>= 4 chars) after a key must still be redacted so a
        # session archive can't leak even a short test key.
        self.assertIn("<REDACTED>", common.redact("api_key: abc123"))
        self.assertIn("<REDACTED>", common.redact("auth_token: abcd"))
        self.assertIn("<REDACTED>", common.redact("password: pass"))

    def test_redact_does_not_erase_plain_text(self):
        self.assertEqual(common.redact("the server runs on 127.0.0.1:8080"), "the server runs on 127.0.0.1:8080")
        self.assertNotIn("<REDACTED>", common.redact("api is a common word"))


if __name__ == "__main__":
    unittest.main()
