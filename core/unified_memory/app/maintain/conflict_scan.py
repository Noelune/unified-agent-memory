# -*- coding: utf-8 -*-
"""conflict_scan — read-only cross-document contradiction sweep.

Promotion compares a NEW fact only against the active lines of its target note
(``app/govern/review.py``). Two contradictory facts that are both already in
the vault are therefore never compared again. This module re-scans canonical
notes with the very same rules and queues what it finds. It never edits
canonical notes; ``--apply`` only appends to the adjudication queue.
"""
from __future__ import annotations

import time
from collections import defaultdict
from pathlib import Path

from ...domain.conflict import classify_against, subject_of
from ...domain.facts import active_fact_lines
from ...domain.policy import CANONICAL_DOCS
from ...infra.store import lexical_search
from ...infra.store.claims import forget_stats
from ...infra.vault import canonical_path, read_maybe
from ..govern.queue import append_conflict, read_conflicts

MAX_GROUP_PAIRS = 200
RECALL_LIMIT = 20
SCAN_SOURCE = "conflict-scan"
PROPAGATION_SOURCE = "supersede-scan"

# One item is (document file name, active fact text).
Item = tuple[str, str]


def _active_items(vault: Path) -> list[Item]:
    """Active facts from every canonical note but the index (see plan_repair)."""
    items: list[Item] = []
    for doc_id, name in CANONICAL_DOCS.items():
        if doc_id == "index":
            continue
        text = read_maybe(canonical_path(vault, doc_id))
        for fact in active_fact_lines(text, drop_examples=True):
            items.append((name, fact))
    return items


def _group(items: list[Item]) -> tuple[dict[str, list[Item]], list[Item]]:
    groups: dict[str, list[Item]] = defaultdict(list)
    headless: list[Item] = []
    for item in items:
        head = subject_of(item[1])
        (groups[head] if head else headless).append(item)
    return groups, headless


def _contradicts(a: Item, b: Item) -> bool:
    """The same rules promotion uses, applied to two stored facts."""
    if a[1] == b[1] or a[0] == b[0]:
        return False
    status, _ = classify_against(a[1], [b[1]])
    return status == "conflict"


def _hit(a: Item, b: Item) -> dict:
    return {"new": a[1], "old": b[1], "doc": a[0], "crossDoc": b[0]}


def _group_hits(groups: dict[str, list[Item]], warnings: list[str]) -> tuple[list[dict], int]:
    hits: list[dict] = []
    pairs = 0
    for head, items in groups.items():
        total = len(items) * (len(items) - 1) // 2
        if not total:
            continue
        if total > MAX_GROUP_PAIRS:
            warnings.append(f"subject {head!r}: scanned first {MAX_GROUP_PAIRS} of {total} pairs")
        budget = min(total, MAX_GROUP_PAIRS)
        done = 0
        for i in range(len(items)):
            if done >= budget:
                break
            for j in range(i + 1, len(items)):
                if done >= budget:
                    break
                done += 1
                pairs += 1
                if _contradicts(items[i], items[j]):
                    hits.append(_hit(items[i], items[j]))
    return hits, pairs


def _headless_hits(vault: Path, headless: list[Item]) -> tuple[list[dict], int]:
    """Facts with no recognisable subject fall back to lexical recall."""
    hits: list[dict] = []
    pairs = 0
    seen: set[tuple[str, str]] = set()
    for doc, fact in headless:
        try:
            rows = lexical_search(vault, fact, limit=RECALL_LIMIT)
        except Exception:  # noqa: BLE001 — a broken stream must not stop the sweep
            rows = []
        for row in rows:
            other = str(row.get("line", ""))
            other_doc = Path(str(row.get("doc", ""))).name
            if not other or other == fact:
                continue
            key = tuple(sorted((fact, other)))
            if key in seen:
                continue
            seen.add(key)
            pairs += 1
            if _contradicts((doc, fact), (other_doc, other)):
                hits.append(_hit((doc, fact), (other_doc, other)))
    return hits, pairs


def scan_propagation(
    vault: Path,
    old_bare: str,
    *,
    exclude: tuple[str, ...] = (),
    old_doc: str = "",
) -> list[dict]:
    """Active facts that still carry the superseded value's meaning (P1-3).

    Supersession closes one claim's window; it never asks who ELSE still
    believes the old value — a paraphrase promoted earlier keeps participating
    in retrieval under the old meaning (taskbook: experience-following
    propagates stored errors). The sweep turns the superseded line into the
    seed and applies the very same rule the promoter applies between two
    stored facts: ``classify_against`` reads a suspect as "conflict" — same
    subject (when both sides have one), similar, different wording.

    ``exclude`` names the just-written replacement so the sweep does not flag
    its own successor. Hits are sorted by ``used``-event count DESCENDING so
    enqueueing in order puts the most-cited lines at the top of the queue;
    ``old_doc`` (the doc the superseded line lived in) becomes the 跨文档
    field when the candidate sits in another note. Read-only: nothing here
    writes the vault or the queue.
    """
    if not old_bare:
        return []
    suspects: list[dict] = []
    for doc, line in _active_items(vault):
        if line == old_bare or line in exclude:
            continue
        status, _hit = classify_against(line, [old_bare])
        if status != "conflict":
            continue
        stats = forget_stats(vault, doc, line)
        suspects.append({
            "new": line,
            "old": old_bare,
            "doc": doc,
            "crossDoc": old_doc if old_doc and old_doc != doc else "",
            "used": stats[1] if stats else 0,
        })
    suspects.sort(key=lambda hit: (-hit["used"], hit["doc"], hit["new"]))
    return suspects


def scan_conflicts(vault: Path, *, dry_run: bool = True) -> dict:
    """Re-scan stored facts for contradictions; ``dry_run`` writes nothing.

    The report is deterministic: pairs are visited in canonical-document order
    and each hit keeps that order, so ``_signature`` de-duplicates re-runs.
    """
    started = time.monotonic()
    groups, headless = _group(_active_items(vault))
    warnings: list[str] = []
    hits, pairs = _group_hits(groups, warnings)
    headless_hits, headless_pairs = _headless_hits(vault, headless)
    hits += headless_hits
    pairs += headless_pairs

    before = len(read_conflicts(vault))
    if not dry_run:
        for hit in hits:
            append_conflict(
                vault, hit["new"], hit["old"], SCAN_SOURCE,
                target_file=hit["doc"], cross_doc=hit["crossDoc"],
            )
    after = len(read_conflicts(vault))
    return {
        "dryRun": dry_run,
        "groups": len(groups),
        "headless": len(headless),
        "candidatePairs": pairs,
        "hits": hits,
        "newConflicts": len(hits) if dry_run else after - before,
        "elapsedMs": int((time.monotonic() - started) * 1000),
        "warnings": warnings,
    }
