# -*- coding: utf-8 -*-
"""Occurrence identity (batch A): a fact belongs to its note.

The old content-hash primary key silently merged the same sentence promoted
into two notes — one row, last writer's provenance — and deleting the
surviving note made the fact unsearchable even though the other note still
held it. ids are now scoped per document; text_hash remains the cross-document
duplicate signal.
"""
from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from test_common import destroy_scratch, make_scratch_vault
from unified_memory import index, schema, search
from unified_memory.common import canonical_dir

LINE = "- the staging server runs on 127.0.0.1:8080（写入 2026-01-01｜来源：Agent提交区/x-1.md）\n"


def _rows(vault: Path, needle: str = "staging server") -> list[sqlite3.Row]:
    conn = index.get_conn(vault)
    try:
        return conn.execute(
            "SELECT id, doc, line, text_hash, legacy_id, access_count "
            "FROM memories WHERE line LIKE ? ORDER BY doc",
            ("%" + needle + "%",),
        ).fetchall()
    finally:
        conn.close()


class OccurrenceIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.vault = make_scratch_vault()

    def tearDown(self) -> None:
        destroy_scratch(self.vault)

    def test_same_line_in_two_notes_keeps_two_provenances(self) -> None:
        ctx = canonical_dir(self.vault)
        (ctx / "我的偏好摘要.md").write_text(LINE, encoding="utf-8")
        (ctx / "工程执行规则.md").write_text(LINE, encoding="utf-8")
        index.update_index(self.vault)
        rows = _rows(self.vault)
        self.assertEqual(len(rows), 2)
        self.assertEqual({r["doc"] for r in rows},
                         {str(ctx / "我的偏好摘要.md"), str(ctx / "工程执行规则.md")})
        self.assertEqual(len({r["id"] for r in rows}), 2)
        self.assertEqual(len({r["text_hash"] for r in rows}), 1)

    def test_deleting_one_note_keeps_the_other_searchable(self) -> None:
        ctx = canonical_dir(self.vault)
        (ctx / "我的偏好摘要.md").write_text(LINE, encoding="utf-8")
        (ctx / "工程执行规则.md").write_text(LINE, encoding="utf-8")
        index.update_index(self.vault)
        (ctx / "我的偏好摘要.md").unlink()
        index.update_index(self.vault)
        result = search.hybrid_search(self.vault, "staging server", limit=8)
        self.assertGreaterEqual(result["count"], 1)
        hits = [i for i in result["results"] if "staging server" in i["line"]]
        self.assertGreaterEqual(len(hits), 1)
        for item in hits:
            self.assertTrue(item["doc"].endswith("工程执行规则.md"))

    def test_duplicate_line_in_one_note_is_one_memory(self) -> None:
        ctx = canonical_dir(self.vault)
        (ctx / "我的偏好摘要.md").write_text(LINE + LINE, encoding="utf-8")
        index.update_index(self.vault)
        rows = _rows(self.vault)
        self.assertEqual(len(rows), 1)

    def test_unchanged_line_keeps_stats_when_a_sibling_is_edited(self) -> None:
        ctx = canonical_dir(self.vault)
        note = ctx / "我的偏好摘要.md"
        note.write_text(
            LINE + "- another fact here（写入 2026-01-02｜来源：Agent提交区/x-2.md）\n",
            encoding="utf-8",
        )
        index.update_index(self.vault)
        result = search.hybrid_search(self.vault, "staging server", limit=3)
        conn = index.get_conn(self.vault)
        try:
            before = conn.execute(
                "SELECT access_count FROM memories WHERE line LIKE '%staging%'"
            ).fetchone()["access_count"]
        finally:
            conn.close()
        self.assertGreater(before, 0)
        note.write_text(
            LINE + "- a different sibling line（写入 2026-01-03｜来源：Agent提交区/x-3.md）\n",
            encoding="utf-8",
        )
        index.update_index(self.vault)
        conn = index.get_conn(self.vault)
        try:
            after = conn.execute(
                "SELECT access_count FROM memories WHERE line LIKE '%staging%'"
            ).fetchone()["access_count"]
        finally:
            conn.close()
        self.assertEqual(after, before)


class OccurrenceMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = Path(self._tmp.name) / "vault"
        self.vault.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_v4_rows_are_remapped_and_remembered(self) -> None:
        conn = index.get_conn(self.vault)
        try:
            conn.execute(
                "INSERT INTO memories (id, doc, line, type, importance, status, "
                "version, source_agent, project, created_at, updated_at, "
                "access_count, metadata_json) "
                "VALUES ('legacy-1', 'note.md', 'fact one', 'fact', 0.5, "
                "'active', 1, 'dsh', '', '2026-01-01', '2026-01-01', 7, '{}')"
            )
            conn.execute(
                "INSERT INTO embeddings (memory_id, dim, vector) "
                "VALUES ('legacy-1', 4, ?)",
                (b"\x00\x00\x00\x00",),
            )
            conn.execute(
                "INSERT INTO access_log (memory_id, at) VALUES ('legacy-1', '2026-01-02')"
            )
            conn.execute(
                "UPDATE index_meta SET value = '4' WHERE key = 'schema_version'"
            )
            conn.commit()
        finally:
            conn.close()

        conn = index.get_conn(self.vault)  # triggers the v4 -> v5 migration
        try:
            row = conn.execute(
                "SELECT id, text_hash, legacy_id, access_count FROM memories"
            ).fetchone()
            self.assertIsNotNone(row)
            import hashlib

            want = hashlib.sha256(
                ("note.md" + "\x1f" + "fact one").encode("utf-8")
            ).hexdigest()
            self.assertEqual(row["id"], want)
            self.assertEqual(
                row["text_hash"],
                hashlib.sha256("fact one".encode("utf-8")).hexdigest(),
            )
            self.assertEqual(row["legacy_id"], "legacy-1")
            self.assertEqual(row["access_count"], 7)
            emb = conn.execute(
                "SELECT memory_id FROM embeddings"
            ).fetchone()["memory_id"]
            acc = conn.execute(
                "SELECT memory_id FROM access_log"
            ).fetchone()["memory_id"]
            self.assertEqual(emb, want)
            self.assertEqual(acc, want)
            self.assertEqual(schema._read_version(conn), int(schema.SCHEMA_VERSION))
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
