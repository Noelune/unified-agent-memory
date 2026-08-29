# -*- coding: utf-8 -*-
"""schema — SQLite connection + schema lifecycle for the memory database.

Split from index.py (2026-08-29 stabilization pass). index.py re-exports
`index_db_for` / `get_conn` so every existing caller keeps working.

Zero dependencies: Python standard library only.
"""
from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

SCHEMA_VERSION = "4"


def index_db_for(vault: Path) -> Path:
    # Lazy import: memory.INDEX_DB is the single redirectable base path (tests
    # and users point it at a scratch/home location). Reading it here (instead
    # of at module load) keeps this module importable on its own and honors a
    # runtime rebind of memory.INDEX_DB.
    from . import memory  # noqa: F401  (only for memory.INDEX_DB)

    key = hashlib.sha256(str(vault.resolve()).encode("utf-8")).hexdigest()[:16]
    return memory.INDEX_DB.with_name(f"index-{key}.db")


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Create every table (idempotent). docs/fts reuse the legacy layout so the
    existing CLI/tests and the remote index server keep working."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, digest TEXT NOT NULL, title TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(path UNINDEXED, title, content)"
    )
    # Per-line FTS (memory granularity) for hybrid retrieval. Best-effort:
    # when FTS5 is unavailable the per-line BM25 search falls back to a Python
    # substring scan and this table simply never gets populated.
    try:
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS fts_mem USING fts5(memory_id UNINDEXED, line)"
        )
    except sqlite3.Error:
        pass
    conn.execute(
        """CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            doc TEXT NOT NULL,
            line TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'fact',
            importance REAL NOT NULL DEFAULT 0.5,
            status TEXT NOT NULL DEFAULT 'active',
            version INTEGER NOT NULL DEFAULT 1,
            superseded_by TEXT,
            source_agent TEXT NOT NULL DEFAULT '',
            project TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            access_count INTEGER NOT NULL DEFAULT 0,
            metadata_json TEXT NOT NULL DEFAULT '{}'
        )"""
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS embeddings (memory_id TEXT PRIMARY KEY, dim INTEGER NOT NULL, vector BLOB NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS access_log (memory_id TEXT NOT NULL, at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, agent TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS graph_nodes (name TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'concept')"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS graph_edges (src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'related', weight REAL NOT NULL DEFAULT 1.0, PRIMARY KEY (src, dst, kind))"
    )
    # Indexes for common query paths.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mem_doc ON memories(doc)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mem_agent ON memories(source_agent)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mem_status_updated ON memories(status, updated_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_access_mem ON access_log(memory_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_edge_dst ON graph_edges(dst)")


def _migrate_schema(conn: sqlite3.Connection) -> None:
    row = conn.execute("SELECT value FROM index_meta WHERE key = 'schema_version'").fetchone()
    if row is not None and row[0] == SCHEMA_VERSION:
        return
    conn.execute("DELETE FROM docs")
    conn.execute("DELETE FROM fts")
    conn.execute("DELETE FROM fts_mem")
    conn.execute("DELETE FROM memories")
    conn.execute("DELETE FROM embeddings")
    conn.execute("DELETE FROM access_log")
    conn.execute("DELETE FROM graph_nodes")
    conn.execute("DELETE FROM graph_edges")
    conn.execute(
        "INSERT OR REPLACE INTO index_meta (key, value) VALUES ('schema_version', ?)",
        (SCHEMA_VERSION,),
    )


def get_conn(vault: Path) -> sqlite3.Connection:
    """Open (creating/upgrading) the per-vault memory database."""
    db_path = index_db_for(vault)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    _ensure_schema(conn)
    _migrate_schema(conn)
    return conn
