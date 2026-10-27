# -*- coding: utf-8 -*-
"""maintain — diagnostics + reversible derived-data pruning (B2).

The storage half of health.py's doctor/gc: index counters, orphan index
databases, retention pruning and VACUUM. Nothing here touches canonical
notes; every statement is a literal inline at its call site.
"""
from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path

from .schema import get_conn, index_db_for


def index_counts(vault: Path) -> dict:
    """The doctor's index counters (one connection, all read-only)."""
    conn = get_conn(vault)
    try:
        return {
            "journalMode": conn.execute("PRAGMA journal_mode").fetchone()[0],
            "docs": conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0],
            "memories": conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0],
            "active": conn.execute("SELECT COUNT(*) FROM memories WHERE status = 'active'").fetchone()[0],
            "superseded": conn.execute("SELECT COUNT(*) FROM memories WHERE status = 'superseded'").fetchone()[0],
            "vectors": conn.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0],
            "accesses": conn.execute("SELECT COUNT(*) FROM access_log").fetchone()[0],
        }
    finally:
        conn.close()


def _days_ago(timestamp: float, now: float | None = None) -> float:
    return max(0.0, ((now or time.time()) - timestamp) / 86400)


def orphan_index_report(vault: Path) -> list[dict]:
    """Index DBs under the index dir whose source vault no longer exists.

    A DB is orphaned when it has no docs rows, or when none of the vault paths
    it indexed still exist. The current vault's DB is always excluded, so a
    healthy install reports zero. (Moved verbatim from health._orphan_indexes.)
    """
    current = index_db_for(vault).resolve()
    root = current.parent
    found: list[dict] = []
    for db in sorted(root.glob("index-*.db")):
        try:
            if db.resolve() == current:
                continue
        except OSError:
            continue
        try:
            conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
            try:
                rows = conn.execute("SELECT path FROM docs").fetchall()
            finally:
                conn.close()
        except sqlite3.Error:
            continue
        if not rows:
            orphaned = True
        else:
            orphaned = not any(Path(str(row[0])).exists() for row in rows)
        if not orphaned:
            continue
        try:
            size = db.stat().st_size
        except OSError:
            size = 0
        found.append({"path": str(db), "bytes": size, "ageDays": round(_days_ago(db.stat().st_mtime), 1)})
    return found


def prune_access_log(vault: Path, retention_days: int, apply: bool) -> int:
    """Count (and with ``apply``, delete) access rows past the retention window.

    Returns the count either way — the gc report shows what a dry run WOULD
    prune, exactly as before.
    """
    conn = get_conn(vault)
    try:
        cutoff_text = (datetime.now() - timedelta(days=retention_days)).strftime("%Y-%m-%d")
        count = conn.execute(
            "SELECT COUNT(*) FROM access_log WHERE at < ?", (cutoff_text,)
        ).fetchone()[0]
        if apply:
            conn.execute("DELETE FROM access_log WHERE at < ?", (cutoff_text,))
            conn.commit()
        return count
    finally:
        conn.close()


def prune_query_cache(vault: Path, retention_days: int, apply: bool) -> int:
    conn = get_conn(vault)
    try:
        cutoff_text = (datetime.now() - timedelta(days=retention_days)).strftime("%Y-%m-%d")
        count = conn.execute(
            "SELECT COUNT(*) FROM query_cache WHERE at < ?", (cutoff_text,)
        ).fetchone()[0]
        if apply:
            conn.execute("DELETE FROM query_cache WHERE at < ?", (cutoff_text,))
            conn.commit()
        return count
    finally:
        conn.close()


def vacuum_index(vault: Path) -> bool:
    """Checkpoint WAL + VACUUM the current vault's index (gc --apply)."""
    conn = get_conn(vault)
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.commit()
        conn.execute("VACUUM")
        return True
    finally:
        conn.close()
