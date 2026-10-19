# -*- coding: utf-8 -*-
"""config — the single writer of ~/.unified-memory.yaml.

The bug this guards against: three independent read-modify-write paths meant a
`memory use` racing a `memory digest --off` could drop whichever key lost the
race. These tests pin the three properties that make that impossible:

  * unknown keys and comments survive an edit;
  * an unchanged value produces no write at all (no sync churn);
  * concurrent writers serialize through the lock, so both keys end up present.
"""
import os
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

# Imported for its side effect: it puts core/ on sys.path and pins CONFIG_PATH
# into a temp dir, so nothing here can reach the user's real ~/.unified-memory.yaml.
from test_common import assert_guard_intact
from unified_memory import config


class ConfigWriterTest(unittest.TestCase):
    def setUp(self):
        assert_guard_intact()
        self.dir = Path(tempfile.mkdtemp(prefix="um-config-"))
        self.path = self.dir / "config.yaml"

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def seed(self, text):
        self.path.write_text(text, encoding="utf-8")

    # -- line preservation ------------------------------------------------

    def test_set_key_preserves_unknown_keys_and_comments(self):
        self.seed("# 手写注释\nvault: C:\\old\ndigest.enabled: true\nremote.url: http://x\n")
        config.set_key("vault", "C:\\new", self.path)
        text = self.path.read_text(encoding="utf-8")
        self.assertIn("# 手写注释", text)
        self.assertIn("vault: C:\\new", text)
        self.assertIn("digest.enabled: true", text)
        self.assertIn("remote.url: http://x", text)
        self.assertNotIn("C:\\old", text)

    def test_set_key_replaces_rather_than_duplicates(self):
        self.seed("vault: a\nvault: b\n")
        config.set_key("vault", "c", self.path)
        lines = [ln for ln in self.path.read_text(encoding="utf-8").splitlines() if ln.strip()]
        self.assertEqual([ln for ln in lines if ln.startswith("vault:")], ["vault: c"])

    def test_set_key_creates_the_file_when_absent(self):
        self.assertFalse(self.path.exists())
        config.set_key("vault", "C:\\v", self.path)
        self.assertEqual(config.get("vault", path=self.path), "C:\\v")

    def test_quoted_value_is_recognised_as_unchanged(self):
        self.seed('vault: "C:\\v"\n')
        before = self.path.stat().st_mtime_ns
        config.set_key("vault", "C:\\v", self.path)
        self.assertEqual(before, self.path.stat().st_mtime_ns, "no write when the value already matches")

    def test_unchanged_value_does_not_rewrite(self):
        self.seed("vault: C:\\v\ndigest.enabled: true\n")
        before = self.path.stat().st_mtime_ns
        config.set_key("digest.enabled", "true", self.path)
        self.assertEqual(before, self.path.stat().st_mtime_ns)

    # -- unset / batch ----------------------------------------------------

    def test_unset_key_removes_only_that_line(self):
        self.seed("vault: a\nother: b\n")
        self.assertTrue(config.unset_key("vault", self.path))
        text = self.path.read_text(encoding="utf-8")
        self.assertNotIn("vault:", text)
        self.assertIn("other: b", text)

    def test_unset_missing_key_reports_no_change(self):
        self.seed("other: b\n")
        self.assertFalse(config.unset_key("vault", self.path))

    def test_set_keys_writes_once(self):
        self.seed("keep: me\n")
        config.set_keys({"vault": "C:\\v", "digest.enabled": "false"}, self.path)
        text = self.path.read_text(encoding="utf-8")
        self.assertIn("keep: me", text)
        self.assertIn("vault: C:\\v", text)
        self.assertIn("digest.enabled: false", text)

    def test_set_keys_skips_the_write_when_nothing_changes(self):
        self.seed("vault: C:\\v\ndigest.enabled: false\n")
        before = self.path.stat().st_mtime_ns
        config.set_keys({"vault": "C:\\v", "digest.enabled": "false"}, self.path)
        self.assertEqual(before, self.path.stat().st_mtime_ns)

    # -- backup -----------------------------------------------------------

    def test_backup_is_written_before_the_first_change(self):
        self.seed("vault: old\n")
        config.set_key("vault", "new", self.path)
        backups = list(self.dir.glob("config.yaml.bak-*"))
        self.assertEqual(len(backups), 1)
        self.assertIn("vault: old", backups[0].read_text(encoding="utf-8"))

    # -- concurrency ------------------------------------------------------

    def test_concurrent_writers_keep_both_keys(self):
        """The exact race the three old writers could lose."""
        self.seed("vault: seed\n")
        errors = []

        def hammer(key, value, rounds):
            try:
                for _ in range(rounds):
                    config.set_key(key, value, self.path)
                    time.sleep(0.001)
            except Exception as exc:  # noqa: BLE001 — surfaced below
                errors.append(exc)

        threads = [
            threading.Thread(target=hammer, args=("vault", "C:\\v", 40)),
            threading.Thread(target=hammer, args=("digest.enabled", "false", 40)),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [])
        from unified_memory.common import parse_config

        parsed = parse_config(self.path)
        self.assertEqual(parsed.get("vault"), "C:\\v")
        self.assertEqual(parsed.get("digest.enabled"), "false")
        self.assertFalse(list(self.dir.glob("config.yaml.lock")), "lock must be released")

    def test_stale_lock_is_recovered(self):
        self.seed("vault: old\n")
        lock = self.path.with_name(self.path.name + ".lock")
        lock.write_text("pid=999999\n", encoding="utf-8")
        # Backdate it past the staleness window.
        old = time.time() - config.LOCK_TIMEOUT_S - 5
        os.utime(lock, (old, old))
        config.set_key("vault", "new", self.path)
        self.assertEqual(config.get("vault", path=self.path), "new")

    def test_a_lost_creation_race_is_retried_instead_of_raising(self):
        """Windows reports a lost O_EXCL race as ERROR_ACCESS_DENIED.

        `os.open(..., O_CREAT | O_EXCL)` raises PermissionError rather than
        FileExistsError when two writers create the lock at the same instant,
        so treating only FileExistsError as "someone else has it" made the lock
        crash under exactly the contention it exists to serialise. The retry
        path is exercised here by failing the first attempt while a stale lock
        is on disk, which the acquisition must recover from without waiting out
        the whole deadline.
        """
        lock = self.path.with_name(self.path.name + ".lock")
        lock.write_text("pid=999999\n", encoding="utf-8")
        old = time.time() - config.LOCK_TIMEOUT_S - 5
        os.utime(lock, (old, old))

        real_open = os.open
        attempts = {"n": 0}

        def lost_race(*args, **kwargs):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise PermissionError(13, "Permission denied")
            return real_open(*args, **kwargs)

        with mock.patch.object(config.os, "open", side_effect=lost_race):
            with config._locked(self.path):
                pass
        self.assertGreaterEqual(attempts["n"], 2, "the failed creation must be retried")
        self.assertFalse(lock.exists(), "the lock is released when the block exits")


if __name__ == "__main__":
    unittest.main()
