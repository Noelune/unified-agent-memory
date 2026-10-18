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
# Bounds that keep the persisted graph a useful sketch instead of a quadratic
# dump. At 454 memories the old all-pairs builder produced 206,831 edges and a
# 26 MB database; the graph stream never read those tables anyway.
MAX_CONCEPTS_PER_LINE = 16
MAX_NEIGHBORS_PER_LINE = 8
MAX_GRAPH_EDGES = 5000

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
    """(Re)build a bounded concept graph from active memories.

    Concepts must appear in at least ``MIN_CONCEPT_FREQ`` lines. Each line
    contributes at most ``MAX_CONCEPTS_PER_LINE`` concepts, and each concept
    links to a small window of neighbours rather than every other concept on
    the line. The result is finally capped at ``MAX_GRAPH_EDGES`` by weight.
    This keeps the table proportional to the corpus instead of quadratic.
    """
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
            for token in toks:
                counts[token] = counts.get(token, 0) + 1
        concepts = {token for token, count in counts.items() if count >= MIN_CONCEPT_FREQ}
        for token in concepts:
            conn.execute("INSERT OR REPLACE INTO graph_nodes (name, kind) VALUES (?, 'concept')", (token,))
        for toks in line_tokens:
            # Rarest concepts first: they are the most specific evidence.
            relevant = sorted(toks & concepts, key=lambda token: counts[token])[:MAX_CONCEPTS_PER_LINE]
            for i, src in enumerate(relevant):
                for dst in relevant[i + 1 : i + 1 + MAX_NEIGHBORS_PER_LINE]:
                    # Normalise pair order so both directions accumulate into
                    # the same (src, dst) row.
                    left, right = (src, dst) if src < dst else (dst, src)
                    conn.execute(
                        """INSERT INTO graph_edges (src, dst, kind, weight) VALUES (?, ?, 'co', 1)
                           ON CONFLICT(src, dst, kind) DO UPDATE SET weight = weight + 1""",
                        (left, right),
                    )
        conn.execute(
            "DELETE FROM graph_edges WHERE rowid NOT IN "
            "(SELECT rowid FROM graph_edges ORDER BY weight DESC, rowid ASC LIMIT ?)",
            (MAX_GRAPH_EDGES,),
        )
        conn.commit()
        return len(concepts)
    finally:
        conn.close()


def expand_search(vault: Path, query: str, limit: int = 20) -> list[dict]:
    """Graph retrieval stream: memories sharing a concept with the query, plus
    one-hop neighbours. Returns memory records shaped like the other streams.

    Uses an inverted concept index built in one pass. The previous version
    compared every direct hit against every memory, which is O(N²) per query
    and dominated hybrid-search latency on a vault of a few hundred lines.
    """
    query_toks = _tokens(query)
    if not query_toks:
        return []
    conn = index.get_conn(vault)
    try:
        memories = _active_lines(conn)
    finally:
        conn.close()

    postings: dict[str, list[str]] = {}
    token_by_id: dict[str, set[str]] = {}
    by_id: dict[str, dict] = {}
    for mem in memories:
        toks = _tokens(mem["line"])
        token_by_id[mem["id"]] = toks
        by_id[mem["id"]] = mem
        for token in toks:
            postings.setdefault(token, []).append(mem["id"])

    direct: dict[str, float] = {}
    for token in query_toks:
        for mid in postings.get(token, ()):
            direct[mid] = direct.get(mid, 0.0) + 2.0  # direct hits weighted ×2
    if not direct:
        return []

    # One-hop expansion: every memory that shares a concept with a direct hit.
    expanded: dict[str, float] = {}
    for mid, weight in direct.items():
        for token in token_by_id[mid]:
            for other in postings.get(token, ()):
                if other not in direct:
                    expanded[other] = expanded.get(other, 0.0) + weight
    for mid, bonus in expanded.items():
        direct[mid] = direct.get(mid, 0.0) + bonus

    ranked = sorted(direct.items(), key=lambda pair: pair[1], reverse=True)[: min(limit, MAX_CANDIDATES)]
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
