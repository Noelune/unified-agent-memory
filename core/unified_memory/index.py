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
    canonical_dir,
    redact,
    strip_suffix,
    bare_fact_line,
)
from .schema import SCHEMA_VERSION, index_db_for, get_conn  # noqa: F401  (re-exported API)

__all__ = [
    "SCHEMA_VERSION", "index_db_for", "get_conn", "indexed_files",
    "update_memories", "update_index", "fts_search", "bm25_memory_search",
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

WRITTEN_STAMP_RE = re.compile(
    r"（写入 (\d{4}-\d{2}-\d{2})｜来源：Agent提交区/([^）]*)）"
    r"|\(written (\d{4}-\d{2}-\d{2})｜source:[^)]*\)"
)
SUPERSEDED_HEADING_RE = re.compile(r"已取代|已失效|已废弃|superseded|obsolete", re.I)


def parse_write_stamp(line: str) -> tuple[str | None, str]:
    """Return (created_date, source_agent) parsed from a promoted line's stamp.

    source_agent is the submission file prefix (the part before the first "-"),
    falling back to "" when there is no usable stamp.
    """
    m = WRITTEN_STAMP_RE.search(line)
    if not m:
        return None, ""
    created = m.group(1) or m.group(3)
    src = m.group(2) or ""
    agent = src.split("-", 1)[0].strip() if src else ""
    return created, agent


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
    """Canonical .md files directly under 50-Agent-Context (not subdirs)."""
    ctx = canonical_dir(vault)
    if not ctx.is_dir():
        return []
    return [p for p in sorted(ctx.glob("*.md")) if p.is_file()]


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
        status = "superseded" if SUPERSEDED_HEADING_RE.search(heading) else "active"
        out.append((status, bare, stripped))
    return out


def update_memories(conn: sqlite3.Connection, vault: Path) -> int:
    """Re-parse canonical notes into memories/embeddings records.

    Incremental per note by content digest: an unchanged note is skipped, a
    changed note has its memories fully rebuilt. Returns the number of memory
    lines upserted. Embeddings are left for `embed_missing` (Phase 2).
    """
    current_paths: set[str] = set()
    changed = 0
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
        # Rebuild this note's memories (delete embeddings/fts_mem first — their
        # ids come from the memories we are about to remove).
        old_ids = [r["id"] for r in conn.execute("SELECT id FROM memories WHERE doc = ?", (rel,)).fetchall()]
        for mid in old_ids:
            conn.execute("DELETE FROM fts_mem WHERE memory_id = ?", (mid,))
        conn.execute("DELETE FROM embeddings WHERE memory_id IN (SELECT id FROM memories WHERE doc = ?)", (rel,))
        conn.execute("DELETE FROM memories WHERE doc = ?", (rel,))
        now = time.strftime("%Y-%m-%dT%H:%M:%S")
        for status, bare, raw in _doc_lines(text):
            mid = hashlib.sha256(bare.encode("utf-8")).hexdigest()
            created, agent = parse_write_stamp(raw)
            mem_type = classify_type(bare)
            conn.execute(
                """INSERT OR REPLACE INTO memories
                   (id, doc, line, type, importance, status, version,
                    superseded_by, source_agent, project, created_at, updated_at,
                    access_count, metadata_json)
                   VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, '', ?, ?, 0, '{}')""",
                (mid, rel, bare, mem_type, salience_for(mem_type), status, agent, created or now, now),
            )
            conn.execute(
                "INSERT OR REPLACE INTO fts_mem (memory_id, line) VALUES (?, ?)",
                (mid, bare),
            )
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
        conn.execute("DELETE FROM docs WHERE path = ?", (old,))
        conn.execute("DELETE FROM fts WHERE path = ?", (old,))
        conn.execute("DELETE FROM embeddings WHERE memory_id IN (SELECT id FROM memories WHERE doc = ?)", (old,))
        conn.execute("DELETE FROM memories WHERE doc = ?", (old,))
    return changed


def update_index(vault: Path, verbose: bool = False) -> dict:
    """Incrementally rebuild the memory database from the vault.

    Returns {"changed_docs": int, "fts": bool}. Embeddings are enriched
    separately by `embed_missing` (Phase 2).
    """
    conn = get_conn(vault)
    try:
        fts_ok = _fts_supported(conn)
        changed = update_memories(conn, vault)
        conn.commit()
        if verbose:
            print(f"index: {index_db_for(vault)} (docs changed {changed}, fts5={'yes' if fts_ok else 'no'})")
        return {"changed_docs": changed, "fts": fts_ok}
    finally:
        conn.close()


# --------------------------------------------------------------------------
# Lexical search (FTS5 with substring fallback — same shape as the legacy CLI)
# --------------------------------------------------------------------------


def fts_search(vault: Path, query: str, limit: int) -> dict:
    update_index(vault)  # self-healing: ensure the derived db is fresh
    conn = get_conn(vault)
    try:
        results: list[dict] = []
        fts_ok = _fts_supported(conn)
        if fts_ok:
            try:
                rows = conn.execute(
                    "SELECT path, title, snippet(fts, 2, '[', ']', '…', 24) AS snip "
                    "FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?",
                    (query, limit),
                ).fetchall()
                for row in rows:
                    results.append(
                        {
                            "doc": redact(Path(row["path"]).name),
                            "title": redact(row["title"]),
                            "snippet": redact(row["snip"] or ""),
                            "query": query,
                        }
                    )
            except sqlite3.Error:
                results = []
        if not results:
            keywords = [kw for kw in re.split(r"[\s,，]+", query) if kw]
            for path in indexed_files(vault):
                text = path.read_text(encoding="utf-8", errors="replace")
                if all(kw.lower() in text.lower() for kw in keywords):
                    results.append(
                        {"doc": redact(path.name), "title": redact(path.stem), "snippet": "", "query": query}
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
