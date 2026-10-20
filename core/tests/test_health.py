# -*- coding: utf-8 -*-
"""Tests for health diagnostics and derived-data garbage collection."""
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import common, health, index


class DoctorTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def test_clean_vault_reports_ok(self):
        with patch("unified_memory.embed.configured", return_value=False):
            report = health.doctor(self.vault)
        self.assertTrue(report["ok"])
        self.assertEqual(report["inbox"]["count"], 0)
        self.assertEqual(report["conflicts"]["count"], 0)
        self.assertIsInstance(report["index"]["memories"], int)

    def test_sync_conflict_copy_is_an_error(self):
        ctx = common.canonical_dir(self.vault)
        (ctx / "prefs 2.md").write_text("# copy\n\n- duplicate truth\n", encoding="utf-8")
        with patch("unified_memory.embed.configured", return_value=False):
            report = health.doctor(self.vault)
        self.assertFalse(report["ok"])
        self.assertIn("sync-conflict-copies", [issue["code"] for issue in report["issues"]])

    def test_stale_inbox_is_a_warning(self):
        inbox = common.canonical_dir(self.vault) / "Agent提交区"
        stale = inbox / "dsh-20200101-000000-01.md"
        stale.write_text("- old pending fact\n", encoding="utf-8")
        old = time.time() - 10 * 86400
        os.utime(stale, (old, old))
        with patch("unified_memory.embed.configured", return_value=False):
            report = health.doctor(self.vault)
        self.assertIn("inbox-stale", [issue["code"] for issue in report["issues"]])


class OrphanIndexReportTest(unittest.TestCase):
    """doctor must not print a command that removes nothing.

    `gc` only deletes an orphan older than ORPHAN_INDEX_DAYS, and that guard is
    right — a vault can be temporarily unavailable, and deleting its index over
    a disconnected drive would be worse than the wasted disk. But the report
    counted every orphan and told the reader to run the default command, which
    is a no-op for the case that actually occurs: a database orphaned minutes
    ago by a vault move. The reader runs it, nothing happens, and the item is
    still on the page tomorrow saying the same thing.

    `_orphan_indexes` is patched rather than exercised here: these tests are
    about the branch, and the real `~/.unified-memory` directory is shared
    machine state, so a stray orphan from some other run would decide which
    branch the test ends up on.
    """

    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def _report(self, items: list[dict]) -> dict:
        with patch("unified_memory.health._orphan_indexes", return_value=items), \
             patch("unified_memory.embed.configured", return_value=False):
            return health.doctor(self.vault)

    def _issue(self, report: dict) -> dict:
        return next(issue for issue in report["issues"] if issue["code"] == "orphan-indexes")

    def test_a_fresh_orphan_gets_a_command_that_would_actually_remove_it(self):
        report = self._report([{"path": "x/index-1.db", "bytes": 1024, "ageDays": 0.2}])

        self.assertEqual(report["orphanIndexes"]["count"], 1)
        self.assertEqual(report["orphanIndexes"]["prunable"], 0)
        self.assertEqual(report["orphanIndexes"]["newestAgeDays"], 0.2)
        hint = self._issue(report)["hint"]
        self.assertIn("--older-than 0", hint)
        self.assertNotIn("Run `memory gc --apply` to remove indexes", hint)
        # "removes the 0 that are old enough" is a sentence that reads as an
        # instruction while describing a no-op. When nothing is prunable, say so.
        self.assertNotIn("removes the 0", hint)
        self.assertIn("All 1 are younger than", hint)
        # And the message says why the count it reports is not the count it can
        # act on — otherwise the next doctor run is a surprise.
        self.assertIn("all newer than", self._issue(report)["message"])

    def test_an_old_orphan_gets_the_plain_command_and_no_caveat(self):
        report = self._report([{"path": "x/index-2.db", "bytes": 1024, "ageDays": 45}])

        self.assertEqual(report["orphanIndexes"]["prunable"], 1)
        hint = self._issue(report)["hint"]
        self.assertIn("Run `memory gc --apply` to remove indexes", hint)
        self.assertNotIn("--older-than 0", hint)
        self.assertNotIn("newer", self._issue(report)["message"])

    def test_a_mixed_pair_is_reported_as_two_numbers(self):
        # "1 orphan index" and then "the command removed 0" is the same bug
        # wearing a different hat. Both halves are named.
        report = self._report([
            {"path": "x/index-3.db", "bytes": 1024, "ageDays": 45},
            {"path": "x/index-4.db", "bytes": 2048, "ageDays": 0.1},
        ])

        self.assertEqual(report["orphanIndexes"]["count"], 2)
        self.assertEqual(report["orphanIndexes"]["prunable"], 1)
        self.assertEqual(report["orphanIndexes"]["newestAgeDays"], 0.1)
        message = self._issue(report)["message"]
        self.assertIn("1 older than", message)
        self.assertIn("1 newer", message)


class GcTest(unittest.TestCase):
    def setUp(self):
        self.vault = make_scratch_vault()

    def tearDown(self):
        destroy_scratch(self.vault)

    def _make_db(self, name, doc_path):
        db = index.index_db_for(self.vault).parent / name
        conn = sqlite3.connect(str(db))
        try:
            conn.execute("CREATE TABLE docs (path TEXT PRIMARY KEY, digest TEXT, title TEXT)")
            conn.execute(
                "INSERT INTO docs (path, digest, title) VALUES (?, 'd', 't')",
                (str(doc_path),),
            )
            conn.commit()
        finally:
            conn.close()
        return db

    def test_orphan_index_is_removed_and_live_one_is_kept(self):
        missing = Path(tempfile.gettempdir()) / "no-such-vault-xyz" / "note.md"
        orphan = self._make_db("index-deadbeefdeadbeef.db", missing)
        live = self._make_db("index-feedfacefeedface.db", common.canonical_path(self.vault, "prefs"))
        report = health.gc(
            self.vault, apply=True, older_than_days=0, vacuum=False, rebuild_graph=False
        )
        removed = {Path(item["path"]).name for item in report["orphanIndexes"]}
        self.assertIn(orphan.name, removed)
        self.assertFalse(orphan.exists())
        self.assertTrue(live.exists(), "a DB whose vault still exists must be kept")
        self.assertTrue(index.index_db_for(self.vault).exists())


if __name__ == "__main__":
    unittest.main()
