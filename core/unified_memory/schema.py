# -*- coding: utf-8 -*-
"""schema — SQLite connection + schema lifecycle for the memory database.

Split from index.py (2026-08-29 stabilization pass). index.py re-exports
`index_db_for` / `get_conn` so every existing caller keeps working.

Zero dependencies: Python standard library only.
"""
from __future__ import annotations

import hashlib
import shutil
import sqlite3
from collections.abc import Callable
from pathlib import Path

SCHEMA_VERSION = "5"
_TARGET = int(SCHEMA_VERSION)


def index_db_for(vault: Path) -> Path:
    # Lazy import: memory.INDEX_DB is the single redirectable base path (tests
    # and users point it at a scratch/home location). Reading it here (instead
    # of at module load) keeps this module importable on its own and honors a
    # runtime rebind of memory.INDEX_DB.
    from . import memory  # noqa: F401  (only for memory.INDEX_DB)

    key = hashlib.sha256(str(vault.resolve()).encode("utf-8")).hexdigest()[:16]
    return memory.INDEX_DB.with_name(f"index-{key}.db")


def probe_trigram(conn: sqlite3.Connection) -> bool:
    """Return True when this SQLite build has the trigram FTS5 tokenizer.

    Probed on a throwaway in-memory table so a failure never touches the real
    index. Older builds raise ``no such tokenizer: trigram``; we turn that into
    a plain False so callers can degrade instead of crashing.
    """
    try:
        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS _trigram_probe USING fts5(x, tokenize='trigram')")
        conn.execute("DROP TABLE IF EXISTS _trigram_probe")
        return True
    except sqlite3.Error:
        return False


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
    # Trigram FTS (CJK substring recall). Best-effort: when the tokenizer is
    # unavailable the table is simply never created and trigram_memory_search
    # returns an empty stream. NOTE: existing fts/fts_mem tables carry no
    # tokenizer clause (FTS5 default); this is a NEW table so we can pin the
    # tokenizer at CREATE time without rebuilding anything.
    if probe_trigram(conn):
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS fts_mem_tri USING fts5(memory_id UNINDEXED, line, tokenize='trigram')"
        )
    # CJK bigram FTS: the default unicode61 tokenizer treats a whole Chinese
    # run as one token, so BM25 misses 记忆/路径/环境-style queries entirely.
    # This table stores an overlapping-bigram rendering of each line (ASCII
    # words lowercased), which gives Chinese the same ranked lexical recall
    # English already had. Best-effort like fts_mem_tri: absent table = the
    # stream simply contributes nothing.
    try:
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS fts_mem_bigram USING fts5(memory_id UNINDEXED, tokens)"
        )
    except sqlite3.Error:
        pass
    conn.execute(
        """CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            doc TEXT NOT NULL,
            line TEXT NOT NULL,
            text_hash TEXT NOT NULL DEFAULT '',
            type TEXT NOT NULL DEFAULT 'fact',
            importance REAL NOT NULL DEFAULT 0.5,
            status TEXT NOT NULL DEFAULT 'active',
            version INTEGER NOT NULL DEFAULT 1,
            superseded_by TEXT,
            legacy_id TEXT,
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
    # Query-vector cache: agent turns often repeat the same topic query. A
    # provider round-trip is ~300 ms, so caching the query embedding locally
    # cuts hybrid-search latency roughly in half without affecting recall.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS query_cache (query_hash TEXT PRIMARY KEY, vector BLOB NOT NULL, at TEXT NOT NULL)"
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
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mem_text_hash ON memories(text_hash)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_access_mem ON access_log(memory_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_edge_dst ON graph_edges(dst)")


def _read_version(conn: sqlite3.Connection) -> int:
    """Current schema version from index_meta; 0 means "fresh file".

    Version lives in index_meta (a plain key/value row) rather than
    ``PRAGMA user_version``: the pragma cannot take a bound parameter and this
    codebase's scanner red-lines SQL assembled from values. A constant-string
    PRAGMA read stays as a fallback for foreign databases carrying only
    user_version.
    """
    try:
        row = conn.execute(
            "SELECT value FROM index_meta WHERE key = 'schema_version'"
        ).fetchone()
        if row is not None and str(row[0]).strip():
            return int(str(row[0]).strip())
    except (sqlite3.Error, ValueError):
        pass
    try:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])
    except (sqlite3.Error, ValueError):
        return 0


def _write_version(conn: sqlite3.Connection, version: int) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO index_meta (key, value) VALUES ('schema_version', ?)",
        (str(version),),
    )


def _backup_db_file(db_path: Path, old_version: int) -> Path:
    """Snapshot the database file before migrating (best effort, never fatal).

    WAL is checkpointed first so the main file is self-consistent when copied.
    A failed backup does not block the migration: the transactional rollback
    is the real safety net, this file is the second one.
    """
    backup = db_path.with_name(f"{db_path.stem}.v{old_version}.bak")
    try:
        probe = sqlite3.connect(str(db_path))
        try:
            probe.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            probe.close()
        shutil.copy2(db_path, backup)
    except OSError:
        pass
    return backup


def _migrate_to_v4(conn: sqlite3.Connection) -> None:
    """v1-v3 -> v4: nothing to transform.

    _ensure_schema has already created any missing object idempotently, and
    the per-line FTS mirrors are refilled from `memories` by the count-drift
    backfills in index.update_index. Historical upgrades therefore keep every
    learning row; only derived tables are rebuilt.
    """


def _migrate_to_v5(conn: sqlite3.Connection) -> None:
    """v4 -> v5: occurrence identity.

    The old primary key was sha256(line text), so the same sentence promoted
    into two notes collapsed into one row that kept only the last writer's
    doc — provenance silently lost, and deleting that one note made the fact
    (still present in the other note) unsearchable. ids become
    sha256(doc + "\\x1f" + line); the old value is preserved in legacy_id and
    every table keyed by memory_id is remapped in the same transaction.
    """
    columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(memories)").fetchall()
    }
    if "text_hash" not in columns:
        conn.execute("ALTER TABLE memories ADD COLUMN text_hash TEXT NOT NULL DEFAULT ''")
    if "legacy_id" not in columns:
        conn.execute("ALTER TABLE memories ADD COLUMN legacy_id TEXT")

    # Collapse legacy (doc, line) duplicates before remapping, or two rows
    # would race for the same new primary key and abort the upgrade. The
    # most-used occurrence wins; the rest are duplicates by definition.
    kept: dict[tuple[str, str], str] = {}
    rows = conn.execute(
        "SELECT rowid AS rid, id, doc, line, access_count FROM memories "
        "ORDER BY access_count DESC, rowid ASC"
    ).fetchall()
    for row in rows:
        key = (row["doc"], row["line"])
        if key in kept:
            conn.execute("DELETE FROM memories WHERE rowid = ?", (row["rid"],))
            continue
        kept[key] = row["id"]

    remap: dict[str, str] = {}
    for (doc, line), old_id in kept.items():
        new_id = hashlib.sha256((doc + "\x1f" + line).encode("utf-8")).hexdigest()
        text_hash = hashlib.sha256(line.encode("utf-8")).hexdigest()
        conn.execute(
            "UPDATE memories SET id = ?, text_hash = ?, legacy_id = ? WHERE id = ?",
            (new_id, text_hash, old_id, old_id),
        )
        remap[old_id] = new_id
    # Remap the two memory_id-keyed tables. Two literal statements rather than
    # a loop over table names: dynamic SQL is red-lined, and the tables have
    # different row shapes anyway.
    for row in conn.execute(
        "SELECT rowid AS rid, memory_id AS mid FROM access_log"
    ).fetchall():
        new_id = remap.get(row["mid"])
        if new_id is not None and new_id != row["mid"]:
            conn.execute(
                "UPDATE access_log SET memory_id = ? WHERE rowid = ?",
                (new_id, row["rid"]),
            )
    for row in conn.execute(
        "SELECT rowid AS rid, memory_id AS mid FROM embeddings"
    ).fetchall():
        new_id = remap.get(row["mid"])
        if new_id is not None and new_id != row["mid"]:
            conn.execute(
                "UPDATE embeddings SET memory_id = ? WHERE rowid = ?",
                (new_id, row["rid"]),
            )


MIGRATIONS: dict[int, Callable[[sqlite3.Connection], None]] = {
    4: _migrate_to_v4,
    5: _migrate_to_v5,
}


def _migrate_schema(conn: sqlite3.Connection, db_path: Path) -> None:
    """Bring an older database up to SCHEMA_VERSION without losing learning data.

    The previous implementation answered "version mismatch" with
    ``DELETE FROM memories/embeddings/access_log/...``, which wiped every
    upgrade: reinforcement counts, paid-for vectors and read history all went
    to zero. Migrations only ever ADD objects or backfill derived tables; the
    memories/embeddings/access_log rows are untouchable. Everything runs in
    one transaction, so a step that raises rolls the database back to its
    pre-migration state; a file-level ``.v<old>.bak`` copy is kept as well.

    A downgrade (newer file, older code) is left completely alone: touching it
    could only destroy data the newer schema owns.
    """
    old = _read_version(conn)
    if old >= _TARGET:
        return
    if old > 0:
        _backup_db_file(db_path, old)
    conn.execute("BEGIN IMMEDIATE")
    try:
        for version in range(old + 1, _TARGET + 1):
            step = MIGRATIONS.get(version)
            if step is not None:
                step(conn)
        _write_version(conn, _TARGET)
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def get_conn(vault: Path) -> sqlite3.Connection:
    """Open (creating/upgrading) the per-vault memory database.

    WAL + a busy timeout matter here because searches and the DSH console can
    read while the daily promoter writes. The default rollback journal made a
    concurrent reader fail with "database is locked" instead of waiting; the
    pragmas are best-effort so exotic filesystems (network mounts without WAL
    support) still open in the old mode.
    """
    db_path = index_db_for(vault)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=5.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
    except sqlite3.Error:
        pass
    _ensure_schema(conn)
    _migrate_schema(conn, db_path)
    return conn
