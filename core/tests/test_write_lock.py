# -*- coding: utf-8 -*-
"""The three canonical writers, and the lock that makes them safe.

`core` has exactly three functions that rewrite 50-Agent-Context notes:
`promoter.promote`, `forgetter.demote` and `maintenance.repair_existing`. Each
of them takes the vault's `common.file_lock`, and that — not a declaration file
naming an owner — is the whole of the coordination story.

This file replaces `test_owner.py`, which pinned a different design: a
`hermes-owner.lock` declaration naming a single writer, with a claim/release CLI
and a refusal in all three paths. That design was removed (2026-10-19) because
it encoded a deployment the shipped plugin cannot be in: the plugin ships with
dsh and *is* the writer. For everyone else the declaration file was absent (so
it did nothing) or present by accident (so it refused every promotion with a
message about a product the user never installed). The race it claimed to
prevent is prevented by the lock, which these tests check.

Two kinds of check, because each catches what the other misses:

  * structural — each of the three functions takes the lock. Cheap, covers all
    three, and fails the moment someone deletes a `with file_lock(vault):`.
    It has to patch the MODULE-LOCAL name: every writer does
    `from .common import file_lock`, so patching `common.file_lock` would prove
    nothing about the binding the writer actually calls.
  * behavioural — a second writer really waits for the first. Slow-ish and only
    exercised through `promote`, but it is the only one that would catch a lock
    that is taken and then ignored.
"""
import argparse
import threading
import time
import unittest
from unittest import mock

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import common, forgetter, maintenance, promoter
from unified_memory import memory as mem_mod


def _recording_lock(recorded, label):
    """A stand-in for `file_lock` that records that it was entered."""

    class _Probe:
        def __enter__(self):
            recorded.append(label)
            return None

        def __exit__(self, *exc_info):
            return False

    def factory(vault=None, **kwargs):  # accepts the same positional vault
        return _Probe()

    return factory


class EveryCanonicalWriterTakesTheLockTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_promote_takes_the_lock(self):
        recorded = []
        with mock.patch.object(promoter, "file_lock", _recording_lock(recorded, "promote")):
            promoter.promote(self.vault, [{"分类": "prefs", "内容": "锁内写入的事实", "来源": "test"}])
        self.assertEqual(recorded, ["promote"])

    def test_demote_takes_the_lock(self):
        recorded = []
        with mock.patch.object(forgetter, "file_lock", _recording_lock(recorded, "demote")):
            forgetter.demote(self.vault, dry_run=False)
        self.assertEqual(recorded, ["demote"])

    def test_repair_existing_takes_the_lock(self):
        recorded = []
        with mock.patch.object(maintenance, "file_lock", _recording_lock(recorded, "repair")):
            maintenance.repair_existing(self.vault, dry_run=False)
        self.assertEqual(recorded, ["repair"])


class TheLockActuallyExcludesTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_a_second_writer_waits_for_the_first(self):
        """A promote started while the vault is locked must finish after it.

        The main thread holds the lock and starts a promote; the promote appends
        a fact. If it wrote without waiting, its entry would land between
        ``A-in`` and ``A-out``. The wait for ``B-start`` is what makes the
        assertion discriminating rather than merely ordered: it guarantees the
        writer has reached the promote call before the hold is released.
        """
        order = []

        def writer():
            order.append("B-start")
            promoter.promote(self.vault, [{"分类": "prefs", "内容": "并发写入的事实", "来源": "test"}])
            order.append("B-done")

        with common.file_lock(self.vault):
            order.append("A-in")
            thread = threading.Thread(target=writer, daemon=True)
            thread.start()
            deadline = time.time() + 10
            while "B-start" not in order and time.time() < deadline:
                time.sleep(0.01)
            # The writer is now inside promote; if the lock were ignored this is
            # far more time than it needs to finish.
            time.sleep(0.3)
            order.append("A-out")
        thread.join(10)

        self.assertEqual(order, ["A-in", "B-start", "A-out", "B-done"])
        self.assertIn("并发写入的事实", common.read_maybe(common.canonical_path(self.vault, "prefs")))


class NoDeclaredOwnerTest(unittest.TestCase):
    """The removed design must not creep back by reflex."""

    def test_common_has_no_owner_declaration(self):
        for gone in (
            "assert_canonical_writable",
            "canonical_owner",
            "claim_canonical_owner",
            "release_canonical_owner",
            "owner_lock_path",
            "CanonicalOwnerError",
        ):
            self.assertFalse(hasattr(common, gone), f"{gone} is back in common.py")

    def test_the_cli_has_no_owner_verb(self):
        # `memory owner --claim hermes` is in somebody's cron or notes; if the
        # verb ever comes back it has to be a deliberate decision with a
        # migration, not an accidental one.
        parser = mem_mod.build_parser()
        verbs = set()
        for action in parser._actions:
            if isinstance(action, argparse._SubParsersAction):
                verbs.update(action.choices)
        self.assertNotIn("owner", verbs)
        # `search`, not `promote`: promotion is its own entry point
        # (`python -m unified_memory.promoter`), so this also documents that the
        # two CLIs are separate surfaces.
        self.assertIn("search", verbs)  # the parser was actually inspected


if __name__ == "__main__":
    unittest.main()
