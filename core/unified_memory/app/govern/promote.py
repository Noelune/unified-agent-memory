# -*- coding: utf-8 -*-
"""promote — execute the pending list against the canonical notes.

`plan_promotion` is the read-only half (it returns a ChangeSet, so `preview`
can show what would happen); `promote` applies it, `archive_sources` retires
the submissions it consumed, and `apply_pending` / `accept` / `auto_promote`
are the three ways a caller picks which entries to run.

Split out of promoter.py in B5.4.
"""
from __future__ import annotations

import shutil
import time
from pathlib import Path

from ...domain import state as domain_state
from ...domain.facts import _move_to_superseded, active_fact_lines, append_active_facts
from ...domain.markdown import bare_fact_line, write_provenance, write_stamp
from ...domain.model import Change, ChangeSet
from ...domain.policy import CANONICAL_DOCS, CONFLICT_FILE, NON_SUBMISSION_FILES, SUBMISSION_DIR
from ...infra import vault as vault_mod
from ...infra.lock import file_lock
from ...infra.schedule import mark_schedule_run
from ...infra.store import get_conn, record_audit, update_index
from ...infra.store.ledger import (
    claim_id_for_text,
    new_claim_id,
    record_supersedence,
    refresh_doc,
)
from ...infra.vault import canonical_dir, canonical_path, processed_dir, read_maybe
from ..maintain.conflict_scan import PROPAGATION_SOURCE, scan_propagation
from .queue import append_conflict
from .review import classify, parse_pending_list, pending_sources, review, target_path


def _plan_group(
    vault: Path,
    target: Path,
    group: list[dict],
    today: str,
) -> Change | None:
    """Plan one target note's changes from its pending entries."""
    existing = read_maybe(target)
    if existing and not existing.endswith("\n"):
        existing += "\n"
    # Active facts only: a value that was retired to the history section is
    # not a duplicate of itself, so a genuine revert can be re-promoted.
    prior = set(active_fact_lines(existing))
    additions: list[str] = []
    supersedes: list[str] = []
    pairs: list[tuple[str, str, str]] = []
    facts: list[tuple[str, str]] = []
    for entry in group:
        fact = entry.get("内容") or entry.get("fact") or ""
        # Compare bare fact text on both sides — the previous version
        # compared a bullet-prefixed "bare" against bullet-stripped prior
        # lines, so this guard never fired.
        bare = bare_fact_line(f"- {fact}")
        if not bare or bare in prior:
            continue
        src = entry.get("来源") or entry.get("source") or "inbox"
        # 3A provenance (P0-3): digest-sourced entries carry the session
        # archive they were distilled from; it rides the fact line for good.
        origin = entry.get("溯源") or entry.get("provenance") or ""
        # Batch D: every promoted fact is born with its permanent block id
        # (PLAN §4.1 — the id is generated once, 改文字不改 ID).
        claim_id = new_claim_id()
        line = f"- {fact}{write_stamp(src, today)}{write_provenance(origin)} ^c-{claim_id}\n"
        additions.append(line)
        facts.append((src, fact))
        prior.add(bare)
        old_bare = entry.get("取代") or entry.get("supersede") or ""
        if old_bare:
            supersedes.append(old_bare)
            pairs.append((old_bare, claim_id, fact))
    if not additions:
        return None
    text = append_active_facts(existing, additions)
    # Supersession: move old fact lines under 已取代 (keeps history). The
    # CLAIM table is the contract for that move (batch B5) — the event is
    # legal by definition, and the call pins the plan to the tables.
    for old_bare in supersedes:
        domain_state.transition("claim", "active", "superseded")
        text = _move_to_superseded(text, old_bare)
    return Change(
        op="rewrite_doc", doc=target,
        before_text=existing, after_text=text,
        facts=tuple(facts),
        meta={"kind": "promotion", "pairs": pairs},
    )


def plan_promotion(vault: Path, entries: list[dict]) -> ChangeSet:
    """Read-only: build the ChangeSet promote() would apply.

    The dedup re-check that used to run inside the file lock runs here against
    the current file content; ``infra.vault.apply`` re-validates under the lock
    and re-runs this plan if anything moved while it was being built (the
    ``replan`` callback).
    """
    grouped: dict[Path, list[dict]] = {}
    for entry in entries:
        doc = entry.get("分类") or entry.get("doc") or "other"
        grouped.setdefault(target_path(vault, doc), []).append(entry)

    changes: list[Change] = []
    today = time.strftime("%Y-%m-%d")
    for target, group in grouped.items():
        change = _plan_group(vault, target, group, today)
        if change is not None:
            changes.append(change)
    return ChangeSet(
        actor="promoter", reason="promote", changes=tuple(changes),
        replan=lambda: plan_promotion(vault, entries),
    )


def promote(vault: Path, entries: list[dict], *, locked: bool = False) -> list[str]:
    """Plan the promotion, then hand the ChangeSet to the one executor.

    Accepts entries from either source: `apply_pending` (parsed pending list,
    keys `分类`/`内容`/`来源`/`取代`) or `auto_promote` (raw review output, keys
    `doc`/`fact`/`source`/`supersede`). Missing keys fall back to "other"/""/"inbox".

    Entries are grouped per target note and written once per note. The old
    loop rewrote the whole file for every fact, which on a synced vault meant
    one cloud-sync event per fact (and O(facts × file size) writes).

    ``locked=True`` is for callers that already hold the vault lock and wrap
    more steps around this one (auto_promote adds archiving); the executor
    then runs without re-acquiring the non-reentrant lock.
    """
    changeset = plan_promotion(vault, entries)
    applied = vault_mod.apply(vault, changeset, take_lock=not locked)
    promoted: list[str] = []
    audited: list[tuple[str, str, str]] = []
    today = time.strftime("%Y-%m-%d")
    for change in applied.changes:
        for src, fact in change.facts:
            promoted.append(f"- {fact}{write_stamp(src, today)}")
            audited.append((src, change.doc.name, fact))
    # Audit AFTER the writes: record_audit opens its own connection, and the
    # file writes above hold no database transaction, so chaining is safe.
    for src, doc_name, fact in audited:
        record_audit(vault, src, "promote", doc_name, fact[:200])
    # Batch D: refresh the ledger projection for the touched notes and close
    # the superseded claims' validity windows (the pairing rode in the
    # ChangeSet meta, because only the planner knows old-bare → new-id).
    superseded = _ledger_supersedence(vault, applied, today)
    # P1-3 propagation sweep (read-only scan → queue-only write): after the
    # windows closed, find active facts still carrying the old value's
    # meaning and hand them to adjudication. ``locked`` mirrors this call's
    # own lock state — apply_pending/auto_promote hold the vault lock
    # across promote(), and the queue's file_lock is not reentrant.
    _enqueue_propagation(vault, superseded, locked=locked)
    return promoted


def _ledger_supersedence(vault: Path, applied, today: str) -> list[tuple[str, str, str, str]]:
    """Close superseded windows on the ledger; return the (old, new-id, new,
    doc) tuples the propagation sweep needs. Batch D extraction."""
    superseded: list[tuple[str, str, str, str]] = []
    if not applied.changes:
        return superseded
    conn = get_conn(vault)
    try:
        for change in applied.changes:
            meta = change.meta or {}
            refresh_doc(conn, vault, Path(change.doc))
            if meta.get("kind") != "promotion":
                continue
            for old_bare, new_id, new_fact in meta.get("pairs", []):
                old_id = claim_id_for_text(conn, old_bare)
                if old_id:
                    record_supersedence(
                        conn, old_id, new_id, actor="promoter", decided_at=today
                    )
                superseded.append((old_bare, new_id, new_fact, Path(change.doc).name))
        conn.commit()
    finally:
        conn.close()
    return superseded


def _enqueue_propagation(vault: Path, superseded: list[tuple[str, str, str, str]], *, locked: bool) -> None:
    """Hand the old value's remaining carriers to adjudication (P1-3)."""
    for old_bare, new_id, new_fact, doc_name in superseded:
        for hit in scan_propagation(vault, old_bare, exclude=(new_fact,), old_doc=doc_name):
            append_conflict(
                vault, hit["new"], hit["old"], PROPAGATION_SOURCE,
                target_file=hit["doc"], cross_doc=hit["crossDoc"],
                extra={"疑似旧值复述": new_id}, locked=locked,
            )


def _refresh_index(vault: Path) -> None:
    """Re-index after a canonical write so recall sees the new facts at once.

    Retrieval used to do this itself, bundled with a vector top-up, which put up
    to 64 provider calls inside a single search. Moving it here keeps the cost
    on the write path (11–26 ms measured) instead of on every turn's recall.
    A failure here must never undo a write that already succeeded.
    """
    try:
        update_index(vault)
    except Exception:  # noqa: BLE001 — the canonical write is already durable
        pass


def archive_sources(vault: Path, sources: set[str], *, locked: bool = False) -> None:
    if not locked:
        with file_lock(vault):
            archive_sources(vault, sources, locked=True)
        return
    done = processed_dir(vault)
    done.mkdir(parents=True, exist_ok=True)
    inbox = canonical_dir(vault) / "Agent提交区"
    for name in sorted(sources):
        candidate = Path(name)
        if candidate.name != name or candidate.suffix.lower() != ".md" or name in NON_SUBMISSION_FILES:
            continue
        src = inbox / candidate.name
        if not src.is_file():
            continue
        target = done / candidate.name
        for suffix in range(2, 1000):
            if not target.exists():
                break
            target = done / f"{candidate.stem}-{suffix}{candidate.suffix}"
        else:
            raise RuntimeError(f"could not allocate an archive path for {candidate.name}")
        shutil.move(str(src), str(target))


def apply_pending(vault: Path, verbose: bool = True) -> int:
    with file_lock(vault):
        # Parse and promote under the same lock so a concurrent apply can never
        # archive a pending-list snapshot that has already been superseded.
        entries = parse_pending_list(vault)
        sources = pending_sources(vault, entries)
        promoted = promote(vault, entries, locked=True)
        archive_sources(vault, sources, locked=True)
    _refresh_index(vault)
    # A completed apply counts as today's promotion run for catch-up purposes,
    # no matter which entry point fired it (CLI, OS cron, dsh plugin).
    mark_schedule_run(vault, "promote")
    if not entries:
        if verbose:
            print("pending list is empty — reviewed inbox files archived")
        return 0
    if verbose:
        print(f"applied {len(promoted)} fact(s) to canonical notes")
        for line in promoted:
            print(f"  + {line[:100]}")
        print("inbox files archived to 已处理/")
    return len(promoted)


def accept(vault: Path, name: str) -> dict:
    """Promote ONE submission, and retire only that file.

    The panel's 待确认 queue asks a yes/no question per row, so it needs a yes.
    `apply_pending` cannot be it: it executes the whole pending-list snapshot and
    archives every source that produced it, so a per-row button wired to `--apply`
    would accept the other rows too while looking like it accepted one.

    A submission whose facts conflict with memory is NOT promoted and NOT
    archived: the conflict needs a human ruling first (adjudicate), and moving
    the file into 已处理/ would make "waiting for your ruling" indistinguishable
    from "handled". The conflict entries are still queued, so nothing is lost.

    Returns a result dict rather than raising: every refusal here is a business
    answer the panel has to render (which file, why), not a crash.
    """
    submission = canonical_dir(vault) / SUBMISSION_DIR / name
    if Path(name).name != name or not name.lower().endswith(".md"):
        return {"ok": False, "name": name, "reason": "invalid-name",
                "promoted": 0, "duplicates": 0, "conflicts": 0}
    if name in NON_SUBMISSION_FILES:
        return {"ok": False, "name": name, "reason": "not-a-submission",
                "promoted": 0, "duplicates": 0, "conflicts": 0}
    if not submission.is_file():
        return {"ok": False, "name": name, "reason": "not-found",
                "promoted": 0, "duplicates": 0, "conflicts": 0}

    result = review(vault, verbose=False, only={name})
    if result["conflicts"]:
        return {"ok": False, "name": name, "reason": "conflicts",
                "promoted": 0, "duplicates": result["duplicates"],
                "conflicts": result["conflicts"]}

    with file_lock(vault):
        promoted = promote(vault, result["pending"], locked=True)
        archive_sources(vault, {name}, locked=True)
    _refresh_index(vault)
    return {"ok": True, "name": name, "reason": None,
            "promoted": len(promoted), "duplicates": result["duplicates"],
            "conflicts": 0}


def auto_promote(vault: Path, verbose: bool = True) -> int:
    result = review(vault, verbose=False)
    if result["conflicts"]:
        print(f"warning: {result['conflicts']} conflict(s) queued to {CONFLICT_FILE} (adjudicate manually)")
    with file_lock(vault):
        promoted = promote(vault, result["pending"], locked=True)
        # A submission with an unresolved conflict must stay in the inbox:
        # archiving it would sever the trail between the queued conflict and
        # its source, and the file's remaining facts are not fully processed.
        archivable = {name for name in result["source_files"] if name} - result[
            "conflicted_sources"
        ]
        archive_sources(vault, archivable, locked=True)
    _refresh_index(vault)
    mark_schedule_run(vault, "promote")
    if verbose:
        held = len(result["conflicted_sources"])
        held_note = f", {held} source(s) held for conflicts" if held else ""
        print(
            f"auto-promoted {len(promoted)} fact(s) "
            f"({result['duplicates']} duplicate(s) skipped){held_note}"
        )
        for line in promoted:
            print(f"  + {line[:100]}")
    return len(promoted)


def _resolve_target(vault: Path, entry: dict) -> Path:
    """Where a conflict's new fact belongs.

    Three kinds of `目标` travel in these entries because two runtimes write
    them: a doc id ("env", "tools"), a vault-relative path
    ("50-Agent-Context\\常用路径与环境.md" — what the human block format
    carries), or nothing at all. All three must land INSIDE the vault: a path
    that resolves elsewhere is discarded in favour of classification, because a
    conflict record is vault text and may be hand-edited. Without this the
    path-shaped value fell through to 未归类事实.md, so 用新 removed the old
    line from one note and wrote the new fact into another.
    """
    raw = str(entry.get("目标") or "").strip()
    if raw:
        if raw in CANONICAL_DOCS:
            return canonical_path(vault, raw)
        # The block format is written on Windows (`50-Agent-Context\常用路径
        # 与环境.md`). Treat `\` as a separator everywhere so the same vault
        # read on Linux resolves to the same note instead of to a file whose
        # name contains a backslash.
        candidate = (Path(vault) / raw.replace("\\", "/")).resolve()
        if candidate.is_relative_to(Path(vault).resolve()) and candidate.suffix == ".md":
            return candidate
    return target_path(vault, classify(str(entry.get("新", ""))))
