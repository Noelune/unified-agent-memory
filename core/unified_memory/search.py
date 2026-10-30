# -*- coding: utf-8 -*-
"""search — hybrid retrieval over the memory database.

Three retrieval streams are fused with weighted Reciprocal Rank Fusion (RRF):

  1. Lexical BM25          (index.lexical_search over fts_lex — ASCII words +
                           CJK bigrams, one table for both languages)
  2. Cosine over semantic vectors (embed.vector_search, SiliconFlow)
  3. Entity-graph expansion (graph.py, optional — skipped when the graph is
     empty or disabled)

The batch-A convergence replaced the old five inline streams: unicode61 BM25
returned zero hits on every pure-Chinese query while holding the top weight,
and the trigram/bigram tables overlapped each other, so the same signal voted
twice (RRF's benefit comes from DIVERSE retrievers, not stacked copies).

The fused ranking is then:
  - diversified (at most ``max_per_doc`` results from one canonical note), and
  - formatted under a token/character budget (full / compact / narrative).

Every code path degrades gracefully: with no embedding key the vector stream is
empty and the result is a pure lexical ranking; without a graph it is a
lexical + vector ranking. Nothing here ever raises for provider unavailability.
"""
from __future__ import annotations

from pathlib import Path

from . import graph as graph_mod, index
from .infra.providers import embed
from .domain import envelope
from .domain.markdown import encode_untrusted, redact
from .domain.model import Evidence
from .infra.store import records_for_ids

RRF_K = 60
DEFAULT_WEIGHTS = (1.0, 1.0, 0.9)  # lexical, vector, graph
MAX_PER_DOC = 3

# Abstain floors (batch C1, PLAN.md «弃答与置信度»). RRF scores are rank-based:
# a single-stream rank-0 hit is 1/61 ≈ 0.0164 (lexical or vector) or
# 0.9/61 ≈ 0.0148 (graph only), a double-stream hit ≈ 0.031. ε = 0.016 is
# calibrated on bench/golden_fixture.py: it only suppresses graph-only
# no-support hits and keeps every measured true hit (bench numbers recorded in
# BATCH-REPORT.md batch C1 — abstain 0.75 and recall@10 0.9167 both unchanged;
# the one residual false positive returns byte-identical rows to a true query,
# so no score rule can separate them).
ABSTAIN_TOP_SCORE = 0.016
TAIL_RATIO = 0.25
FORMATS = ("full", "compact", "narrative")


# --------------------------------------------------------------------------
# Fusion
# --------------------------------------------------------------------------


def rrf_fuse(
    streams: list[list[dict]],
    k: int = RRF_K,
    weights: tuple[float, ...] | None = None,
) -> list[tuple[str, float]]:
    """Weighted RRF over ranked lists of memory records.

    A record appearing in several streams accumulates contributions from each,
    which acts as a natural multi-stream agreement bonus.
    """
    weights = weights or DEFAULT_WEIGHTS
    scores: dict[str, float] = {}
    for stream, items in enumerate(streams):
        if not items:
            continue
        w = weights[stream] if stream < len(weights) else 1.0
        for rank, item in enumerate(items):
            mid = item.get("id")
            if not mid:
                continue
            scores[mid] = scores.get(mid, 0.0) + w * (1.0 / (k + rank + 1))
    return sorted(scores.items(), key=lambda pair: pair[1], reverse=True)


# --------------------------------------------------------------------------
# Hybrid retrieval
# --------------------------------------------------------------------------


def _streams(vault: Path, query: str, pool: int) -> tuple[list[dict], list[dict], list[dict]]:
    """Collect the lexical, vector and graph streams.

    Retrieval never calls the embedding provider. It refreshes the keyword index
    (a local, incremental scan) and ranks with whatever vectors already exist;
    ``memory sync`` is what fills the gaps. The trade-off is deliberate: a
    search issued right after a write ranks the new line lexically until the
    next sync, in exchange for recall latency that does not depend on a remote
    API. Vector top-up used to live in hybrid_search: on a changed vault it
    fired up to 64 provider calls inside a single search (measured 117 / 256 /
    526 ms across three runs), so it moved to ``memory sync``; a search that
    finds stale vectors still returns results — it just ranks without the
    newest lines until the next sync.
    """
    lexical = index.lexical_search(vault, query, limit=pool)
    vec: list[dict] = []
    query_vec = embed.embed_query_cached(vault, query)
    if query_vec is not None:
        vec = embed.vector_search(vault, query_vec, limit=pool)
    graph: list[dict] = []
    try:
        graph = graph_mod.expand_search(vault, query, limit=pool)
    except Exception:  # noqa: BLE001 — graph is optional, never fatal
        graph = []
    return lexical, vec, graph


def _diversify(fused: list[tuple[str, float]], doc_by_id: dict[str, str], limit: int) -> list[tuple[str, float]]:
    """RRF order with at most MAX_PER_DOC hits from one note."""
    seen_docs: dict[str, int] = {}
    selected: list[tuple[str, float]] = []
    for mid, score in fused:
        doc = doc_by_id.get(mid, "")
        if seen_docs.get(doc, 0) >= MAX_PER_DOC:
            continue
        seen_docs[doc] = seen_docs.get(doc, 0) + 1
        selected.append((mid, score))
        if len(selected) >= limit:
            break
    return selected


def _apply_confidence_floor(selected: list[tuple[str, float]]) -> tuple[list[tuple[str, float]], bool]:
    """Apply the abstain floors to the diversified selection.

    Returns (kept, abstained). The absolute floor drops the whole set when the
    top RRF score is below ABSTAIN_TOP_SCORE (nothing better than noise); the
    relative floor drops the tail below TAIL_RATIO × top (weak followers).
    """
    if not selected:
        return selected, False
    top = selected[0][1]
    if top < ABSTAIN_TOP_SCORE:
        return [], True
    return [pair for pair in selected if pair[1] >= TAIL_RATIO * top], False


def _result_records(vault: Path, selected: list[tuple[str, float]]) -> list[dict]:
    """Assemble redacted full records for the selected ids."""
    records = _records_for(vault, [mid for mid, _ in selected])
    by_id = {r["id"]: r for r in records}
    results: list[dict] = []
    for mid, score in selected:
        rec = by_id.get(mid)
        if not rec:
            continue
        results.append(
            {
                "id": rec["id"],
                "doc": redact(Path(rec["doc"]).name),
                "title": redact(Path(rec["doc"]).stem),
                "line": redact(rec["line"]),
                "type": rec["type"],
                "importance": rec["importance"],
                "score": round(score, 4),
                "source_agent": rec.get("source_agent", ""),
            }
        )
    return results


def hybrid_search(
    vault: Path,
    query: str,
    limit: int = 8,
    format_: str = "full",
    budget: int | None = None,
) -> dict:
    """Fuse lexical + vector + graph into a diversified, budget-capped
    result set.

    Returns {"ok", "query", "count", "confidence", "results", "streams"} where
    each result carries doc/line/type/importance/score and is already
    redacted. ``confidence`` is "low" when the abstain floor suppressed the
    candidates (see _apply_confidence_floor), "high" otherwise.

    Retrieval never calls the embedding provider. It refreshes the keyword index
    (a local, incremental scan) and ranks with whatever vectors already exist;
    ``memory sync`` is what fills the gaps. The trade-off is deliberate: a
    search issued right after a write ranks the new line lexically until the
    next sync, in exchange for recall latency that does not depend on a remote
    API. See _streams for the measurements behind that choice.
    """
    index.update_index(vault)  # incremental, self-healing derived db
    query = query.strip()
    pool = max(limit * 3, 20)

    lexical, vec, graph = _streams(vault, query, pool)
    fused = rrf_fuse([lexical, vec, graph])
    selected = _diversify(fused, _doc_map(lexical, vec, graph), limit)
    selected, abstained = _apply_confidence_floor(selected)
    results = _result_records(vault, selected)

    # Optional budget/format post-processing.
    results, budget_stats = _format_results(results, format_=format_, budget=budget)

    # Reinforcement: reading is a use.
    if selected:
        index.record_access(vault, [mid for mid, _ in selected])

    payload = {
        "ok": True,
        "query": query,
        "count": len(results),
        "confidence": "low" if abstained else "high",
        "results": results,
        "streams": {
            "lexical": len(lexical),
            "vector": len(vec),
            "graph": len(graph),
        },
    }
    if budget_stats is not None:
        payload["budget"] = budget_stats
    return payload


def _doc_map(*streams: list[dict]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for stream in streams:
        for item in stream:
            if item.get("id") and item.get("doc"):
                mapping.setdefault(item["id"], item["doc"])
    return mapping


def _records_for(vault: Path, ids: list[str]) -> list[dict]:
    if not ids:
        return []
    return records_for_ids(vault, ids)


# --------------------------------------------------------------------------
# Budget/format
# --------------------------------------------------------------------------


def estimate_tokens(text: str) -> int:
    """Rough token count: 1 per CJK char, 1 per 4 non-CJK chars.

    The previous budget check multiplied the token budget by four, which
    counted a Chinese line of 40 characters as 10 tokens instead of ~40 and
    let the output overshoot the caller's budget by 4×.
    """
    cjk = 0
    other = 0
    for char in text or "":
        if "\u3400" <= char <= "\u9fff":
            cjk += 1
        else:
            other += 1
    return cjk + (other + 3) // 4


def _format_results(
    results: list[dict], format_: str, budget: int | None
) -> tuple[list[dict], dict | None]:
    """Format under an optional token budget. Returns (results, budget_stats).

    The budgeted fill replaced the arrival-order truncation, which stopped at
    the FIRST item that did not fit — one 200-token line starved every short
    high-value fact behind it. Fill is now greedy by value density
    (score per estimated token) with skip-and-continue: an item that does not
    fit is dropped and packing continues. Final order places the best result
    first and the second best last (Lost in the Middle, arXiv:2307.03172 —
    long-context attention is U-shaped), so the two strongest facts sit in
    the positions models actually read.
    """
    if format_ not in FORMATS:
        format_ = "full"
    truncated_any = False
    if format_ == "compact":
        for r in results:
            if len(r["line"]) > 80:
                r["line"] = r["line"][:77] + "…"
                r["truncated"] = True
                truncated_any = True
    # narrative: keep lines as-is (callers may join them); full: as-is.
    if not budget:
        return results, None

    scored = [
        (r, r["score"] / max(1, estimate_tokens(r["line"]))) for r in results
    ]
    scored.sort(key=lambda pair: pair[1], reverse=True)
    used = 0
    kept: list[dict] = []
    dropped = 0
    for r, _density in scored:
        cost = estimate_tokens(r["line"]) + 4  # doc/type/score overhead
        if used + cost > budget:
            dropped += 1
            continue
        used += cost
        kept.append(r)
    kept.sort(key=lambda r: r["score"], reverse=True)
    if len(kept) >= 3:
        kept = [kept[0], *kept[2:], kept[1]]
    return kept, {"usedTokens": used, "dropped": dropped, "truncated": truncated_any}


# --------------------------------------------------------------------------
# CLI helper: render the hybrid result set through the DATA envelope
# --------------------------------------------------------------------------


def render_hybrid(results: list[dict], query: str) -> str:
    """Render hybrid results as one fenced block, from the Evidence view.

    The ``[short]`` prefix on each fact is the citation hook: when the model
    echoes it in a later turn, the host reports a ``used`` event — the only
    event the forgetter rewards (batch A).
    """
    evidences = [
        Evidence(
            claim_id=str(r.get("id", "")),
            doc=str(r.get("doc", "")),
            line=str(r.get("line", "")),
            type=str(r.get("type", "")),
            importance=r.get("importance"),
        )
        for r in results
    ]
    if not evidences:
        body = envelope.NO_MATCHES + "\n"
    else:
        body = ""
        for ev in evidences:
            body += f"doc: {encode_untrusted(redact(ev.doc))}\n"
            body += f"  {envelope.cite_prefix(ev.claim_id)}- {encode_untrusted(redact(ev.line))}\n"
            if ev.type and ev.type != "other":
                body += f"  (type: {encode_untrusted(ev.type)}, importance: {ev.importance})\n"
    return envelope.data_block(envelope.BANNER_SHARED_DB, body)
