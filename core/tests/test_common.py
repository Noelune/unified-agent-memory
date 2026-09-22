# -*- coding: utf-8 -*-
"""Shared helpers for core tests: scratch vaults under a temp dir.

The real ~/.unified-memory.yaml and ~/.unified-memory/index-*.db are NEVER
touched by any test in this suite:

  * importing this module (which every core test file does, directly or via
    unittest discovery) arms a process-wide guard that pins memory.INDEX_DB,
    common.CONFIG_PATH and the UNIFIED_MEMORY_* env overrides into one
    session-scoped temp dir;
  * that guard is deliberately NEVER lifted. Tests share one process, so
    un-arming it in a single tearDown would re-open the real home for every
    later test — the exact state-dependent leak this file exists to prevent.

The guard is what makes the isolation import-order independent: a test class
that only rebinds memory.INDEX_DB (see test_stats._ScratchIndexTest) still
inherits a non-real CONFIG_PATH and env, instead of falling back to the user's
real ~/.unified-memory.yaml through resolve_vault().
"""
import atexit
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
from unified_memory import schema


def index_db_name_for(vault: Path) -> str:
    """The per-vault DB filename schema.index_db_for() derives from ``vault``.

    Mirrored here instead of imported so the tests keep working even when the
    helper moves; ``vault`` must be resolved exactly as schema.py resolves it.
    """
    key = hashlib.sha256(str(Path(vault).resolve()).encode("utf-8")).hexdigest()[:16]
    return f"index-{key}.db"


# --------------------------------------------------------------------------
# Session-wide isolation guard (armed on import, never lifted)
# --------------------------------------------------------------------------

_REAL_HOME_SUFFIX = ("\\.unified-memory", "/.unified-memory")


def _is_real_home_path(p) -> bool:
    """True when ``p`` lives under the user's real ~/.unified-memory/."""
    norm = str(p).lower().replace("\\", "/").rstrip("/")
    return any(norm == s.replace("\\", "/") or norm.startswith(s.replace("\\", "/") + "/")
               for s in _REAL_HOME_SUFFIX)


_GUARD_ROOT = Path(tempfile.mkdtemp(prefix="um-guard-"))
_GUARD_INDEX_DB = _GUARD_ROOT / "index.db"
_GUARD_CONFIG = _GUARD_ROOT / "config.yaml"


def _arm_guard() -> None:
    """Pin every real-home escape hatch into the guard dir. Idempotent."""
    common.CONFIG_PATH = _GUARD_CONFIG
    mem_mod.CONFIG_PATH = _GUARD_CONFIG
    mem_mod.INDEX_DB = _GUARD_INDEX_DB
    os.environ["UNIFIED_MEMORY_INDEX_DB"] = str(_GUARD_INDEX_DB)
    # UNIFIED_MEMORY_VAULT keeps resolve_vault() off the real config file. It is
    # overwritten per scratch vault and only restored to the guard dir (never
    # to the real vault) so no test can reach the real one.
    os.environ.setdefault("UNIFIED_MEMORY_VAULT", str(_GUARD_ROOT / "vault"))


_arm_guard()
atexit.register(shutil.rmtree, _GUARD_ROOT, True)


def assert_guard_intact() -> None:
    """Fail loudly if anything re-pointed a redirect at the real home."""
    if _is_real_home_path(mem_mod.INDEX_DB) or _is_real_home_path(common.CONFIG_PATH):
        raise AssertionError(
            f"test isolation guard was defeated: INDEX_DB={mem_mod.INDEX_DB} "
            f"CONFIG_PATH={common.CONFIG_PATH}"
        )


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
    # Re-arm the guard instead of popping: popping would leave the session with
    # no redirect at all, so the next test file to run would resolve the real
    # ~/.unified-memory.yaml and write the user's real index. Popping was the
    # original, too-early reset.
    _arm_guard()


class ScratchIsolationGuardTest(unittest.TestCase):
    """The whole test session must be armoured against the real home dir.

    Regression guard for the leak where a test process reached the user's real
    ~/.unified-memory.yaml (init_vault rewrites it) and the real
    ~/.unified-memory/index-*.db (get_conn writes it). File counts never caught
    it because SQLite rewrites an existing file in place — only the *target
    path* proves which home a test would write to.
    """

    REAL_HOME = Path.home() / ".unified-memory"
    REAL_CFG = Path.home() / ".unified-memory.yaml"

    def test_index_db_base_is_never_under_the_real_home(self):
        self.assertFalse(
            str(mem_mod.INDEX_DB).startswith(str(self.REAL_HOME)),
            f"memory.INDEX_DB leaks into the real home: {mem_mod.INDEX_DB}",
        )
        # index_db_for() is what every get_conn() actually opens: it must be
        # outside the real home for ANY vault (scratch, real, or unknown).
        for vault in (Path.home(), Path(tempfile.gettempdir()), self.REAL_HOME):
            self.assertFalse(
                str(schema.index_db_for(vault)).startswith(str(self.REAL_HOME)),
                f"index_db_for({vault}) leaks into the real home",
            )

    def test_config_path_is_never_the_real_home_config(self):
        self.assertNotEqual(Path(common.CONFIG_PATH), self.REAL_CFG)
        self.assertNotEqual(Path(mem_mod.CONFIG_PATH), self.REAL_CFG)
        # The factory must not silently switch the redirect back on teardown:
        # a later test in the same process would then write the real config.
        vault = make_scratch_vault()
        try:
            self.assertNotEqual(Path(mem_mod.CONFIG_PATH), self.REAL_CFG)
        finally:
            destroy_scratch(vault)
        self.assertNotEqual(
            Path(mem_mod.CONFIG_PATH), self.REAL_CFG,
            "destroy_scratch() un-armed the config redirect (too-early reset)",
        )

    def test_env_overrides_survive_teardown_for_armed_sessions(self):
        # A spawned child re-imports memory.py, so the env override is the only
        # thing that protects it. Tearing one scratch vault down must not drop
        # the override while other tests still run in this process.
        vault = make_scratch_vault()
        destroy_scratch(vault)
        self.assertTrue(
            os.environ.get("UNIFIED_MEMORY_INDEX_DB"),
            "destroy_scratch() dropped UNIFIED_MEMORY_INDEX_DB while the session is still live",
        )
        self.assertFalse(
            str(os.environ["UNIFIED_MEMORY_INDEX_DB"]).startswith(str(self.REAL_HOME)),
            "the surviving env override points into the real home",
        )


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
