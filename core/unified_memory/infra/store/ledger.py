# -*- coding: utf-8 -*-
"""infra.store.ledger — the Claim Ledger projection's only SQL surface (batch D).

The vault files are the source of truth: every fact line carries its identity
as an Obsidian block ID (`` ^c-<16hex>``). These four tables are a queryable
projection — ``refresh_ledger`` re-derives them idempotently from the vault the
same way ``update_index`` re-derives ``memories``. Lifecycle fields
(valid_to/status from a supersession, links, events) are owned by the write
paths; a refresh never overwrites them (INSERT OR IGNORE keeps the first
lifecycle record, text/type updates ride along because 改文字不改 ID).

SQL is a literal at every call site (the project's scanner red-line).
"""
from __future__ import annotations

import hashlib
import time
import uuid
from pathlib import Path

from ...domain.facts import history_start
from ...domain.markdown import BLOCK_ID_RE, bare_fact_line, claim_id_of, parse_stamp
from ...domain.policy import classify_type
from ..vault import indexed_files, read_maybe
from .schema import get_conn


def new_claim_id() -> str:
    """A fresh 16-hex claim id (generated once per fact, never regenerated)."""
    return uuid.uuid4().hex[:16]


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def _written_date(line: str) -> str:
    written, _source, _valid_until = parse_stamp(line)
    return written or ""


def refresh_doc(conn, vault: Path, path: Path) -> int:
    """Re-derive one note's occurrences (and any new claims) from its text.

    Idempotent: occurrences for the doc are rebuilt; claims are inserted with
    OR IGNORE (lifecycle fields survive) and their text/type updated in place
    (改文字不改 ID). Returns the number of fact lines seen.
    """
    text = read_maybe(path)
    doc = path.name
    conn.execute("DELETE FROM occurrences WHERE doc = ?", (doc,))
    if not text:
        _delete_orphan_claims(conn)
        return 0
    lines = text.splitlines()
    hs = history_start(lines)
    seen = 0
    for lineno, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line.lstrip().startswith("-"):
            continue
        bare = bare_fact_line(line)
        if not bare:
            continue
        claim_id = claim_id_of(line)
        if not claim_id:
            continue  # not backfilled yet; backfill-ids assigns one
        seen += 1
        written = _written_date(line)
        status = "active" if lineno <= hs else "superseded"
        conn.execute(
            "INSERT OR REPLACE INTO occurrences (claim_id, doc, line, quote_hash, written_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (claim_id, doc, lineno, hashlib.sha256(bare.encode("utf-8")).hexdigest()[:16], written),
        )
        conn.execute(
            "INSERT OR IGNORE INTO claims (id, text, type, status, scope, valid_from, valid_to, recorded_at)"
            " VALUES (?, ?, ?, ?, 'default', ?, NULL, ?)",
            (claim_id, bare, classify_type(bare), status, written, _now()),
        )
        conn.execute(
            "UPDATE claims SET text = ?, type = ? WHERE id = ? AND (text != ? OR type != ?)",
            (bare, classify_type(bare), claim_id, bare, classify_type(bare)),
        )
    _delete_orphan_claims(conn)
    return seen


def _delete_orphan_claims(conn) -> None:
    """Claims with no occurrence and no link are gone for good (the vault no
    longer carries their id anywhere)."""
    conn.execute(
        "DELETE FROM claims WHERE id NOT IN (SELECT DISTINCT claim_id FROM occurrences)"
        " AND id NOT IN (SELECT src FROM links) AND id NOT IN (SELECT dst FROM links)"
    )


def refresh_ledger(vault: Path) -> dict:
    """Re-derive the whole projection from the vault. Idempotent."""
    conn = get_conn(vault)
    try:
        total = 0
        docs = []
        for path in indexed_files(vault):
            total += refresh_doc(conn, vault, path)
            docs.append(path.name)
        # Occurrences whose doc vanished from the vault (and claims that left
        # with them — identity rule 3). No docs at all clears every occurrence.
        if docs:
            placeholders = ",".join("?" for _ in docs)
            conn.execute(
                f"DELETE FROM occurrences WHERE doc NOT IN ({placeholders})",
                docs,
            )
        else:
            conn.execute("DELETE FROM occurrences")
        _delete_orphan_claims(conn)
        conn.commit()
        return {"docs": len(docs), "fact_lines": total}
    finally:
        conn.close()


def record_supersedence(
    conn,
    old_claim_id: str,
    new_claim_id: str,
    *,
    actor: str,
    decided_at: str,
) -> bool:
    """Close the old claim's validity window and link it to its successor.

    Returns False when the old id is unknown (e.g. a fact that predates the
    ledger) — the link is still recorded so the relationship is not lost.
    """
    if not old_claim_id:
        return False
    conn.execute(
        "UPDATE claims SET status = 'superseded', valid_to = ? WHERE id = ?",
        (decided_at[:10], old_claim_id),
    )
    conn.execute(
        "INSERT OR IGNORE INTO links (src, dst, kind, decided_by, decided_at)"
        " VALUES (?, ?, 'supersedes', ?, ?)",
        (old_claim_id, new_claim_id, actor, decided_at),
    )
    conn.execute(
        "INSERT INTO events (at, actor, op, target, before_hash, after_hash, prev_hash)"
        " VALUES (?, ?, 'supersede', ?, NULL, ?, NULL)",
        (decided_at, actor, old_claim_id, new_claim_id),
    )
    return True


def claim_id_for_text(conn, text: str) -> str:
    """The current claim id carrying exactly this bare text ('' when none)."""
    row = conn.execute("SELECT id FROM claims WHERE text = ? LIMIT 1", (text,)).fetchone()
    return row["id"] if row else ""


def claims_valid_at(conn, date: str) -> list[dict]:
    """Claims believed true at ``date`` (YYYY-MM-DD).

    Active claims count from their valid_from on; superseded claims count
    only inside a RECORDED validity window (valid_to set by the write path).
    Pre-ledger history has no reliable window, so it is excluded — as-of
    precision starts with the batch-D wiring (documented limitation).
    """
    rows = conn.execute(
        "SELECT id, text, type, status, valid_from, valid_to FROM claims"
        " WHERE valid_from IS NOT NULL AND valid_from <= ?"
        " AND ((valid_to IS NULL AND status = 'active')"
        "  OR (valid_to IS NOT NULL AND valid_to > ?))"
        " ORDER BY valid_from DESC, id ASC",
        (date, date),
    ).fetchall()
    return [dict(r) for r in rows]


def claim_timeline(conn, claim_id: str) -> dict | None:
    """One claim's full ledger view: row + occurrences + links + events."""
    row = conn.execute("SELECT * FROM claims WHERE id = ?", (claim_id,)).fetchone()
    if row is None:
        return None
    occurrences = [
        dict(r)
        for r in conn.execute(
            "SELECT doc, line, quote_hash, written_at FROM occurrences WHERE claim_id = ?"
            " ORDER BY doc, line",
            (claim_id,),
        ).fetchall()
    ]
    links = [
        dict(r)
        for r in conn.execute(
            "SELECT src, dst, kind, decided_by, decided_at FROM links"
            " WHERE src = ? OR dst = ? ORDER BY decided_at",
            (claim_id, claim_id),
        ).fetchall()
    ]
    events = [
        dict(r)
        for r in conn.execute(
            "SELECT seq, at, actor, op, target FROM events"
            " WHERE target = ? ORDER BY seq",
            (claim_id,),
        ).fetchall()
    ]
    out = dict(row)
    out["occurrences"] = occurrences
    out["links"] = links
    out["events"] = events
    return out
