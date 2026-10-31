# -*- coding: utf-8 -*-
"""backfill — assign Obsidian block IDs to fact lines missing one (batch D).

PLAN §4: the id is generated ONCE per fact; 改文字不改 ID. The backfill is
idempotent — a line that already carries `` ^c-<16hex>`` is skipped, so running
it twice never produces a second id. The vault edit goes through the one
executor (plan + infra.vault.apply, the B4 write boundary); dry-run prints the
would-be diff to stderr and writes nothing.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from ...domain.markdown import bare_fact_line, has_claim_id, with_claim_id
from ...domain.model import Change, ChangeSet
from ...infra import vault as vault_mod
from ...infra.store import get_meta, set_meta
from ...infra.store.ledger import new_claim_id, refresh_ledger
from ...infra.vault import ensure_vault, indexed_files, read_maybe

BACKFILL_MARKER_KEY = "ledger.backfill_done"


def plan_backfill(vault: Path) -> tuple[ChangeSet, list[tuple[Path, str, str]]]:
    """Read-only: the id-appending rewrite per note + the ids it introduces."""
    ensure_vault(vault)
    changes: list[Change] = []
    introduced: list[tuple[Path, str, str]] = []
    for path in indexed_files(vault):
        text = read_maybe(path)
        if not text:
            continue
        out: list[str] = []
        changed = False
        for ln in text.splitlines():
            if ln.lstrip().startswith("-") and bare_fact_line(ln) and not has_claim_id(ln):
                claim_id = new_claim_id()
                out.append(with_claim_id(ln.rstrip(), claim_id))
                introduced.append((path, claim_id, bare_fact_line(ln)))
                changed = True
            else:
                out.append(ln)
        if changed:
            new_text = "\n".join(out) + ("\n" if text.endswith("\n") else "")
            changes.append(
                Change(
                    op="rewrite_doc", doc=path,
                    before_text=text, after_text=new_text,
                    meta={"kind": "backfill"},
                )
            )
    return (
        ChangeSet(
            actor="backfill", reason="backfill-ids", changes=tuple(changes),
            replan=lambda: plan_backfill(vault)[0],
        ),
        introduced,
    )


def run_backfill(vault: Path, dry_run: bool = False) -> dict:
    """Assign ids (unless dry-run), then refresh the ledger projection."""
    changeset, introduced = plan_backfill(vault)
    report = {
        "lines": len(introduced),
        "docs": len({str(path) for path, _, _ in introduced}),
        "dry_run": dry_run,
    }
    if dry_run:
        for path, claim_id, bare in introduced:
            print(f"  {path.name}: {bare[:60]} -> ^c-{claim_id}", file=sys.stderr)
        return report
    if changeset.changes:
        vault_mod.apply(vault, changeset)
    # Refresh touches every note (cheap, idempotent) so the projection also
    # picks up ids assigned by earlier runs.
    refresh_ledger(vault)
    return report


def ensure_backfilled(vault: Path) -> dict | None:
    """Run the backfill once per vault (batch D7: default-enabled).

    Write/maintenance paths call this — NEVER the read path: it rewrites
    canonical notes (append-only id suffixes through the one executor) and
    must not add latency or writes to a search. The marker lives in
    index_meta, so the whole flow fires exactly once per vault; concurrent
    callers are safe (the executor re-plans under the lock, and a re-plan
    finds every line already carrying an id).
    """
    if get_meta(vault, BACKFILL_MARKER_KEY):
        return None
    report = run_backfill(vault)
    set_meta(vault, BACKFILL_MARKER_KEY, time.strftime("%Y-%m-%dT%H:%M:%S"))
    return report
