# -*- coding: utf-8 -*-
"""Shared helpers for core tests: scratch vaults under a temp dir.

The real ~/.unified-memory.yaml and index.db are NEVER touched: both the
config path and the index path are redirected into the scratch dir.
"""
import hashlib
import io
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unified_memory import memory as mem_mod
from unified_memory import common


def index_db_name_for(vault: Path) -> str:
    """The per-vault DB filename schema.index_db_for() derives from ``vault``.

    Mirrored here instead of imported so the tests keep working even when the
    helper moves; ``vault`` must be resolved exactly as schema.py resolves it.
    """
    key = hashlib.sha256(str(Path(vault).resolve()).encode("utf-8")).hexdigest()[:16]
    return f"index-{key}.db"


def make_scratch_vault() -> Path:
    root = Path(tempfile.mkdtemp(prefix="um-test-"))
    vault = root / "vault"
    # Redirect config + index away from the real home directory.
    common.CONFIG_PATH = root / "config.yaml"
    mem_mod.CONFIG_PATH = common.CONFIG_PATH
    mem_mod.INDEX_DB = root / "index.db"
    os.environ["UNIFIED_MEMORY_VAULT"] = str(vault)
    # The parent-process rebind above cannot reach a child process: a spawned
    # script re-imports memory.py and would rebuild INDEX_DB under the real
    # ~/.unified-memory/. Exporting the env override here means EVERY test that
    # spawns a child inherits the scratch redirect for free.
    os.environ["UNIFIED_MEMORY_INDEX_DB"] = str(mem_mod.INDEX_DB)
    mem_mod.init_vault(vault)
    return vault


def destroy_scratch(vault: Path) -> None:
    shutil.rmtree(vault.parent, ignore_errors=True)
    os.environ.pop("UNIFIED_MEMORY_VAULT", None)
    os.environ.pop("UNIFIED_MEMORY_INDEX_DB", None)


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


class ConsoleEncodingTest(unittest.TestCase):
    """Non-UTF-8 consoles (Windows cp1252) must not crash the CLI on CJK output.

    GitHub's windows-latest runner gives Python a cp1252 stdout, and core
    prints CJK paths such as 记忆遗忘区. Without an explicit reconfigure the
    encode throws UnicodeEncodeError and the command dies.
    """

    def test_ensure_utf8_console_switches_a_cp1252_stream(self):
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding="cp1252")
        common.ensure_utf8_console(stream)
        self.assertEqual(stream.encoding, "utf-8")

    def test_ensure_utf8_console_is_idempotent_and_tolerates_plain_streams(self):
        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding="cp1252")
        common.ensure_utf8_console(stream)
        common.ensure_utf8_console(stream)  # second call must not raise
        self.assertEqual(stream.encoding, "utf-8")
        # A stream without reconfigure (e.g. a test double) is left alone.
        common.ensure_utf8_console(io.StringIO())

    def test_cjk_output_survives_a_cp1252_console(self):
        vault = make_scratch_vault()
        try:
            raw = io.BytesIO()
            stream = io.TextIOWrapper(raw, encoding="cp1252")
            common.ensure_utf8_console(stream)
            with redirect_stdout(stream):
                mem_mod.cmd_submit(
                    type("A", (), {"agent": "dsh", "fact": "- the vault keeps CJK in 记忆遗忘区"})()
                )
            stream.flush()
            # The submission path contains CJK (Agent提交区); it must reach the
            # byte stream as UTF-8 instead of raising UnicodeEncodeError.
            self.assertIn("Agent提交区".encode("utf-8"), raw.getvalue())
        finally:
            destroy_scratch(vault)


if __name__ == "__main__":
    unittest.main()
