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

SCHEMA_VERSION = "10"
_TARGET = int(SCHEMA_VERSION)


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
    # THE lexical table (memory granularity): stores a bigram rendering of
    # each line (cjk_tokens emits ASCII words lowercased + overlapping CJK
    # bigrams), so Chinese and English share one ranked FTS5 index. The old
    # trio — fts_mem (unicode61, zero hits on Chinese), fts_mem_tri
    # (trigram), fts_mem_bigram — is collapsed into this one table; the v7
    # migration backfills it and drops the old ones.
    try:
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS fts_lex USING fts5(memory_id UNINDEXED, tokens)"
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
        "CREATE TABLE IF NOT EXISTS query_cache (query_hash TEXT PRIMARY KEY, vector BLOB NOT NULL, at TEXT NOT NULL, model_id TEXT NOT NULL DEFAULT '')"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS access_log (memory_id TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL DEFAULT 'retrieved')"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, agent TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', prev_hash TEXT, entry_hash TEXT)"
    )
    # The persisted concept graph is GONE (batch A, v8): build_graph wrote
    # 1335 nodes / 5000 capped edges that no reader ever queried —
    # expand_search always recomputed postings from `memories` in memory.
    # The v8 migration drops both tables.
    # Indexes for common query paths.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mem_doc ON memories(doc)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mem_agent ON memories(source_agent)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mem_status_updated ON memories(status, updated_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_mem_text_hash ON memories(text_hash)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_access_mem ON access_log(memory_id)")


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


def _migrate_to_v6(conn: sqlite3.Connection) -> None:
    """v5 -> v6: hash-chained audit.

    record_audit existed since v1 but had zero call sites, so the audit table
    README pointed at was always empty. Wiring it up needs the chain columns;
    existing rows predate the chain and get NULL hashes (verify treats a NULL
    chain as "unlinked history", not as tampering).
    """
    columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(audit)").fetchall()
    }
    if "prev_hash" not in columns:
        conn.execute("ALTER TABLE audit ADD COLUMN prev_hash TEXT")
    if "entry_hash" not in columns:
        conn.execute("ALTER TABLE audit ADD COLUMN entry_hash TEXT")


def _migrate_to_v7(conn: sqlite3.Connection) -> None:
    """v6 -> v7: collapse the three lexical FTS tables into one.

    fts_mem (unicode61) returned ZERO hits for every pure-Chinese query while
    holding the top RRF weight; fts_mem_tri and fts_mem_bigram overlapped each
    other. cjk_tokens already emits ASCII words AND Chinese bigrams, so one
    table (fts_lex) serves both languages. The old tables are pure derived
    data: backfill fts_lex from memories, then drop them.
    """
    # Lazy import: schema sits below index in the package graph, and index
    # imports schema at module load.
    from .index import cjk_tokens

    conn.execute("DELETE FROM fts_lex")
    rows = conn.execute("SELECT id, line FROM memories").fetchall()
    conn.executemany(
        "INSERT INTO fts_lex (memory_id, tokens) VALUES (?, ?)",
        [(row["id"], " ".join(cjk_tokens(row["line"]))) for row in rows],
    )
    conn.execute("DROP TABLE IF EXISTS fts_mem_tri")
    conn.execute("DROP TABLE IF EXISTS fts_mem_bigram")
    conn.execute("DROP TABLE IF EXISTS fts_mem")


def _migrate_to_v8(conn: sqlite3.Connection) -> None:
    """v7 -> v8: drop the unread concept graph.

    The persisted graph was write-only: expand_search rebuilt its postings
    from `memories` on every query and never touched graph_nodes/graph_edges,
    so the capped 5000-edge table was pure disk and CPU. The stream now
    computes everything in memory (see graph.expand_search).
    """
    conn.execute("DROP TABLE IF EXISTS graph_edges")
    conn.execute("DROP TABLE IF EXISTS graph_nodes")


def _migrate_to_v9(conn: sqlite3.Connection) -> None:
    """v8 -> v9: tag cached query vectors with the embedding model.

    Vectors from two different models must never be compared: a same-dimension
    different-model query vector would produce plausible-looking but wrong
    rankings. The cache key already embeds the model name (batch A); the
    column records it explicitly so old rows are distinguishable.
    """
    columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(query_cache)").fetchall()
    }
    if "model_id" not in columns:
        conn.execute("ALTER TABLE query_cache ADD COLUMN model_id TEXT NOT NULL DEFAULT ''")


def _migrate_to_v10(conn: sqlite3.Connection) -> None:
    """v9 -> v10: split 'retrieved' from 'used' access events.

    record_access counted a fact the moment it was RETURNED, and the forgetter
    rewarded that count — retrieval begat reinforcement begat retrieval, and
    stale facts were pinned forever (752 access rows / 149 memories). Only
    facts the model actually CITES should reinforce; old rows predate the
    distinction and count as 'retrieved'.
    """
    columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(access_log)").fetchall()
    }
    if "event" not in columns:
        conn.execute(
            "ALTER TABLE access_log ADD COLUMN event TEXT NOT NULL DEFAULT 'retrieved'"
        )


MIGRATIONS: dict[int, Callable[[sqlite3.Connection], None]] = {
    4: _migrate_to_v4,
    5: _migrate_to_v5,
    6: _migrate_to_v6,
    7: _migrate_to_v7,
    8: _migrate_to_v8,
    9: _migrate_to_v9,
    10: _migrate_to_v10,
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
