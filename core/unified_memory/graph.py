# -*- coding: utf-8 -*-
"""graph — the concept-expansion retrieval stream (computed in memory).

The persisted graph_nodes/graph_edges tables are gone (batch A, v8): they
were written and capped but NEVER read — expand_search always rebuilt its
postings from the memories table, so 1335 nodes / 5000 capped edges were pure
write amplification. Everything now happens here, per query:

  - ``_tokens`` splits a line into significant concepts: ASCII words (≥3
    chars) plus CJK bigrams.
  - ``expand_search`` finds memories sharing a concept with the query
    (direct hits), then expands one hop through shared concepts with
    degree-normalised weights, and applies two gates the old version lacked:
      * relevance floor: candidates below 0.5 x the top score are dropped
        (previously ANY query — including nonsense — returned a full pool);
      * candidate cap: at most ceil(2.5 x direct hits) results, and an empty
        list when there are no direct hits at all.
  - ``graph_stats`` reports the same concepts/pairs in memory, for the CLI.

The stream is strictly optional: hybrid search skips it when it yields
nothing, and never fails because of it.
"""
from __future__ import annotations

import math
import re
from pathlib import Path

from .infra.store import active_memories

MIN_CONCEPT_FREQ = 2
MAX_CANDIDATES = 60
SCORE_FLOOR_RATIO = 0.5
POOL_FACTOR = 2.5

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


def _active_lines(vault: Path) -> list[dict]:
    return active_memories(vault)


def expand_search(vault: Path, query: str, limit: int = 20) -> list[dict]:
    """Graph retrieval stream: memories sharing a concept with the query, plus
    one-hop neighbours. Returns memory records shaped like the other streams.

    Gated (batch A): the previous version returned a full pool for EVERY
    query — a nonsense query included — which fed RRF a near-uniform vote
    distribution and diluted precision.
    """
    query_toks = _tokens(query)
    if not query_toks:
        return []
    memories = _active_lines(vault)

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
            direct[mid] = direct.get(mid, 0.0) + 2.0  # direct hits weighted x2
    if not direct:
        return []

    # One-hop expansion, degree-normalised: a concept shared by fifty lines
    # carries far less individual evidence than one shared by two, so its
    # per-neighbour bonus is divided by the concept's document frequency.
    expanded: dict[str, float] = {}
    for mid, weight in direct.items():
        for token in token_by_id[mid]:
            degree = len(postings.get(token, ()))
            bonus = weight / max(1, degree)
            for other in postings.get(token, ()):
                if other not in direct:
                    expanded[other] = expanded.get(other, 0.0) + bonus
    for mid, bonus in expanded.items():
        direct[mid] = direct.get(mid, 0.0) + bonus

    ranked = sorted(direct.items(), key=lambda pair: pair[1], reverse=True)
    top_score = ranked[0][1]
    floor = top_score * SCORE_FLOOR_RATIO
    cap = min(limit, MAX_CANDIDATES, math.ceil(POOL_FACTOR * len(direct)))
    results: list[dict] = []
    for mid, score in ranked:
        if score < floor or len(results) >= cap:
            break
        rec = dict(by_id[mid])
        rec["score"] = round(score, 4)
        results.append(rec)
    return results


def graph_stats(vault: Path) -> dict:
    """Concept/pair counts, computed in memory (no persisted graph any more)."""
    memories = _active_lines(vault)
    counts: dict[str, int] = {}
    line_tokens: list[set[str]] = []
    for mem in memories:
        toks = _tokens(mem["line"])
        if not toks:
            continue
        line_tokens.append(toks)
        for token in toks:
            counts[token] = counts.get(token, 0) + 1
    concepts = {t for t, c in counts.items() if c >= MIN_CONCEPT_FREQ}
    pairs: set[tuple[str, str]] = set()
    for toks in line_tokens:
        relevant = sorted(toks & concepts)
        for i, src in enumerate(relevant):
            for dst in relevant[i + 1 : i + 9]:
                left, right = (src, dst) if src < dst else (dst, src)
                pairs.add((left, right))
    return {"nodes": len(concepts), "edges": len(pairs)}
