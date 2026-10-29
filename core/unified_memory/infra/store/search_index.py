# -*- coding: utf-8 -*-
"""search_index — docs/fts/fts_lex: the incremental rebuild + lexical search.

Moved verbatim from index.py (B2). This is the storage half of retrieval; the
file-reading helpers it needs live in domain.markdown (line parsing, tokens)
and infra.vault (indexed_files).
"""
from __future__ import annotations

import hashlib
import re
import sqlite3
import time
from pathlib import Path

from ...domain.markdown import (
    bare_fact_line,
    cjk_tokens,
    doc_lines,
    is_versioned,
    parse_write_stamp,
    redact,
)
from ...domain.policy import classify_type, salience_for
from ..vault import indexed_files
from .schema import get_conn, index_db_for


def _fts_supported(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x)")
        conn.execute("DROP TABLE _fts_probe")
        return True
    except sqlite3.Error:
        return False


def _fts_lex_delete(conn: sqlite3.Connection, memory_id: str) -> None:
    """Drop one memory's lexical row. No-op when the table is absent (pre-v7
    database mid-migration)."""
    try:
        conn.execute("DELETE FROM fts_lex WHERE memory_id = ?", (memory_id,))
    except sqlite3.Error:
        pass


def _fts_lex_upsert(conn: sqlite3.Connection, memory_id: str, line: str) -> None:
    """Mirror one memory line into the single lexical table. No-op when absent."""
    try:
        conn.execute(
            "INSERT OR REPLACE INTO fts_lex (memory_id, tokens) VALUES (?, ?)",
            (memory_id, " ".join(cjk_tokens(line))),
        )
    except sqlite3.Error:
        pass


def _backfill_fts_lex(conn: sqlite3.Connection) -> int:
    """Refill fts_lex from memories when its row count drifted.

    The single lexical table replaced fts_mem (unicode61 — zero hits on
    Chinese) plus fts_mem_tri/fts_mem_bigram (overlapping coverage) in the
    batch-A convergence; cjk_tokens already emits ASCII words AND Chinese
    bigrams, so one table serves both languages. Count comparison (not a
    one-shot flag) heals a dropped or partially-written table.
    """
    try:
        total = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        if not total:
            return 0
        mirrored = conn.execute("SELECT COUNT(*) FROM fts_lex").fetchone()[0]
        if mirrored == total:
            return 0
        rows = conn.execute("SELECT id, line FROM memories").fetchall()
        # FTS5 INSERT OR REPLACE appends rather than replacing, so clear first:
        # memories is the source of truth and every row is rewritten from it.
        conn.execute("DELETE FROM fts_lex")
        conn.executemany(
            "INSERT INTO fts_lex (memory_id, tokens) VALUES (?, ?)",
            [(r["id"], " ".join(cjk_tokens(r["line"]))) for r in rows],
        )
        return len(rows)
    except sqlite3.Error:
        return 0


def _rebuild_doc_rows(conn: sqlite3.Connection, rel: str, text: str, now: str) -> None:
    """Rebuild one changed note's memory rows (parse -> diff-purge -> insert)."""
    old_rows = conn.execute(
        "SELECT id, line, access_count, created_at, updated_at, version "
        "FROM memories WHERE doc = ?",
        (rel,),
    ).fetchall()
    old_ids = {r["id"] for r in old_rows}
    # Reinforcement state is matched per (doc, line), not by id: the id
    # became doc-scoped (occurrence identity, batch A), so an unchanged
    # line keeps its stats through the one-time id remap and later edits.
    old_stats = {
        r["line"]: (r["access_count"], r["created_at"], r["updated_at"], r["version"])
        for r in old_rows
    }
    records = _doc_records(rel, text, now, old_stats)
    new_ids = {record[0] for record in records}
    _purge_doc_rows(conn, rel, old_ids, new_ids)
    _insert_doc_rows(conn, records)


def _doc_records(rel: str, text: str, now: str, old_stats: dict) -> list[tuple]:
    """Parse one note's text into memory row tuples (INSERT layout below)."""
    records: list[tuple] = []
    for status, bare, raw_line in doc_lines(text):
        # Occurrence identity (batch A): the id scopes a fact to ITS note,
        # so the same sentence promoted into two notes stays two rows with
        # two provenances instead of one row that silently keeps only the
        # last writer. text_hash remains the cross-doc duplicate signal.
        occ_id = hashlib.sha256((rel + "\x1f" + bare).encode("utf-8")).hexdigest()
        text_hash = hashlib.sha256(bare.encode("utf-8")).hexdigest()
        created, agent = parse_write_stamp(raw_line)
        mem_type = classify_type(bare)
        prior = old_stats.get(bare)
        records.append(
            (
                occ_id,
                text_hash,
                rel,
                bare,
                mem_type,
                salience_for(mem_type),
                status,
                agent,
                prior[1] if prior and prior[1] else (created or now),
                prior[2] if prior and prior[2] else now,
                prior[0] if prior else 0,
                prior[3] if prior else 1,
            )
        )
    return records


def _purge_doc_rows(conn: sqlite3.Connection, rel: str, old_ids: set[str], new_ids: set[str]) -> None:
    """Delete the derived rows the rebuild replaces (surviving ids keep vectors)."""
    # Vanished lines lose every derived row, including their vector.
    for mid in old_ids - new_ids:
        _fts_lex_delete(conn, mid)
        conn.execute("DELETE FROM embeddings WHERE memory_id = ?", (mid,))
    # Rewrite the note's memory rows. Kept ids keep their embedding row;
    # their FTS rows are re-created below because FTS5 rows carry no
    # update semantics (INSERT OR REPLACE appends).
    conn.execute("DELETE FROM memories WHERE doc = ?", (rel,))
    for mid in old_ids:
        _fts_lex_delete(conn, mid)


def _insert_doc_rows(conn: sqlite3.Connection, records: list[tuple]) -> None:
    """Insert the memory + fts_lex rows for one note's records."""
    seen: set[str] = set()
    for record in records:
        mid = record[0]
        if mid in seen:
            continue  # the same fact twice in one note is one memory
        seen.add(mid)
        # Tuple layout: (occ_id, text_hash, rel, bare, type, salience,
        # status, agent, created, updated, access, version).
        conn.execute(
            """INSERT OR REPLACE INTO memories
               (id, doc, line, text_hash, type, importance, status, version,
                superseded_by, source_agent, project, created_at, updated_at,
                access_count, metadata_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, '', ?, ?, ?, '{}')""",
            (
                record[0], record[2], record[3], record[1], record[4],
                record[5], record[6], record[11], record[7], record[8],
                record[9], record[10],
            ),
        )
        conn.execute(
            "INSERT OR REPLACE INTO fts_lex (memory_id, tokens) VALUES (?, ?)",
            (mid, " ".join(cjk_tokens(record[3]))),
        )


def update_memories(conn: sqlite3.Connection, vault: Path, sweep_orphans: bool = False) -> int:
    """Re-parse canonical notes into memories/embeddings records.

    Incremental per note by content digest: an unchanged note is skipped, a
    changed note has its memory rows rebuilt. Reinforcement state is preserved
    for lines whose bare text is unchanged: a one-word edit to a note must not
    reset every access count in it (that silently made well-used facts
    forgettable again). Embeddings for unchanged lines are kept too, so an
    edit no longer forces a paid re-embed of the whole note.
    """
    current_paths: set[str] = set()
    changed = 0
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    for path in indexed_files(vault):
        rel = str(path)
        current_paths.add(rel)
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        row = conn.execute("SELECT digest FROM docs WHERE path = ?", (rel,)).fetchone()
        if row and row[0] == digest:
            continue
        text = redact(raw.decode("utf-8", errors="replace"))
        title = redact(path.stem)
        conn.execute(
            "INSERT OR REPLACE INTO docs (path, digest, title) VALUES (?, ?, ?)",
            (rel, digest, title),
        )
        conn.execute("DELETE FROM fts WHERE path = ?", (rel,))
        conn.execute("INSERT INTO fts (path, title, content) VALUES (?, ?, ?)", (rel, title, text))

        _rebuild_doc_rows(conn, rel, text, now)
        changed += 1
    _remove_stale_docs(conn, current_paths)
    if sweep_orphans:
        _sweep_orphan_rows(conn, current_paths)
    return changed


def _remove_stale_docs(conn: sqlite3.Connection, current_paths: set[str]) -> None:
    """Delete rows for notes deleted from the vault."""
    # Remove stale docs (deleted from the vault).
    stale = [
        row["path"]
        for row in conn.execute("SELECT path FROM docs").fetchall()
        if row["path"] not in current_paths
    ]
    for old in stale:
        old_mids = [r["id"] for r in conn.execute("SELECT id FROM memories WHERE doc = ?", (old,)).fetchall()]
        for mid in old_mids:
            _fts_lex_delete(conn, mid)
            conn.execute("DELETE FROM embeddings WHERE memory_id = ?", (mid,))
        conn.execute("DELETE FROM docs WHERE path = ?", (old,))
        conn.execute("DELETE FROM fts WHERE path = ?", (old,))
        conn.execute("DELETE FROM memories WHERE doc = ?", (old,))


def _sweep_orphan_rows(conn: sqlite3.Connection, current_paths: set[str]) -> None:
    """Sweep memories whose doc is not a currently indexed note."""
    # A logic-version upgrade clears `docs`, so a note deleted from the vault
    # no longer appears in the stale list. Sweep memories whose doc is
    # not a currently indexed note, whatever the docs table says.
    orphaned = [
        row for row in conn.execute("SELECT id, doc FROM memories").fetchall()
        if row["doc"] not in current_paths
    ]
    for row in orphaned:
        mid = row["id"]
        _fts_lex_delete(conn, mid)
        conn.execute("DELETE FROM embeddings WHERE memory_id = ?", (mid,))
        conn.execute("DELETE FROM memories WHERE id = ?", (mid,))


# Bump when the parsing/classification logic changes in a way that must be
# applied to notes whose bytes did not change. Incremental indexing keys on
# the file digest, so without this an upgraded install keeps the old index
# forever (e.g. dates/sources parsed by an older, narrower stamp regex).
INDEX_LOGIC_VERSION = "3"


def _ensure_logic_version(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT value FROM index_meta WHERE key = 'logic_version'"
    ).fetchone()
    if row is not None and row[0] == INDEX_LOGIC_VERSION:
        return False
    # Clearing docs forces update_memories to re-parse every note. Memory ids
    # are content-derived, so access counts and vectors survive the rebuild.
    conn.execute("DELETE FROM docs")
    conn.execute(
        "INSERT OR REPLACE INTO index_meta (key, value) VALUES ('logic_version', ?)",
        (INDEX_LOGIC_VERSION,),
    )
    return True


def update_index(vault: Path, verbose: bool = False) -> dict:
    """Incrementally rebuild the memory database from the vault.

    Returns {"changed_docs": int, "fts": bool, "lexical_backfilled": int}.
    Embeddings are enriched separately by `embed_missing`.
    """
    conn = get_conn(vault)
    try:
        fts_ok = _fts_supported(conn)
        logic_reset = _ensure_logic_version(conn)
        changed = update_memories(conn, vault, sweep_orphans=logic_reset)
        # Existing databases skip every unchanged note above, so fill the
        # lexical table from memories (no-op afterwards).
        backed = _backfill_fts_lex(conn)
        conn.commit()
        if verbose:
            print(f"index: {index_db_for(vault)} (docs changed {changed}, fts5={'yes' if fts_ok else 'no'})")
        return {
            "changed_docs": changed,
            "fts": fts_ok,
            "lexical_backfilled": backed,
        }
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Lexical search (FTS5 with substring fallback — same shape as the legacy CLI)
# --------------------------------------------------------------------------


def _doc_match(path: Path, query: str) -> tuple[str, str] | None:
    """Best active evidence for a whole-document hit: (snippet, kind) or None.

    The doc-level FTS table (and the substring scan below) index the *whole*
    file, history section included, so a note whose only mention of the query
    sits under 已取代 used to come back as a hit with an empty snippet — the
    caller could not tell a retired value from a current one. Resolve the hit
    to a line and grade it instead:

      ("…", "line")  an active fact line matches   — best
      ("…", "title") no active match, title matches — the note is on topic, so
                     quote its first active fact as context
      None           history-only match             — not an answer
    """
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    keywords = [kw for kw in re.split(r"[\s,，]+", query.lower()) if kw]
    facts = [raw for status, _bare, raw in doc_lines(text) if status == "active"]
    # All terms on one line is the strongest evidence — quote that line.
    for raw in facts:
        if all(kw in raw.lower() for kw in keywords):
            return bare_fact_line(raw), "line"
    # Otherwise the terms may be spread across the note (that is exactly the
    # case the line-level streams miss and this fallback exists for). Quote
    # the best active line that carries any of them.
    for raw in facts:
        if any(kw in raw.lower() for kw in keywords):
            return bare_fact_line(raw), "line"
    # The note is on topic without quoting it: fall back to its title, with the
    # first active fact as context so the caller is not handed a bare filename.
    if facts and all(kw in path.stem.lower() for kw in keywords):
        return bare_fact_line(facts[0]), "title"
    return None


def _fts_fallback(vault: Path, query: str, limit: int) -> list[dict]:
    """Doc-level FTS hits resolved back to active lines; keyword scan last.

    Line-level streams supply both the document and the matched line; doc-level
    FTS remains the fallback when no line matches — resolved to an active line
    by ``_doc_match`` so history never leaks into results.
    """
    conn = get_conn(vault)
    results: list[dict] = []
    try:
        if _fts_supported(conn):
            try:
                rows = conn.execute(
                    "SELECT path, title, snippet(fts, 2, '[', ']', '…', 24) AS snip "
                    "FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?",
                    (query, limit * 2),
                ).fetchall()
            except sqlite3.Error:
                rows = []
            for row in rows:
                hit = _doc_match(Path(row["path"]), query)
                if hit is None:
                    continue
                snippet, kind = hit
                results.append(
                    {
                        "doc": redact(Path(row["path"]).name),
                        "title": redact(row["title"]),
                        "snippet": redact(snippet),
                        "query": query,
                        "match": kind,
                    }
                )
                if len(results) >= limit:
                    break
        if not results:
            keywords = [kw for kw in re.split(r"[\s,，]+", query) if kw]
            for path in indexed_files(vault):
                hit = _doc_match(path, query)
                if hit is None:
                    continue
                snippet, kind = hit
                results.append(
                    {
                        "doc": redact(path.name),
                        "title": redact(path.stem),
                        "snippet": redact(snippet),
                        "query": query,
                        "match": kind,
                    }
                )
                if len(results) >= limit:
                    break
        return results
    finally:
        conn.close()


def fts_search(vault: Path, query: str, limit: int) -> dict:
    """Document search with the best matching fact line as the snippet.

    The old path returned doc-level FTS hits whose ``snippet(fts, content)``
    was empty whenever the match landed on the title (and returned nothing at
    all for Chinese), so callers saw a bare list of file names. Line-level
    streams now supply both the document and the matched line; doc-level FTS
    remains the fallback when no line matches — resolved back to an active
    line by ``_doc_match`` so history never leaks into results.
    """
    update_index(vault)  # self-healing: ensure the derived db is fresh
    results: list[dict] = []
    seen_docs: set[str] = set()

    def add(rows: list[dict]) -> None:
        for row in rows:
            doc_name = Path(row["doc"]).name
            if doc_name in seen_docs:
                continue
            seen_docs.add(doc_name)
            results.append(
                {
                    "id": row["id"],
                    "doc": redact(doc_name),
                    "title": redact(Path(doc_name).stem),
                    "snippet": redact(row["line"]),
                    "query": query,
                }
            )
            if len(results) >= limit:
                return

    try:
        add(lexical_search(vault, query, limit=limit * 2))
    except sqlite3.Error:
        pass
    if results:
        return {
            "ok": True,
            "query": query,
            "count": len(results),
            "results": results[:limit],
            "index": str(index_db_for(vault)),
        }

    results = _fts_fallback(vault, query, limit)
    return {"ok": True, "query": query, "count": len(results), "results": results, "index": str(index_db_for(vault))}


# --------------------------------------------------------------------------
# Lexical stream (memory granularity) — the ONE lexical ranker of the hybrid
# search. cjk_tokens emits ASCII words AND Chinese bigrams, so a single FTS
# table over bigram-tokenised lines covers both languages; the old fts_mem
# (unicode61, zero hits on Chinese) and the trigram mirror are gone.
# --------------------------------------------------------------------------


def _fts_or_query(text: str) -> str:
    """FTS5 query string that ORs quoted tokens (safe for punctuation)."""
    return " OR ".join(f'"{t}"' for t in cjk_tokens(text))


def lexical_search(vault: Path, query: str, limit: int = 20) -> list[dict]:
    """Rank active memory lines lexically (BM25 over fts_lex).

    Every query token is quoted before MATCH, so punctuation in the query
    cannot turn into FTS5 syntax; the whole expression is bound as a
    parameter. Falls back to a case-insensitive substring scan when FTS5 is
    unavailable or the table is empty (mirrors the old per-stream fallbacks).

    Returns a list of memory records shaped like every other stream's.
    """
    conn = get_conn(vault)
    try:
        match = _fts_or_query(query)
        if match:
            try:
                rows = conn.execute(
                    "SELECT m.id, m.doc, m.line, m.type, m.importance, m.source_agent, "
                    "rank AS rnk FROM fts_lex f JOIN memories m ON m.id = f.memory_id "
                    "WHERE fts_lex MATCH ? AND m.status = 'active' ORDER BY rank LIMIT ?",
                    (match, limit),
                ).fetchall()
                if rows:
                    return [dict(r) for r in rows]
            except sqlite3.Error:
                pass
        # Fallback: substring match per whitespace-separated keyword.
        keywords = [kw for kw in re.split(r"[\s,，]+", query) if kw]
        if not keywords:
            return []
        results = []
        for row in conn.execute(
            "SELECT id, doc, line, type, importance, source_agent FROM memories WHERE status = 'active'"
        ).fetchall():
            if all(kw.lower() in row["line"].lower() for kw in keywords):
                results.append(dict(row))
                if len(results) >= limit:
                    break
        return results
    except sqlite3.Error:
        return []
    finally:
        conn.close()
