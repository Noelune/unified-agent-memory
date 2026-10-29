# -*- coding: utf-8 -*-
"""maintenance — standalone vault hygiene operations.

Split from promoter.py (2026-08-29 stabilization pass). promoter.py
re-exports `repair_existing` so the CLI, tests and cron keep working.

repair_existing is conservative canonical hygiene: drop exact duplicate
fact lines and template placeholder lines; every changed note is backed
up first (reversible). It shares no state with the promotion pipeline.
"""
from __future__ import annotations

import re
import time
from pathlib import Path

from ...domain.markdown import bare_fact_line
from ...domain.model import Change, ChangeSet
from ...domain.policy import CANONICAL_DOCS
from ...infra import vault as vault_mod
from ...infra.store import record_audit
from ...infra.vault import (
    canonical_path,
    ensure_vault,
    read_maybe,
    situation_dir,
)

TEMPLATE_PLACEHOLDER_RE = re.compile(r"^示例[:：]|（示例，替换为|（示例）")


def plan_repair(vault: Path) -> ChangeSet:
    """Read-only: build the ChangeSet repair_existing would apply.

    The scan that used to run inside the file lock runs here; ``infra.vault.apply``
    re-validates under the lock and re-runs this plan if a note moved while it
    was being built. Backup writes travel as their own changes (op
    ``backup_doc``) so the executor stays the only writer.
    """
    changes: list[Change] = []
    backup_root: Path | None = None
    for doc_id, name in CANONICAL_DOCS.items():
        if doc_id == "index":
            continue
        path = canonical_path(vault, doc_id)
        lines = read_maybe(path).splitlines()
        kept: list[str] = []
        seen: set[str] = set()
        drop: list[str] = []
        for ln in lines:
            bare = bare_fact_line(ln)
            if not bare:
                kept.append(ln)
                continue
            if TEMPLATE_PLACEHOLDER_RE.search(bare):
                drop.append(ln)
                continue
            if bare in seen:
                drop.append(ln)
                continue
            seen.add(bare)
            kept.append(ln)
        if drop:
            if backup_root is None:
                backup_root = situation_dir(vault) / f"_repair_backup_{time.strftime('%Y%m%d-%H%M%S')}"
            current = read_maybe(path)
            changes.append(
                Change(
                    op="backup_doc", doc=backup_root / name,
                    before_text="", after_text=current,
                )
            )
            changes.append(
                Change(
                    op="rewrite_doc", doc=path,
                    before_text=current,
                    after_text="\n".join(kept) + ("\n" if kept else ""),
                    meta={"name": name, "drops": list(drop)},
                )
            )
    return ChangeSet(
        actor="maintenance", reason="repair", changes=tuple(changes),
        replan=lambda: plan_repair(vault),
    )


def repair_existing(vault: Path, dry_run: bool = False) -> dict:
    """Conservative canonical hygiene: drop exact duplicate fact lines and
    template placeholder lines. Changed notes are backed up first (reversible).

    This rewrites canonical notes, so it is one of the three write paths — but
    the lock now lives in the ONE executor (infra.vault.apply, batch B), and
    ``core/tests/test_write_lock.py`` keeps that shape honest. The plan/apply
    split also means a dry run is a pure read.
    """
    ensure_vault(vault)
    changeset = plan_repair(vault)
    if dry_run:
        touched = {ch.meta["name"]: ch.meta["drops"] for ch in changeset.changes if ch.op == "rewrite_doc"}
        removed = sum(len(v) for v in touched.values())
        print(f"repair (dry-run): {len(touched)} note(s), {removed} line(s) would be removed")
        for name, drops in touched.items():
            print(f"  {name}: {len(drops)} line(s)")
        return {"dry_run": True, "changed_count": len(touched), "removed_items": removed}

    applied = vault_mod.apply(vault, changeset)
    repairs = [ch for ch in applied.changes if ch.op == "rewrite_doc"]
    touched = {ch.meta["name"]: ch.meta["drops"] for ch in repairs}
    removed = sum(len(v) for v in touched.values())
    backup_root = next((ch.doc.parent for ch in applied.changes if ch.op == "backup_doc"), None)
    print(f"repair: {len(touched)} note(s) changed, {removed} line(s) removed")
    for name, drops in touched.items():
        print(f"  {name}: {len(drops)} line(s)")
    print(f"backup: {backup_root}")
    if touched:
        record_audit(
            vault, "maintenance", "repair",
            ", ".join(sorted(touched)), f"{removed} lines removed",
        )
    return {
        "dry_run": False,
        "changed_count": len(touched),
        "removed_items": removed,
        "backup_root": str(backup_root),
    }
