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
