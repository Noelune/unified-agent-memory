# -*- coding: utf-8 -*-
"""drift_verify — does a provenance-carrying fact still hold in its source?

3B (P0-3). 3A made every digest fact traceable to its session archive; this
module closes the loop: take each ACTIVE canonical fact that carries a
``（溯源：origin）`` group, read the source archive back, and check the fact is
still supported by it. Semantic drift ("iterative summaries diverge from
ground truth, accumulating per cycle") previously had no detector at all: a
fact the digest LLM misread stood as canonical forever and fed every later
retrieval.

Two stages, cheapest first (the taskbook's design):

  1. similarity pre-filter — if NO line of the source reaches
     ``PRE_FILTER_SIM``, nothing in the source could anchor the fact: an
     unsupported candidate, zero LLM cost. The bar is deliberately LOW (same
     0.3 the review overlap uses): a digest fact paraphrases several lines, so
     near-zero overlap is the only safe auto-verdict.
  2. LLM entailment — the redacted source and the fact go to the same chat
     model the digest used, temperature 0, the answer forced to one of
     支持 / 不支持 / 无法判断. Transport failure counts as 无法判断, never as
     a verdict.

Unsupported candidates are REPORTED by default and enqueued ONLY with
``--apply``. A wrong suspect costs one human glance in the adjudication
queue, never a canonical write; the queue entry maps the fact to 新 and the
closest source line to 旧, with 证据 / 溯源 / 疑似漂移 riding as extra JSON
keys both readers keep and both renderers ignore.
"""
from __future__ import annotations

import time
from pathlib import Path

from ...domain.markdown import PROVENANCE_RE, doc_lines, redact
from ...domain.conflict import best_similarity
from ...domain.policy import CANONICAL_DOCS, UNCLASSIFIED_FACT_REL
from ...infra.vault import canonical_dir, canonical_path, read_maybe
from ..govern.queue import append_conflict, read_conflicts
from ..ingest.digest import MAX_INPUT_CHARS, chat_completion

DRIFT_SOURCE = "drift-verify"
PRE_FILTER_SIM = 0.3

VERIFY_SYSTEM_PROMPT = (
    "你是记忆核查助手。判断【事实】是否被【原文】支持（原文是它声称的来源）。"
    "支持＝原文里有与事实等价的说法；不支持＝原文没有与事实等价的内容或与之矛盾；"
    "无法判断＝原文信息不足。只回答其中一个词。"
)

_ORIGINAL_LEN = len("（溯源：")
_TRAILER_LEN = len("）")


def _provenance_facts(vault: Path) -> list[dict]:
    """Active facts carrying a ``（溯源：…）`` group, with doc name and origin.

    未归类事实.md is scanned too: the promoter's ``other`` fallback lands real
    digest facts there, and a drift suspect that hides from the check because
    its classification failed would be the worst kind of blind spot.
    """
    out: list[dict] = []
    targets: list[tuple[str, Path]] = [
        (name, canonical_path(vault, doc_id))
        for doc_id, name in CANONICAL_DOCS.items()
        if doc_id != "index"
    ]
    unclassified = canonical_dir(vault) / UNCLASSIFIED_FACT_REL
    if unclassified.is_file():
        targets.append((UNCLASSIFIED_FACT_REL, unclassified))
    for name, path in targets:
        for status, bare, raw in doc_lines(read_maybe(path)):
            if status != "active":
                continue
            match = PROVENANCE_RE.search(raw)
            if not match:
                continue
            origin = match.group(0)[_ORIGINAL_LEN:-_TRAILER_LEN].strip()
            if origin:
                out.append({"doc": name, "fact": bare, "origin": origin})
    return out


def _best_anchor(fact: str, source: str) -> tuple[float, str]:
    """(best line similarity, that line) — the anchor the fact should match.

    Candidate lines are stripped and at least 4 chars: headings and
    one-character chatter lines are noise, not anchors."""
    lines = (ln.strip() for ln in source.splitlines() if len(ln.strip()) >= 4)
    return best_similarity(fact, lines)


def _entail(fact: str, source: str) -> tuple[str, bool]:
    """(verdict, transport_failed). A transport failure is 无法判断, never
    guessed — the flag lets the scheduler tell "the model could not decide"
    from "the model was never reachable" (the latter must not consume the
    day's stamp)."""
    content = chat_completion(
        [
            {"role": "system", "content": VERIFY_SYSTEM_PROMPT},
            {"role": "user", "content": f"【事实】{fact}\n【原文】{source}"},
        ],
        temperature=0,
        max_tokens=16,
    )
    text = (content or "").strip()
    if "不支持" in text:
        return "不支持", False
    if "无法判断" in text:
        return "无法判断", content is None
    if "支持" in text:
        return "支持", False
    return "无法判断", content is None
def verify_drift(vault: Path, *, apply: bool = False, limit: int = 0) -> dict:
    """Re-check every provenance-carrying fact against its source archive.

    Read-only by default; ``apply`` enqueues the unsupported candidates into
    the adjudication queue (dedup via _signature keeps re-runs idempotent).
    """
    started = time.monotonic()
    facts = _provenance_facts(vault)
    if limit > 0:
        facts = facts[:limit]
    report: dict = {
        "checked": len(facts), "prefiltered": 0, "llmChecked": 0, "llmErrors": 0,
        "supported": 0, "unsupported": 0, "undecidable": 0,
        "skipped": [], "candidates": [], "enqueued": 0, "dryRun": not apply,
    }
    candidates: list[dict] = []
    for item in facts:
        # 3A writes vault-relative origins (the archive lives under
        # 50-Agent-Context/); a hand-edited provenance may drop the prefix, so
        # fall back to the context-relative location before giving up.
        source = read_maybe(vault / item["origin"]) or read_maybe(
            canonical_dir(vault) / item["origin"]
        )
        if not source.strip():
            report["skipped"].append(f"{item['fact'][:40]} (source missing: {item['origin']})")
            continue
        source = redact(source)[-MAX_INPUT_CHARS:]
        sim, anchor = _best_anchor(item["fact"], source)
        if sim < PRE_FILTER_SIM:
            report["prefiltered"] += 1
            verdict = "不支持"
        else:
            report["llmChecked"] += 1
            verdict, transport_failed = _entail(item["fact"], source)
            if transport_failed:
                report["llmErrors"] += 1
        if verdict == "支持":
            report["supported"] += 1
            continue
        entry = {**item, "anchor": anchor, "similarity": round(sim, 3), "verdict": verdict}
        if verdict == "不支持":
            report["unsupported"] += 1
            candidates.append(entry)
        else:
            report["undecidable"] += 1
    report["candidates"] = candidates
    if apply:
        report["enqueued"] = _enqueue_candidates(vault, candidates)
    report["elapsedMs"] = int((time.monotonic() - started) * 1000)
    return report


def _enqueue_candidates(vault: Path, candidates: list[dict]) -> int:
    """Enqueue the unsupported candidates; return the REAL queue growth
    (signature dedup keeps re-runs idempotent)."""
    before = len(read_conflicts(vault))
    for entry in candidates:
        append_conflict(
            vault, entry["fact"], entry["anchor"] or entry["origin"], DRIFT_SOURCE,
            target_file=entry["doc"],
            extra={
                "疑似漂移": "原文不含等价内容",
                "证据": (entry["anchor"] or entry["origin"])[:160],
                "溯源": entry["origin"],
            },
        )
    return len(read_conflicts(vault)) - before
