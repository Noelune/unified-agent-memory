# -*- coding: utf-8 -*-
"""graph — optional lightweight concept graph over memory lines.

A simple, dependency-free co-occurrence graph:

  - ``_tokens`` splits a line into significant concepts: ASCII words (≥3
    chars) plus CJK bigrams.
  - ``build_graph`` scans active memories, keeps concepts appearing in at
    least two lines as nodes, and weights edges between concepts that appear
    in the same line.
  - ``expand_search`` is the third retrieval stream of the hybrid search: it
    finds memories that share a concept with the query, then expands one hop
    through the graph to related memories.

The graph is strictly optional. When it is empty (or disabled) the hybrid
search simply runs on BM25 + vectors.
"""
from __future__ import annotations

import re
from pathlib import Path

from . import index

MIN_CONCEPT_FREQ = 2
MAX_EXPAND_HOPS = 1
MAX_CANDIDATES = 60

_ASCII_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_\-]{2,}")
_CJK_RUN_RE = re.compile(r"[一-鿿]+")
_STOP_WORDS = {
    "the", "and", "for", "with", "that", "this", "from", "have", "has",
    "you", "your", "our", "are", "was", "not", "but", "all", "can", "use",
    "using", "used", "into", "about", "after", "before",
}


def _tokens(text: str) -> set[str]:
    """Significant concepts in ``text`` (ASCII words + CJK bigrams)."""
    toks: set[str] = set()
    for w in _ASCII_TOKEN_RE.findall(text):
        w = w.lower()
        if w not in _STOP_WORDS and len(w) >= 3:
            toks.add(w)
    for run in _CJK_RUN_RE.findall(text):
        if len(run) >= 2:
            toks.update(run[i : i + 2] for i in range(len(run) - 1))
    return toks


def _active_lines(conn) -> list[dict]:
    rows = conn.execute("SELECT id, doc, line, type, importance, source_agent FROM memories WHERE status = 'active'").fetchall()
    return [dict(r) for r in rows]


def build_graph(vault: Path) -> int:
    """(Re)build the concept graph from active memories. Returns node count."""
    conn = index.get_conn(vault)
    try:
        rows = conn.execute("SELECT line FROM memories WHERE status = 'active'").fetchall()
        conn.execute("DELETE FROM graph_nodes")
        conn.execute("DELETE FROM graph_edges")
        counts: dict[str, int] = {}
        line_tokens: list[set[str]] = []
        for row in rows:
            toks = _tokens(row["line"])
            if not toks:
                continue
            line_tokens.append(toks)
            for t in toks:
                counts[t] = counts.get(t, 0) + 1
        concepts = {t for t, c in counts.items() if c >= MIN_CONCEPT_FREQ}
        for t in concepts:
            conn.execute("INSERT OR REPLACE INTO graph_nodes (name, kind) VALUES (?, 'concept')", (t,))
        for toks in line_tokens:
            relevant = sorted(toks & concepts)
            for i in range(len(relevant)):
                for j in range(i + 1, len(relevant)):
                    conn.execute(
                        """INSERT INTO graph_edges (src, dst, kind, weight) VALUES (?, ?, 'co', 1)
                           ON CONFLICT(src, dst, kind) DO UPDATE SET weight = weight + 1""",
                        (relevant[i], relevant[j]),
                    )
        conn.commit()
        return len(concepts)
    finally:
        conn.close()


def expand_search(vault: Path, query: str, limit: int = 20) -> list[dict]:
    """Graph retrieval stream: memories sharing a concept with the query, plus
    one-hop neighbours. Returns memory records shaped like the other streams.

    Implemented in Python over the memory lines — the graph is small and the
    co-occurrence structure is derived, so a dedicated query plan adds nothing.
    """
    query_toks = _tokens(query)
    if not query_toks:
        return []
    conn = index.get_conn(vault)
    try:
        memories = _active_lines(conn)
    finally:
        conn.close()
    scored: dict[str, float] = {}
    by_id: dict[str, dict] = {}
    token_by_id: dict[str, set[str]] = {}
    for mem in memories:
        toks = _tokens(mem["line"])
        token_by_id[mem["id"]] = toks
        by_id[mem["id"]] = mem
        shared = len(toks & query_toks)
        if shared:
            scored[mem["id"]] = scored.get(mem["id"], 0.0) + shared * 2.0  # direct hits weighted ×2
    if not scored:
        return []
    # One-hop expansion: memories sharing a concept with a direct hit.
    expanded: dict[str, float] = {}
    for mid in list(scored):
        for other in memories:
            if other["id"] in scored:
                continue
            shared = len(token_by_id[mid] & token_by_id[other["id"]])
            if shared:
                expanded[other["id"]] = expanded.get(other["id"], 0.0) + shared
    for mid, bonus in expanded.items():
        scored[mid] = scored.get(mid, 0.0) + bonus
    ranked = sorted(scored.items(), key=lambda pair: pair[1], reverse=True)[:limit]
    results: list[dict] = []
    for mid, score in ranked:
        rec = dict(by_id[mid])
        rec["score"] = round(score, 4)
        results.append(rec)
    return results


def graph_stats(vault: Path) -> dict:
    conn = index.get_conn(vault)
    try:
        nodes = conn.execute("SELECT COUNT(*) AS c FROM graph_nodes").fetchone()["c"]
        edges = conn.execute("SELECT COUNT(*) AS c FROM graph_edges").fetchone()["c"]
        return {"nodes": nodes, "edges": edges}
    finally:
        conn.close()
