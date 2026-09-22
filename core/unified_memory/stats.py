# -*- coding: utf-8 -*-
"""stats — read-only aggregates that feed the visualization console.

Every query here is a SELECT. Nothing in this module writes. The browser half
cannot run SQL (it may only import react), so all aggregation happens here and
travels over one read-only route.

Date keys are the first 10 characters of the stored ISO-8601 timestamps, which
every writer in this codebase emits as local time with a 'T' separator.
"""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

from . import index as index_mod
from .common import redact


def _day(value: str | None) -> str:
    return (value or "")[:10]


def _span(days: list[str]) -> list[str]:
    """Every date from min to max inclusive. Empty input -> empty output."""
    if not days:
        return []
    lo, hi = min(days), max(days)
    start = date.fromisoformat(lo)
    end = date.fromisoformat(hi)
    out, cur = [], start
    while cur <= end:
        out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


def daily_counts(vault: Path) -> list[dict]:
    """Memories created per day, zero-filled across the full span."""
    conn = index_mod.get_conn(vault)
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
    return [{"date": d, "count": seen.get(d, 0)} for d in _span(list(seen))]


def type_counts(vault: Path) -> list[dict]:
    """Active memories per type, most common first."""
    conn = index_mod.get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT type, COUNT(*) AS n FROM memories WHERE status = 'active'"
            " GROUP BY type ORDER BY n DESC, type ASC"
        ).fetchall()
    finally:
        conn.close()
    return [{"type": r["type"], "count": r["n"]} for r in rows]


def importance_counts(vault: Path) -> list[dict]:
    """Active memories per importance band, highest band first."""
    conn = index_mod.get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT importance, COUNT(*) AS n FROM memories WHERE status = 'active'"
            " GROUP BY importance ORDER BY importance DESC"
        ).fetchall()
    finally:
        conn.close()
    return [{"value": float(r["importance"]), "count": r["n"]} for r in rows]


def top_accessed(vault: Path, limit: int = 20) -> list[dict]:
    """The most-recalled memories. Rows nobody ever recalled are excluded.

    ``label`` is vault content and is redacted; the record carries
    untrusted=True so consumers never treat it as instructions.
    """
    conn = index_mod.get_conn(vault)
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
        {"id": r["id"], "label": redact(r["line"] or ""),
         "count": r["access_count"], "untrusted": True}
        for r in rows
    ]


def access_counts(vault: Path) -> list[dict]:
    """Recall events per day, zero-filled across the full span."""
    conn = index_mod.get_conn(vault)
    try:
        rows = conn.execute("SELECT at FROM access_log").fetchall()
    finally:
        conn.close()
    seen: dict[str, int] = {}
    for r in rows:
        d = _day(r["at"])
        if d:
            seen[d] = seen.get(d, 0) + 1
    return [{"date": d, "count": seen.get(d, 0)} for d in _span(list(seen))]
