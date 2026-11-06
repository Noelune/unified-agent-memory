# -*- coding: utf-8 -*-
"""decide — rule on one queued conflict (用新 / 保留旧 / 并存 / 跳过).

`decide` is the single entry point the CLI, the panel and `adjudicate` share;
it edits the canonical note, writes the adjudication log and archives the
source submission once every fact in it has been ruled on. The interactive
`adjudicate` loop is thin by design — the decision logic must not live in a
prompt.

Split out of promoter.py in B5.4.
"""
from __future__ import annotations

import time
from pathlib import Path

from ...domain import state as domain_state
from ...domain.facts import _comparable, active_fact_lines, append_active_facts, move_to_superseded
from ...domain.markdown import bare_fact_line, claim_id_of, fact_lines, redact, write_stamp
from ...domain.policy import ADJUDICATED_FILE, CONFLICT_FILE
from ...infra.lock import file_lock
from ...infra.store import get_conn, record_audit
from ...infra.store.ledger import new_claim_id, record_supersedence, refresh_doc
from ...infra.vault import atomic_write, canonical_dir, read_maybe, situation_dir
from .promote import _resolve_target, archive_sources
from .queue import read_conflicts, record_adjudication, remove_conflict
from .review import _adjudicated_facts


# The four decisions, and what each one does to memory. The ORDER matters to
# interactive surfaces; the SET is pinned to the CONFLICT state machine's legal
# events by a consistency test (core/tests/test_state.py).
DECISIONS = ("用新", "保留旧", "并存", "跳过")


# The three that mean something as a RECOMMENDATION. `跳过` is a way to defer a
# row, not a claim about which side is true, so an agent advising it would be
# saying nothing — `advise` refuses it.
ADVISABLE = ("用新", "保留旧", "并存")


# The label a person reads. The panel offers the first three as buttons;
# `跳过` has no button, because a queue you can defer row by row never empties
# — the entry simply stays and comes back on the next read.
DECISION_LABELS = {
    "用新": "取代",
    "保留旧": "保留旧",
    "并存": "共存",
    "跳过": "跳过",
}


def archive_settled_source(vault: Path, entry: dict, *, locked: bool = False) -> None:
    """Move a submission out of the inbox once every fact in it has been ruled on.

    `decide` used to leave the source file in ``Agent提交区`` forever. The
    conflict left the queue, so nothing was pending — but the submission stayed,
    `doctor` kept counting it as inbox work, and the panel's queue looked quiet
    while the counts disagreed. Archiving only ever happened inside the
    vault-wide passes (`apply_pending`, `accept`, `auto_promote`), which handle
    a whole file and can therefore archive it without losing anything.

    One ruling is not the whole file: a submission may carry facts nobody has
    decided yet, and archiving it here would drop them silently. So the file is
    archived ONLY when every fact line in it now appears in the adjudication log
    — the removal then loses nothing. Anything else stays exactly where it is,
    and the next ``review --apply`` still picks it up, so the worst case is the
    old behaviour rather than a lost submission.
    """
    source = str(entry.get("来源", "") or "").strip()
    if not source:
        return
    # `来源` is a bare file name (review() records `src.name`); anything that
    # carries a path is not one of ours and is left alone.
    if Path(source).name != source:
        return
    src = canonical_dir(vault) / "Agent提交区" / source
    if not src.is_file():
        return
    facts = {
        bare_fact_line(f"- {redact(fact)}")
        for fact in fact_lines(read_maybe(src))
    }
    facts.discard("")
    if not facts:
        # Nothing parseable to have decided — not ours to clear.
        return
    if not facts <= _adjudicated_facts(vault):
        return
    archive_sources(vault, {source}, locked=locked)


def _record_decision_audit(vault: Path, entry: dict, choice: str, why: str) -> None:
    """The audit row both decide branches append (identical shape)."""
    record_audit(
        vault, "adjudicator", "decide:" + choice,
        str(entry.get("新", ""))[:120], why[:200],
    )


def _apply_replace(vault: Path, entry: dict, choice: str, why: str) -> dict:
    """``用新`` / ``并存``: rewrite the canonical note and dequeue under one lock."""
    target = _resolve_target(vault, entry)
    with file_lock(vault):
        existing = read_maybe(target)
        # A JSON entry stores `旧` already bare; a hand-written block stores
        # the whole markdown line, stamp and bullet included. Normalize both
        # before comparing, or 用新 finds nothing to remove on the block
        # shape and quietly appends the new fact beside the old one.
        raw_old = str(entry.get("旧", "")).strip()
        old = _comparable(raw_old) if raw_old else ""
        old_claim_id = ""
        if choice == "用新" and old:
            # Batch D: the replaced line carries its claim id in the vault
            # text — read it before the move so the ledger can close the
            # old claim's validity window.
            for ln in existing.splitlines():
                if _comparable(ln) == old and claim_id_of(ln):
                    old_claim_id = claim_id_of(ln)
                    break
            # Retire, do not delete: `promote` has always moved the old line
            # under 已取代 (via _move_to_superseded), and this path deleted
            # it outright — so the note claimed the old value had never
            # existed and the only record of it was the adjudication log.
            # Two writers of the same fact, two different meanings.
            existing = move_to_superseded(existing, lambda ln: _comparable(ln) == old)
        new = entry.get("新", "").strip()
        prior = active_fact_lines(existing)
        fresh_claim_id = ""
        if new and new not in prior:
            # Batch D: the incoming fact is born with its permanent block id.
            fresh_claim_id = new_claim_id()
            existing = append_active_facts(
                existing,
                [f"- {new}{write_stamp(entry.get('来源', 'inbox'))} ^c-{fresh_claim_id}"],
            )
        atomic_write(target, existing)
        record_adjudication(vault, entry, choice, why=why, locked=True)
        remove_conflict(vault, entry, locked=True)
        archive_settled_source(vault, entry, locked=True)
        _record_decision_audit(vault, entry, choice, why)
        # Batch D: the ledger projection follows the write — the new claim's
        # row, and (for 用新) the closed window + supersedes link + event.
        conn = get_conn(vault)
        try:
            refresh_doc(conn, vault, target)
            if old_claim_id or fresh_claim_id:
                record_supersedence(
                    conn, old_claim_id, fresh_claim_id,
                    actor="adjudicator",
                    decided_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
                )
            conn.commit()
        finally:
            conn.close()
    return {
        "ok": True, "reason": None, "choice": choice, "applied": True,
        "target": str(target.relative_to(vault)) if target.is_relative_to(vault) else str(target),
    }


def _record_only(vault: Path, entry: dict, choice: str, why: str) -> dict:
    """``保留旧`` / ``跳过``: record and dequeue under one lock.

    Canonical notes are not touched; recording and dequeuing happen together so
    another process cannot observe a half-resolved conflict.
    """
    with file_lock(vault):
        record_adjudication(vault, entry, choice, why=why, locked=True)
        remove_conflict(vault, entry, locked=True)
        archive_settled_source(vault, entry, locked=True)
        _record_decision_audit(vault, entry, choice, why)
    return {"ok": True, "reason": None, "choice": choice, "applied": False,
            "target": None}


def decide(vault: Path, entry: dict, choice: str, why: str = "") -> dict:
    """Resolve ONE pending conflict.

    The single-decision API behind both the interactive CLI and the panel's
    buttons, extracted from `adjudicate`'s loop body so the two surfaces cannot
    drift: a decision means the same thing however it was reached. The canonical
    write and the dequeue happen under ONE lock, so another process never
    observes the conflict as half-resolved (recorded but still queued, or
    dequeued but not applied).

    `why` is the reason, in the decider's own words. It lands in the
    adjudication log beside the verdict, because a log of bare verdicts cannot
    be reviewed: six months later `并存` with no reason is indistinguishable
    from `并存` by accident, and the next reader has to redo the analysis to
    find out whether it was ever right.

    `用新` retires the losing line into the note's 已取代 section rather than
    deleting it — see `move_to_superseded`. And a submission whose every fact
    has now been ruled on is archived out of the inbox by
    `archive_settled_source`.

    Refuses an unknown choice rather than defaulting to 跳过. The CLI's
    `input()` treats a typo as "skip", which is recoverable when a person is
    watching the prompt; a panel button that silently did nothing would just
    look broken.
    """
    try:
        # The CONFLICT state machine owns this validation: "open" accepts
        # exactly the four rulings, anything else is an illegal transition.
        domain_state.transition("conflict", "open", choice)
    except ValueError:
        return {"ok": False, "reason": "unknown-choice", "choice": choice,
                "applied": False, "target": None}

    if choice in ("用新", "并存"):
        return _apply_replace(vault, entry, choice, why)
    return _record_only(vault, entry, choice, why)


def adjudicate(vault: Path) -> None:
    conflicts = read_conflicts(vault)
    if not conflicts:
        print("no pending conflicts — nothing to adjudicate")
        return
    # Oldest first: a long queue must not bury the conflict that has waited
    # longest. The timestamp is a plain sortable "YYYY-MM-DD HH:MM" string.
    conflicts.sort(key=lambda entry: str(entry.get("at", "")))
    print(f"{len(conflicts)} conflict(s) in {CONFLICT_FILE}:")
    for i, entry in enumerate(conflicts, 1):
        print(f"\n--- conflict {i} ---")
        print(f"  new: {entry.get('新', '')}")
        print(f"  old: {entry.get('旧', '')}")
        print(f"  src: {entry.get('来源', '')}")
        if entry.get("目标"):
            print(f"  doc: {entry.get('目标')}")
        choice = input("decision [用新/保留旧/并存/跳过] (default 跳过): ").strip() or "跳过"
        result = decide(vault, entry, choice)
        if result["ok"]:
            continue
        print(f"  unknown choice {choice!r} — treated as 跳过")
        decide(vault, entry, "跳过")
    print("\nadjudication recorded in " + str(situation_dir(vault) / ADJUDICATED_FILE))
