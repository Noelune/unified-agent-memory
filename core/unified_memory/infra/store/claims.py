# -*- coding: utf-8 -*-
"""claims — memory-row use cases: access tracking, vectors, caches, aggregates.

Moved verbatim from index.py / stats.py / embed.py / preview.py / forgetter.py
(B2): every function here owns its statements (inlined literals) and its own
connection, and returns the exact dict/row shapes those modules returned, so
the callers above the store change nothing but the import.
"""
from __future__ import annotations

import re
import time
from pathlib import Path

from .schema import get_conn


# --------------------------------------------------------------------------
# Access tracking (reinforcement for forgetting)
# --------------------------------------------------------------------------


def record_access(vault: Path, memory_ids: list[str], event: str = "retrieved") -> None:
    """Record one access event per memory.

    Two events exist (batch A): ``retrieved`` — the fact was returned by a
    search, which is NOT a signal of usefulness — and ``used`` — the model
    actually cited it in a later turn. Only ``used`` feeds the forgetter's
    reinforcement; rewarding retrieval alone pinned stale facts forever
    (752 access rows / 149 memories, every one counting as praise).
    """
    conn = get_conn(vault)
    try:
        now = time.strftime("%Y-%m-%dT%H:%M:%S")
        for mid in memory_ids:
            conn.execute("UPDATE memories SET access_count = access_count + 1, updated_at = ? WHERE id = ?", (now, mid))
            conn.execute(
                "INSERT INTO access_log (memory_id, at, event) VALUES (?, ?, ?)",
                (mid, now, event),
            )
        conn.commit()
    finally:
        conn.close()


def used_count(vault: Path, memory_id: str) -> int:
    """How many ``used`` events a memory has (reinforcement signal)."""
    conn = get_conn(vault)
    try:
        return conn.execute(
            "SELECT COUNT(*) AS c FROM access_log WHERE memory_id = ? AND event = 'used'",
            (memory_id,),
        ).fetchone()["c"]
    finally:
        conn.close()


def resolve_short_ids(vault: Path, shorts: list[str]) -> list[str]:
    """Expand 10-char display prefixes (see the hybrid renderer) to full ids."""
    if not shorts:
        return []
    conn = get_conn(vault)
    try:
        found: list[str] = []
        for short in shorts:
            if not re.fullmatch(r"[0-9a-f]{6,64}", short):
                continue
            row = conn.execute(
                "SELECT id FROM memories WHERE id LIKE ? LIMIT 1",
                (short + "%",),
            ).fetchone()
            if row is not None:
                found.append(row["id"])
        return found
    finally:
        conn.close()


def record_used_events(vault: Path, shorts: list[str]) -> int:
    """Mark the cited short ids as ``used``; returns how many matched."""
    full = resolve_short_ids(vault, shorts)
    if full:
        record_access(vault, full, event="used")
    return len(full)


def active_memories(vault: Path) -> list[dict]:
    """All active memory records (dicts) — used by graph/forgetter."""
    conn = get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT id, doc, line, type, importance, status, version, superseded_by, "
            "source_agent, project, created_at, updated_at, access_count "
            "FROM memories WHERE status = 'active' ORDER BY doc"
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def memory_count(vault: Path) -> int:
    conn = get_conn(vault)
    try:
        return conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Retrieval assembly
# --------------------------------------------------------------------------


def records_for_ids(vault: Path, ids: list[str]) -> list[dict]:
    """Full records for the selected memory ids (search's fusion assembler)."""
    if not ids:
        return []
    conn = get_conn(vault)
    try:
        placeholders = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT id, doc, line, type, importance, source_agent FROM memories "
            f"WHERE id IN ({placeholders})",
            ids,
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def forgetting_candidates(vault: Path, limit: int) -> list[dict]:
    """Rows for the preview 'forgetting' view (lowest reinforcement first)."""
    conn = get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT id, doc, line, type, importance, access_count FROM memories "
            "WHERE status = 'active' ORDER BY access_count ASC, importance ASC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:  # noqa: BLE001
        return []
    finally:
        conn.close()


def forget_stats(vault: Path, doc: str, bare: str) -> tuple[float, int, str] | None:
    """(importance, used_count, last_access_at) for one memory line.

    ``access_count`` counts every retrieval, and retrieval is NOT usage: the
    batch-A audit found 752 access rows rewarding facts merely for coming
    back, pinning stale ones forever. Reinforcement now reads the ``used``
    events only — facts the model actually cited in a later turn.
    ``updated_at`` is unusable as a "last used" signal: indexing and embedding
    also touch it. The access_log timestamp is the actual read receipt.

    (Moved verbatim from forgetter._index_stats, B2.)
    """
    conn = get_conn(vault)
    try:
        row = conn.execute(
            "SELECT m.importance, "
            "(SELECT COUNT(*) FROM access_log a WHERE a.memory_id = m.id AND a.event = 'used') AS used, "
            "(SELECT MAX(a.at) FROM access_log a WHERE a.memory_id = m.id) AS last_access "
            "FROM memories m WHERE m.doc = ? AND m.line = ? LIMIT 1",
            (doc, bare),
        ).fetchone()
        if row is None:
            row = conn.execute(
                "SELECT m.importance, "
                "(SELECT COUNT(*) FROM access_log a WHERE a.memory_id = m.id AND a.event = 'used') AS used, "
                "(SELECT MAX(a.at) FROM access_log a WHERE a.memory_id = m.id) AS last_access "
                "FROM memories m WHERE m.line = ? LIMIT 1",
                (bare,),
            ).fetchone()
        if row is None:
            return None
        return float(row["importance"]), int(row["used"]), str(row["last_access"] or "")
    except Exception:  # noqa: BLE001 — never let the index break forgetting
        return None
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Vectors + query cache (embed.py's storage half)
# --------------------------------------------------------------------------


def pending_vector_rows(vault: Path, limit: int) -> list[dict]:
    """Memory lines that still lack a vector (embed_missing's work list)."""
    conn = get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT id, line FROM memories WHERE id NOT IN (SELECT memory_id FROM embeddings) LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def save_vectors(vault: Path, items: list[tuple[str, bytes]]) -> None:
    """Store one (memory_id, float32-blob) vector per item and stamp the row."""
    conn = get_conn(vault)
    try:
        now = time.strftime("%Y-%m-%dT%H:%M:%S")
        for memory_id, blob in items:
            conn.execute(
                "INSERT OR REPLACE INTO embeddings (memory_id, dim, vector) VALUES (?, ?, ?)",
                (memory_id, len(blob) // 4, blob),
            )
            conn.execute("UPDATE memories SET updated_at = ? WHERE id = ?", (now, memory_id))
        conn.commit()
    finally:
        conn.close()


def vector_count(vault: Path) -> int:
    conn = get_conn(vault)
    try:
        return conn.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0]
    finally:
        conn.close()


def vector_search_rows(vault: Path) -> list[dict]:
    """id/doc/line/type/importance + vector blob for every active memory
    (the cosine scan happens in embed, in Python, exactly as before)."""
    conn = get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT m.id, m.doc, m.line, m.type, m.importance, e.vector "
            "FROM memories m JOIN embeddings e ON e.memory_id = m.id "
            "WHERE m.status = 'active'"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def query_cache_get(vault: Path, key: str) -> tuple[bytes, str] | None:
    """(vector_blob, at) for a cached query vector, or None."""
    conn = get_conn(vault)
    try:
        row = conn.execute(
            "SELECT vector, at FROM query_cache WHERE query_hash = ?", (key,)
        ).fetchone()
        if row is None:
            return None
        return bytes(row["vector"]), str(row["at"])
    finally:
        conn.close()


def query_cache_put(vault: Path, key: str, vector: bytes, model_id: str) -> None:
    conn = get_conn(vault)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO query_cache (query_hash, vector, at, model_id) VALUES (?, ?, ?, ?)",
            (key, vector, time.strftime("%Y-%m-%dT%H:%M:%S"), model_id),
        )
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------
# index_meta (cursors, versions) — digest + health read/write these
# --------------------------------------------------------------------------


def get_meta(vault: Path, key: str) -> str:
    conn = get_conn(vault)
    try:
        row = conn.execute(
            "SELECT value FROM index_meta WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row else ""
    finally:
        conn.close()


def set_meta(vault: Path, key: str, value: str) -> None:
    conn = get_conn(vault)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)",
            (key, value),
        )
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Read-only aggregates (stats.py's storage half; every query is a SELECT)
# --------------------------------------------------------------------------


def _day(value: str | None) -> str:
    return (value or "")[:10]


def stats_daily_created(vault: Path) -> dict[str, int]:
    """created_at day -> count for active memories (caller zero-fills)."""
    conn = get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT created_at FROM memories WHERE status = 'active'"
        ).fetchall()
    finally:
        conn.close()
    seen: dict[str, int] = {}
    for r in rows:
        d = _day(r["created_at"])
        if d:
            seen[d] = seen.get(d, 0) + 1
    return seen


def stats_access_per_day(vault: Path) -> dict[str, int]:
    """access_log day -> count (caller zero-fills)."""
    conn = get_conn(vault)
    try:
        rows = conn.execute("SELECT at FROM access_log").fetchall()
    finally:
        conn.close()
    seen: dict[str, int] = {}
    for r in rows:
        d = _day(r["at"])
        if d:
            seen[d] = seen.get(d, 0) + 1
    return seen


def stats_type_counts(vault: Path) -> list[dict]:
    conn = get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT type, COUNT(*) AS n FROM memories WHERE status = 'active'"
            " GROUP BY type ORDER BY n DESC, type ASC"
        ).fetchall()
    finally:
        conn.close()
    return [{"type": r["type"], "count": r["n"]} for r in rows]


def stats_importance_counts(vault: Path) -> list[dict]:
    conn = get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT importance, COUNT(*) AS n FROM memories WHERE status = 'active'"
            " GROUP BY importance ORDER BY importance DESC"
        ).fetchall()
    finally:
        conn.close()
    return [{"value": float(r["importance"]), "count": r["n"]} for r in rows]


def stats_top_accessed(vault: Path, limit: int) -> list[dict]:
    conn = get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT id, line, access_count FROM memories"
            " WHERE status = 'active' AND access_count > 0"
            " ORDER BY access_count DESC, id ASC LIMIT ?",
            (int(limit),),
        ).fetchall()
    finally:
        conn.close()
    return [
        {"id": r["id"], "line": r["line"] or "", "access_count": r["access_count"]}
        for r in rows
    ]


def stats_scalar(vault: Path, sql: str) -> int:
    """One-column count of a module-owned literal SELECT.

    No exception is swallowed. The previous ``except Exception: return 0``
    turned a broken index (missing table, corrupt file, locked db) into a
    plausible "0 vectors", which a user cannot tell apart from a genuinely
    empty table — a hidden error, not a graceful fallback. The SQL here is a
    module-owned literal, so any failure is a real defect and must surface.
    """
    conn = get_conn(vault)
    try:
        row = conn.execute(sql).fetchone()
    finally:
        conn.close()
    return int(row["n"]) if row else 0
