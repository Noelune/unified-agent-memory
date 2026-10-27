# -*- coding: utf-8 -*-
"""audit — the hash-chained audit log (moved verbatim from index.py, B2).

Every write path appends here: submit, promote, supersede, decide, forget,
repair, digest. ``memory audit --verify`` recomputes the chain; a row edited
after the fact breaks it.
"""
from __future__ import annotations

import hashlib
import sqlite3
import sys
import time
from pathlib import Path

from .schema import get_conn


def audit_entry_hash(
    prev_hash: str | None, at: str, agent: str, action: str, target: str, detail: str
) -> str:
    """Chain hash for one audit row (see record_audit)."""
    return hashlib.sha256(
        "\x1f".join([prev_hash or "", at, agent, action, target, detail]).encode("utf-8")
    ).hexdigest()


def _append_audit_row(
    conn: sqlite3.Connection, agent: str, action: str, target: str, detail: str
) -> None:
    """Insert one audit row inside the CALLER's transaction.

    The chain read and the insert share the caller's transaction so two
    concurrent writers cannot fork the chain. Migration code calls this
    directly (record_audit would re-enter get_conn mid-migration).
    """
    at = time.strftime("%Y-%m-%dT%H:%M:%S")
    prev = conn.execute(
        "SELECT entry_hash FROM audit ORDER BY id DESC LIMIT 1"
    ).fetchone()
    prev_hash = prev["entry_hash"] if prev is not None else None
    conn.execute(
        "INSERT INTO audit (at, agent, action, target, detail, prev_hash, entry_hash) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            at,
            agent,
            action,
            target,
            detail,
            prev_hash,
            audit_entry_hash(prev_hash, at, agent, action, target, detail),
        ),
    )


def record_audit(vault: Path, agent: str, action: str, target: str, detail: str = "") -> None:
    """Append one hash-chained audit row (its own transaction).

    Every write path calls this: submit, promote, supersede, decide, forget,
    repair, digest. ``memory audit --verify`` recomputes the chain; a row
    edited after the fact breaks it. Failures here must never undo the write
    being audited, so errors are swallowed after printing a warning.
    """
    try:
        conn = get_conn(vault)
        try:
            conn.execute("BEGIN IMMEDIATE")
            _append_audit_row(conn, agent, action, target, detail)
            conn.commit()
        finally:
            conn.close()
    except sqlite3.Error as exc:  # noqa: BLE001 — audit must not break writes
        print(f"warning: audit row not written: {exc}", file=sys.stderr)


def audit_rows(vault: Path, limit: int = 0) -> list[dict]:
    """Audit rows, newest first (bounded fetch; filters happen in the caller)."""
    conn = get_conn(vault)
    try:
        if limit and limit > 0:
            cursor = conn.execute(
                "SELECT id, at, agent, action, target, detail, prev_hash, entry_hash "
                "FROM audit ORDER BY id DESC LIMIT ?",
                (int(limit),),
            )
        else:
            cursor = conn.execute(
                "SELECT id, at, agent, action, target, detail, prev_hash, entry_hash "
                "FROM audit ORDER BY id DESC"
            )
        return [dict(r) for r in cursor.fetchall()]
    finally:
        conn.close()


def audit_verify(vault: Path) -> tuple[bool, str]:
    """Recompute the hash chain from the first entry.

    Rows written before the chain existed carry NULL hashes; they are history,
    not tampering, and verification starts strict at the first chained row.
    """
    conn = get_conn(vault)
    try:
        prev: str | None = None
        for row in conn.execute(
            "SELECT id, at, agent, action, target, detail, prev_hash, entry_hash "
            "FROM audit ORDER BY id ASC"
        ).fetchall():
            if row["entry_hash"] is None:
                continue
            want = audit_entry_hash(
                prev, row["at"], row["agent"], row["action"], row["target"], row["detail"]
            )
            if row["prev_hash"] != prev or row["entry_hash"] != want:
                return False, f"entry #{row['id']} does not follow the chain"
            prev = row["entry_hash"]
        return True, ""
    finally:
        conn.close()
