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
            self.assertEqual(schema._read_version(conn), 10)
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
            self.assertEqual(schema._read_version(conn), 10)
        finally:
            conn.close()

    def test_fresh_database_is_marked_current(self) -> None:
        conn = schema.get_conn(self.vault)
        try:
            self.assertEqual(schema._read_version(conn), 10)
        finally:
            conn.close()

    def test_downgrade_is_left_alone(self) -> None:
        conn = schema.get_conn(self.vault)
        _fill_learning_data(conn)
        conn.execute(
            "UPDATE index_meta SET value = ? WHERE key = 'schema_version'", ("9",)
        )
        conn.commit()
        conn.close()
        conn = schema.get_conn(self.vault)
        try:
            self.assertEqual(schema._read_version(conn), 10)
            self.assertEqual(_counts(conn)["memories"], 100)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
