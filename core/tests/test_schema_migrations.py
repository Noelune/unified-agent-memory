# -*- coding: utf-8 -*-
"""Migration tests: an upgrade must never wipe learning data.

Guards the batch-A fix for the "schema bump deletes memories/embeddings/
access_log" defect: every migration is additive, runs in one transaction and
leaves a .v<old>.bak file behind.
"""
from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from unified_memory import schema


def _fill_learning_data(conn: sqlite3.Connection) -> None:
    memory_rows = [
        (str(n), "note.md", "fact line " + str(n), n) for n in range(100)
    ]
    conn.executemany(
        "INSERT OR REPLACE INTO memories "
        "(id, doc, line, type, importance, status, version, superseded_by, "
        " source_agent, project, created_at, updated_at, access_count, metadata_json) "
        "VALUES (?, ?, ?, 'fact', 0.5, 'active', 1, NULL, 'test', '', "
        "        '2026-01-01T00:00:00', '2026-01-01T00:00:00', ?, '{}')",
        memory_rows,
    )
    embedding_rows = [(str(n), b"\x00\x00\x00\x00") for n in range(50)]
    conn.executemany(
        "INSERT OR REPLACE INTO embeddings (memory_id, dim, vector) VALUES (?, 4, ?)",
        embedding_rows,
    )
    access_rows = [(str(n % 100), "2026-01-02T00:00:00") for n in range(200)]
    conn.executemany(
        "INSERT INTO access_log (memory_id, at) VALUES (?, ?)",
        access_rows,
    )
    conn.commit()


def _counts(conn: sqlite3.Connection) -> dict[str, int]:
    return {
        "memories": conn.execute("SELECT COUNT(*) AS c FROM memories").fetchone()["c"],
        "embeddings": conn.execute("SELECT COUNT(*) AS c FROM embeddings").fetchone()["c"],
        "access_log": conn.execute("SELECT COUNT(*) AS c FROM access_log").fetchone()["c"],
    }


class SchemaMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = Path(self._tmp.name) / "vault"
        self.vault.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _downgrade_to(self, version: int) -> Path:
        conn = schema.get_conn(self.vault)
        _fill_learning_data(conn)
        conn.close()
        db = schema.index_db_for(self.vault)
        conn = sqlite3.connect(str(db))
        conn.execute(
            "UPDATE index_meta SET value = ? WHERE key = 'schema_version'",
            (str(version),),
        )
        conn.commit()
        conn.close()
        return db

    def _read_stored_version(self, db: Path) -> str:
        conn = sqlite3.connect(str(db))
        conn.row_factory = sqlite3.Row
        try:
            return str(
                conn.execute(
                    "SELECT value FROM index_meta WHERE key = 'schema_version'"
                ).fetchone()["value"]
            )
        finally:
            conn.close()

    def test_upgrade_from_v3_preserves_learning_data(self) -> None:
        db = self._downgrade_to(3)
        conn = schema.get_conn(self.vault)
        try:
            counts = _counts(conn)
            self.assertEqual(counts["memories"], 100)
            self.assertEqual(counts["embeddings"], 50)
            self.assertEqual(counts["access_log"], 200)
            self.assertEqual(schema._read_version(conn), int(schema.SCHEMA_VERSION))
        finally:
            conn.close()
        self.assertTrue(db.with_name(db.stem + ".v3.bak").exists())

    def test_older_version_also_preserved(self) -> None:
        self._downgrade_to(2)
        conn = schema.get_conn(self.vault)
        try:
            self.assertEqual(_counts(conn)["memories"], 100)
        finally:
            conn.close()

    def test_failed_migration_rolls_back(self) -> None:
        db = self._downgrade_to(3)

        def exploding_step(_conn: sqlite3.Connection) -> None:
            _conn.execute("DELETE FROM memories")
            raise RuntimeError("boom mid-migration")

        original = dict(schema.MIGRATIONS)
        schema.MIGRATIONS[4] = exploding_step
        try:
            with self.assertRaises(RuntimeError):
                schema.get_conn(self.vault)
        finally:
            schema.MIGRATIONS.clear()
            schema.MIGRATIONS.update(original)

        conn = sqlite3.connect(str(db))
        conn.row_factory = sqlite3.Row
        try:
            self.assertEqual(
                conn.execute("SELECT COUNT(*) AS c FROM memories").fetchone()["c"], 100
            )
            self.assertEqual(self._read_stored_version(db), "3")
        finally:
            conn.close()
        # And a healthy reopen completes the migration without data loss.
        conn = schema.get_conn(self.vault)
        try:
            self.assertEqual(
                conn.execute("SELECT COUNT(*) AS c FROM memories").fetchone()["c"], 100
            )
            self.assertEqual(schema._read_version(conn), int(schema.SCHEMA_VERSION))
        finally:
            conn.close()

    def test_fresh_database_is_marked_current(self) -> None:
        conn = schema.get_conn(self.vault)
        try:
            self.assertEqual(schema._read_version(conn), int(schema.SCHEMA_VERSION))
        finally:
            conn.close()

    def test_downgrade_is_left_alone(self) -> None:
        conn = schema.get_conn(self.vault)
        _fill_learning_data(conn)
        # "99" is NEWER than this build: a rollback scenario. The code must
        # not touch a database written by a newer schema.
        conn.execute(
            "UPDATE index_meta SET value = ? WHERE key = 'schema_version'", ("99",)
        )
        conn.commit()
        conn.close()
        conn = schema.get_conn(self.vault)
        try:
            self.assertEqual(schema._read_version(conn), 99)
            self.assertEqual(_counts(conn)["memories"], 100)
        finally:
            conn.close()

    def test_true_v4_database_with_old_column_shape_migrates(self) -> None:
        # Reproduces the REAL upgrade path: a database written by 0.8.8 has a
        # memories table WITHOUT text_hash/legacy_id, and _ensure_schema's
        # index on text_hash used to run before the column existed — every
        # real upgrade crashed. Found by opening a copy of the live index.
        from unified_memory import memory as memory_mod

        vault = Path(self._tmp.name) / "old-vault"
        vault.mkdir()
        original_db = memory_mod.INDEX_DB
        memory_mod.INDEX_DB = Path(self._tmp.name) / "base.db"
        try:
            db = schema.index_db_for(vault)
            conn = sqlite3.connect(str(db))
            conn.row_factory = sqlite3.Row
            try:
                conn.execute(
                    "CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
                )
                conn.execute(
                    "CREATE TABLE memories (id TEXT PRIMARY KEY, doc TEXT NOT NULL, "
                    "line TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'fact', "
                    "importance REAL NOT NULL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'active', "
                    "version INTEGER NOT NULL DEFAULT 1, superseded_by TEXT, "
                    "source_agent TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '', "
                    "created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', "
                    "access_count INTEGER NOT NULL DEFAULT 0, metadata_json TEXT NOT NULL DEFAULT '{}')"
                )
                conn.execute(
                    "INSERT INTO index_meta (key, value) VALUES ('schema_version', '4')"
                )
                conn.execute(
                    "INSERT INTO memories (id, doc, line) VALUES ('legacy', 'note.md', 'fact one')"
                )
                conn.commit()
            finally:
                conn.close()

            conn = schema.get_conn(vault)
            try:
                self.assertEqual(schema._read_version(conn), int(schema.SCHEMA_VERSION))
                row = conn.execute(
                    "SELECT legacy_id, text_hash FROM memories WHERE legacy_id = 'legacy'"
                ).fetchone()
                self.assertIsNotNone(row)
                self.assertNotEqual(row["text_hash"], "")
            finally:
                conn.close()
        finally:
            memory_mod.INDEX_DB = original_db

    def test_v10_to_v11_adds_the_ledger_tables_additively(self) -> None:
        # Batch D1: the four projection tables are ADDED (PLAN §4.2); the
        # learning tables keep every row (I4) and the version moves to 11.
        db = self._downgrade_to(10)
        schema.get_conn(self.vault).close()
        self.assertEqual(self._read_stored_version(db), "11")
        check = sqlite3.connect(str(db))
        check.row_factory = sqlite3.Row
        try:
            counts = {
                name: check.execute(f"SELECT COUNT(*) AS c FROM {name}").fetchone()["c"]
                for name in ("claims", "occurrences", "links", "events",
                             "memories", "embeddings", "access_log")
            }
            # New tables exist and start empty; learning tables keep their rows.
            for name in ("claims", "occurrences", "links", "events"):
                self.assertEqual(counts[name], 0, name)
            self.assertGreater(counts["memories"], 0)
            self.assertGreater(counts["access_log"], 0)
        finally:
            check.close()


if __name__ == "__main__":
    unittest.main()
