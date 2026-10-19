# -*- coding: utf-8 -*-
"""index — the memory database (a derived copy of the Obsidian vault).

Design (see docs/ARCHITECTURE.md):

  Obsidian vault 50-Agent-Context/ is the single source of truth. This module
  maintains the per-vault SQLite *memory database* that derives from it:

    docs          per-note metadata (digest → incremental rebuild)
    fts           FTS5/BM25 over note content
    memories      one record per canonical fact line (typed, importance,
                  version, superseded chain, provenance)
    embeddings    Float32 vectors for memory lines (optional, SiliconFlow)
    access_log    read receipts → reinforcement scoring for forgetting
    audit         provenance/accountability for mutations

  Everything here is rebuilt from the vault; nothing here is authoritative.
  Redaction happens at ingestion: credential-shaped text never reaches the db.

Zero dependencies: Python standard library only. Vectors are stored as BLOB
(Float32) and compared with a plain Python cosine loop — fine for hundreds to
a few thousand memory lines.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path

from .common import (
    UNCLASSIFIED_FACT_REL,
    bare_fact_line,
    canonical_dir,
    is_conflict_copy,
    is_versioned,
    parse_stamp,
    redact,
    source_agent,
)
from .schema import SCHEMA_VERSION, index_db_for, get_conn  # noqa: F401  (re-exported API)

__all__ = [
    "SCHEMA_VERSION", "index_db_for", "get_conn", "indexed_files",
    "update_memories", "update_index", "fts_search", "bm25_memory_search",
    "bm25_bigram_search", "trigram_memory_search", "cjk_tokens",
    "record_access", "record_audit", "active_memories", "memory_count",
]

# --------------------------------------------------------------------------
# Memory types & salience (borrowed from rohitg00/agentmemory's salience
# ordering: architecture > preference > pattern > bug > workflow > fact).
# --------------------------------------------------------------------------

MEMORY_TYPES = ("architecture", "preference", "pattern", "bug", "workflow", "fact", "other")

SALIENCE: dict[str, float] = {
    "architecture": 0.9,
    "preference": 0.85,
    "pattern": 0.8,
    "bug": 0.7,
    "workflow": 0.6,
    "fact": 0.5,
    "other": 0.4,
}

# Keyword → memory type (best-effort, rule-based, no LLM).
TYPE_RULES: list[tuple[str, re.Pattern]] = [
    ("preference", re.compile(r"prefer|like|dislike|favor|default|language|format|tone|语气|偏好|喜欢|希望|不要|审美|风格|style", re.I)),
    ("architecture", re.compile(r"architecture|architect|微服务|服务架构|模块|组件|依赖|refactor|重构|迁移|migrate|database|db|schema|接口|api design|设计|技术决策|decid|方案", re.I)),
    ("bug", re.compile(r"bug|fix|fixed|issue|error|错误|报错|踩坑|失败|fail|workaround|绕开|故障|异常|exception|crash|崩溃", re.I)),
    ("workflow", re.compile(r"workflow|process|step|步骤|流程|rule|规则|必须|must|always|never|验证|verify|deploy|发布|backup|备份|checklist|清单|red line|红线", re.I)),
    ("pattern", re.compile(r"pattern|模式|习惯|通常|typically|usually|always|惯例|convention|best practice|最佳实践|模板|template", re.I)),
    ("fact", re.compile(r"path|路径|version|版本|install|安装|port|端口|server|服务器|host|地址|url|endpoint|account|账号|config|配置|工具|tool|环境|env|credential|凭据|location|位于", re.I)),
]


def classify_type(fact: str) -> str:
    """Classify a bare fact line into a memory type by keyword rules."""
    for name, pattern in TYPE_RULES:
        if pattern.search(fact):
            return name
    return "other"


def salience_for(mem_type: str) -> float:
    return SALIENCE.get(mem_type, 0.5)


# --------------------------------------------------------------------------
# Write-stamp parsing  （写入 YYYY-MM-DD｜来源：Agent提交区/<agent>-…）
# --------------------------------------------------------------------------

SUPERSEDED_HEADING_RE = re.compile(r"已取代|已失效|已废弃|superseded|obsolete", re.I)


def parse_write_stamp(line: str) -> tuple[str | None, str]:
    """Return (created_date, source_agent) parsed from a promoted line's stamp.

    Delegates to common.parse_stamp so both the repo/dsh dialect and the
    Hermes ``[[Agent提交区/...]]`` / ``事件`` dialect resolve. Returning ""
    for every Hermes-written line used to make the whole live vault look
    undated and unattributed.
    """
    created, source, _valid_until = parse_stamp(line)
    return created, source_agent(source)


# --------------------------------------------------------------------------
# Per-vault index path
# --------------------------------------------------------------------------


# --------------------------------------------------------------------------
# Schema (see schema.py — extracted 2026-08-29, re-exported here for API compat)
# --------------------------------------------------------------------------


# --------------------------------------------------------------------------
# Canonical files
# --------------------------------------------------------------------------


def indexed_files(vault: Path) -> list[Path]:
    """Canonical .md files that actually hold facts.

    Top-level notes, plus the one situation note the promoter writes facts
    into. `情境信息/未归类事实.md` used to be excluded by a top-level-only
    glob, so every fact the classifier could not place was written, stamped
    and locked — and then permanently invisible to search. The rest of
    情境信息/ is workflow state (待晋升 / 冲突 / 已裁决) and 已处理/ is the
    inbox archive; indexing those would surface duplicates and stale rows.

    Sync-client conflict copies (``note 2.md``, ``note-副本.md`` …) are skipped:
    they are an unresolved duplicate of a note, not another source of truth.
    """
    ctx = canonical_dir(vault)
    if not ctx.is_dir():
        return []
    files = [
        p
        for p in sorted(ctx.glob("*.md"))
        if p.is_file() and not is_conflict_copy(p.name)
    ]
    unclassified = ctx / UNCLASSIFIED_FACT_REL
    if unclassified.is_file() and not is_conflict_copy(unclassified.name):
        files.append(unclassified)
    return files


# --------------------------------------------------------------------------
# CJK-aware tokenisation (BM25 stream)
# --------------------------------------------------------------------------

_CJK_RUN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+")
_WORD_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.\-]*")


def cjk_tokens(text: str) -> list[str]:
    """Overlapping-bigram tokens for Chinese + lowercased ASCII words.

    unicode61 treats a contiguous Chinese run as a single token, so a query
    like 记忆 can never match a line containing 记忆系统. Bigrams restore
    ordinary substring recall without a third-party segmenter.
    """
    tokens: list[str] = []
    for run in _CJK_RUN_RE.findall(text or ""):
        if len(run) == 1:
            tokens.append(run)
        else:
            tokens.extend(run[i : i + 2] for i in range(len(run) - 1))
    for word in _WORD_RE.findall(text or ""):
        word = word.lower()
        if len(word) >= 2:
            tokens.append(word)
    # Stable dedupe: repeated tokens add nothing to a BM25 query.
    seen: set[str] = set()
    return [t for t in tokens if not (t in seen or seen.add(t))]


def _fts_or_query(text: str) -> str:
    """FTS5 query string that ORs quoted tokens (safe for punctuation)."""
    return " OR ".join(f'"{t}"' for t in cjk_tokens(text))


# --------------------------------------------------------------------------
# Incremental rebuild
# --------------------------------------------------------------------------


def _fts_supported(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x)")
        conn.execute("DROP TABLE _fts_probe")
        return True
    except sqlite3.Error:
        return False


def _fts_mem_tri_delete(conn: sqlite3.Connection, memory_id: str) -> None:
    """Drop one memory's trigram row. No-op when the table is absent (older
    SQLite without the trigram tokenizer)."""
    try:
        conn.execute("DELETE FROM fts_mem_tri WHERE memory_id = ?", (memory_id,))
    except sqlite3.Error:
        pass


def _fts_mem_tri_upsert(conn: sqlite3.Connection, memory_id: str, line: str) -> None:
    """Mirror one memory line into the trigram table. No-op when absent."""
    try:
        conn.execute(
            "INSERT OR REPLACE INTO fts_mem_tri (memory_id, line) VALUES (?, ?)",
            (memory_id, line),
        )
    except sqlite3.Error:
        pass


def _fts_mem_bigram_delete(conn: sqlite3.Connection, memory_id: str) -> None:
    try:
        conn.execute("DELETE FROM fts_mem_bigram WHERE memory_id = ?", (memory_id,))
    except sqlite3.Error:
        pass


def _fts_mem_bigram_upsert(conn: sqlite3.Connection, memory_id: str, line: str) -> None:
    try:
        conn.execute(
            "INSERT OR REPLACE INTO fts_mem_bigram (memory_id, tokens) VALUES (?, ?)",
            (memory_id, " ".join(cjk_tokens(line))),
        )
    except sqlite3.Error:
        pass


def _backfill_fts_mem_tri(conn: sqlite3.Connection) -> int:
    """Refill fts_mem_tri from memories when its row count drifted.

    update_memories is incremental by note digest, so notes indexed before
    this table existed are skipped forever. Comparing counts (instead of
    trusting a one-shot flag) also heals a dropped or partially-written table.
    """
    try:
        total = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        if not total:
            return 0
        mirrored = conn.execute("SELECT COUNT(*) FROM fts_mem_tri").fetchone()[0]
        if mirrored == total:
            return 0
        rows = conn.execute("SELECT id, line FROM memories").fetchall()
        # FTS5 INSERT OR REPLACE appends rather than replacing, so clear first:
        # memories is the source of truth and every row is rewritten from it.
        conn.execute("DELETE FROM fts_mem_tri")
        conn.executemany(
            "INSERT INTO fts_mem_tri (memory_id, line) VALUES (?, ?)",
            [(r["id"], r["line"]) for r in rows],
        )
        return len(rows)
    except sqlite3.Error:
        return 0


def _backfill_fts_mem_bigram(conn: sqlite3.Connection) -> int:
    """Refill fts_mem_bigram from memories when its row count drifted."""
    try:
        total = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        if not total:
            return 0
        mirrored = conn.execute("SELECT COUNT(*) FROM fts_mem_bigram").fetchone()[0]
        if mirrored == total:
            return 0
        rows = conn.execute("SELECT id, line FROM memories").fetchall()
        conn.execute("DELETE FROM fts_mem_bigram")
        conn.executemany(
            "INSERT INTO fts_mem_bigram (memory_id, tokens) VALUES (?, ?)",
            [(r["id"], " ".join(cjk_tokens(r["line"]))) for r in rows],
        )
        return len(rows)
    except sqlite3.Error:
        return 0


def _doc_lines(text: str) -> list[tuple[str, str, str]]:
    """Parse a canonical note into (status, bare_line, raw_line) tuples.

    A line under a heading that mentions 已取代/已失效/已废弃 (or superseded)
    is marked ``superseded``; everything else is ``active``. Non-fact lines
    (headings, prose, tables) are ignored.
    """
    out: list[tuple[str, str, str]] = []
    heading = ""
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped.startswith("#"):
            heading = stripped
            continue
        if not stripped.startswith(("- ", "• ", "* ")):
            continue
        bare = bare_fact_line(stripped)
        if not bare:
            continue
        # Bi-temporal versioning: a line carrying ｜有效至 is a historical
        # version even when it is not physically under a 已取代 heading. That
        # is how the Hermes promoter records supersession, so it must not stay
        # searchable as current truth.
        status = (
            "superseded"
            if SUPERSEDED_HEADING_RE.search(heading) or is_versioned(stripped)
            else "active"
        )
        out.append((status, bare, stripped))
    return out


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

        old_rows = conn.execute(
            "SELECT id, access_count, created_at, updated_at, version "
            "FROM memories WHERE doc = ?",
            (rel,),
        ).fetchall()
        old_ids = {r["id"] for r in old_rows}
        old_stats = {
            r["id"]: (r["access_count"], r["created_at"], r["updated_at"], r["version"])
            for r in old_rows
        }

        records: list[tuple] = []
        for status, bare, raw_line in _doc_lines(text):
            mid = hashlib.sha256(bare.encode("utf-8")).hexdigest()
            created, agent = parse_write_stamp(raw_line)
            mem_type = classify_type(bare)
            prior = old_stats.get(mid)
            records.append(
                (
                    mid,
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
        new_ids = {record[0] for record in records}

        # Vanished lines lose every derived row, including their vector.
        for mid in old_ids - new_ids:
            conn.execute("DELETE FROM fts_mem WHERE memory_id = ?", (mid,))
            _fts_mem_tri_delete(conn, mid)
            _fts_mem_bigram_delete(conn, mid)
            conn.execute("DELETE FROM embeddings WHERE memory_id = ?", (mid,))

        # Rewrite the note's memory rows. Kept ids keep their embedding row;
        # their FTS rows are re-created below because FTS5 rows carry no
        # update semantics (INSERT OR REPLACE appends).
        conn.execute("DELETE FROM memories WHERE doc = ?", (rel,))
        for mid in old_ids:
            conn.execute("DELETE FROM fts_mem WHERE memory_id = ?", (mid,))
            _fts_mem_tri_delete(conn, mid)
            _fts_mem_bigram_delete(conn, mid)

        seen: set[str] = set()
        for record in records:
            mid = record[0]
            if mid in seen:
                continue  # the same fact twice in one note is one memory
            seen.add(mid)
            conn.execute(
                """INSERT OR REPLACE INTO memories
                   (id, doc, line, type, importance, status, version,
                    superseded_by, source_agent, project, created_at, updated_at,
                    access_count, metadata_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, '', ?, ?, ?, '{}')""",
                (
                    record[0], record[1], record[2], record[3], record[4],
                    record[5], record[10], record[6], record[7], record[8], record[9],
                ),
            )
            conn.execute(
                "INSERT OR REPLACE INTO fts_mem (memory_id, line) VALUES (?, ?)",
                (mid, record[2]),
            )
            _fts_mem_tri_upsert(conn, mid, record[2])
            _fts_mem_bigram_upsert(conn, mid, record[2])
        changed += 1
    # Remove stale docs (deleted from the vault).
    stale = [
        row["path"]
        for row in conn.execute("SELECT path FROM docs").fetchall()
        if row["path"] not in current_paths
    ]
    for old in stale:
        old_mids = [r["id"] for r in conn.execute("SELECT id FROM memories WHERE doc = ?", (old,)).fetchall()]
        for mid in old_mids:
            conn.execute("DELETE FROM fts_mem WHERE memory_id = ?", (mid,))
            _fts_mem_tri_delete(conn, mid)
            _fts_mem_bigram_delete(conn, mid)
            conn.execute("DELETE FROM embeddings WHERE memory_id = ?", (mid,))
        conn.execute("DELETE FROM docs WHERE path = ?", (old,))
        conn.execute("DELETE FROM fts WHERE path = ?", (old,))
        conn.execute("DELETE FROM memories WHERE doc = ?", (old,))
    # A logic-version upgrade clears `docs`, so a note deleted from the vault
    # no longer appears in the stale list above. Sweep memories whose doc is
    # not a currently indexed note, whatever the docs table says.
    orphaned = (
        [
            row for row in conn.execute("SELECT id, doc FROM memories").fetchall()
            if row["doc"] not in current_paths
        ]
        if sweep_orphans
        else []
    )
    for row in orphaned:
        mid = row["id"]
        conn.execute("DELETE FROM fts_mem WHERE memory_id = ?", (mid,))
        _fts_mem_tri_delete(conn, mid)
        _fts_mem_bigram_delete(conn, mid)
        conn.execute("DELETE FROM embeddings WHERE memory_id = ?", (mid,))
        conn.execute("DELETE FROM memories WHERE id = ?", (mid,))
    return changed


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

    Returns {"changed_docs": int, "fts": bool, "trigram_backfilled": int,
    "bigram_backfilled": int}. Embeddings are enriched separately by
    `embed_missing`.
    """
    conn = get_conn(vault)
    try:
        fts_ok = _fts_supported(conn)
        logic_reset = _ensure_logic_version(conn)
        changed = update_memories(conn, vault, sweep_orphans=logic_reset)
        # Existing databases skip every unchanged note above, so fill the
        # auxiliary CJK tables from memories (no-op afterwards).
        backed = _backfill_fts_mem_tri(conn)
        bigram_backed = _backfill_fts_mem_bigram(conn)
        conn.commit()
        if verbose:
            print(f"index: {index_db_for(vault)} (docs changed {changed}, fts5={'yes' if fts_ok else 'no'})")
        return {
            "changed_docs": changed,
            "fts": fts_ok,
            "trigram_backfilled": backed,
            "bigram_backfilled": bigram_backed,
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
    facts = [raw for status, _bare, raw in _doc_lines(text) if status == "active"]
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
                    "doc": redact(doc_name),
                    "title": redact(Path(doc_name).stem),
                    "snippet": redact(row["line"]),
                    "query": query,
                }
            )
            if len(results) >= limit:
                return

    for search_fn in (bm25_memory_search, bm25_bigram_search, trigram_memory_search):
        if len(results) >= limit:
            break
        try:
            add(search_fn(vault, query, limit=limit * 2))
        except sqlite3.Error:
            continue
    if results:
        return {
            "ok": True,
            "query": query,
            "count": len(results),
            "results": results[:limit],
            "index": str(index_db_for(vault)),
        }

    conn = get_conn(vault)
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
        return {"ok": True, "query": query, "count": len(results), "results": results, "index": str(index_db_for(vault))}
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Per-line BM25 (memory granularity) — used by the hybrid search
# --------------------------------------------------------------------------


def bm25_memory_search(vault: Path, query: str, limit: int = 20) -> list[dict]:
    """Rank active memory lines by BM25 (or a substring fallback).

    Returns a list of memory records with a ``lex_score`` hint. Falls back to
    a Python keyword scan when the per-line FTS table is unavailable.
    """
    conn = get_conn(vault)
    try:
        try:
            rows = conn.execute(
                "SELECT m.id, m.doc, m.line, m.type, m.importance, m.source_agent, "
                "rank AS rnk FROM fts_mem f JOIN memories m ON m.id = f.memory_id "
                "WHERE fts_mem MATCH ? AND m.status = 'active' ORDER BY rank LIMIT ?",
                (query, limit),
            ).fetchall()
            results = [dict(r) for r in rows]
            if results:
                return results
        except sqlite3.Error:
            pass
        # Fallback: substring match per whitespace-separated keyword.
        keywords = [kw for kw in re.split(r"[\s,，]+", query) if kw]
        results = []
        for row in conn.execute(
            "SELECT id, doc, line, type, importance, source_agent FROM memories WHERE status = 'active'"
        ).fetchall():
            if all(kw.lower() in row["line"].lower() for kw in keywords):
                results.append(dict(row))
                if len(results) >= limit:
                    break
        return results
    finally:
        conn.close()


def bm25_bigram_search(vault: Path, query: str, limit: int = 20) -> list[dict]:
    """CJK-capable BM25 over bigram-tokenised memory lines.

    Returns an empty list when the auxiliary table is unavailable; the
    trigram stream still covers long Chinese substrings in that case.
    """
    # Every token is quoted, so punctuation in the user's query cannot turn
    # into FTS5 syntax; the whole expression is bound as a parameter.
    match = _fts_or_query(query)
    if not match:
        return []
    conn = get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT m.id, m.doc, m.line, m.type, m.importance, m.source_agent, "
            "rank AS rnk FROM fts_mem_bigram f JOIN memories m ON m.id = f.memory_id "
            "WHERE fts_mem_bigram MATCH ? AND m.status = 'active' ORDER BY rank LIMIT ?",
            (match, limit),
        ).fetchall()
        return [dict(row) for row in rows]
    except sqlite3.Error:
        return []
    finally:
        conn.close()


def trigram_memory_search(vault: Path, query: str, limit: int = 20) -> list[dict]:
    """CJK-friendly substring recall via the trigram FTS table.

    The trigram tokenizer indexes 3-character windows, so a query shorter than
    3 characters (most Chinese search terms: 记忆 / 路径 / 环境 …) can never
    MATCH. When the FTS path yields no rows we fall back to a case-insensitive
    substring scan, mirroring ``bm25_memory_search``.

    Returns an empty list when the tokenizer or table is unavailable — this
    stream is additive, so degrading to nothing is always correct.
    """
    conn = get_conn(vault)
    try:
        try:
            rows = conn.execute(
                "SELECT m.id, m.doc, m.line, m.type, m.importance, m.source_agent, "
                "rank AS rnk FROM fts_mem_tri f JOIN memories m ON m.id = f.memory_id "
                "WHERE fts_mem_tri MATCH ? AND m.status = 'active' ORDER BY rank LIMIT ?",
                (query, limit),
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


# --------------------------------------------------------------------------
# Access tracking (reinforcement for forgetting) & audit
# --------------------------------------------------------------------------


def record_access(vault: Path, memory_ids: list[str]) -> None:
    conn = get_conn(vault)
    try:
        now = time.strftime("%Y-%m-%dT%H:%M:%S")
        for mid in memory_ids:
            conn.execute("UPDATE memories SET access_count = access_count + 1, updated_at = ? WHERE id = ?", (now, mid))
            conn.execute("INSERT INTO access_log (memory_id, at) VALUES (?, ?)", (mid, now))
        conn.commit()
    finally:
        conn.close()


def record_audit(vault: Path, agent: str, action: str, target: str, detail: str = "") -> None:
    conn = get_conn(vault)
    try:
        conn.execute(
            "INSERT INTO audit (at, agent, action, target, detail) VALUES (?, ?, ?, ?, ?)",
            (time.strftime("%Y-%m-%dT%H:%M:%S"), agent, action, target, detail),
        )
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Convenience: enumerate active memories (for forgetter, graph, digest…)
# --------------------------------------------------------------------------


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
