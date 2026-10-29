# -*- coding: utf-8 -*-
"""infra.store.stats_queries — read-only aggregates (stats.py's storage half).

Split from claims.py in B5.5c (claims.py was 24 top-level defs over the 20
budget). Every query is a SELECT; every statement is a literal inline at its
call site (the project's scanner red-lines SQL constants assigned to names).
"""
from __future__ import annotations

from pathlib import Path

from .schema import get_conn


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