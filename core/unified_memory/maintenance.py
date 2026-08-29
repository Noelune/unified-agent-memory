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

from .common import (
    CANONICAL_DOCS,
    atomic_write,
    bare_fact_line,
    canonical_path,
    ensure_vault,
    file_lock,
    read_maybe,
    situation_dir,
)

TEMPLATE_PLACEHOLDER_RE = re.compile(r"^示例[:：]|（示例，替换为|（示例）")


def repair_existing(vault: Path, dry_run: bool = False) -> dict:
    """Conservative canonical hygiene: drop exact duplicate fact lines and
    template placeholder lines. Changed notes are backed up first (reversible)."""
    ensure_vault(vault)
    touched: dict[str, list[str]] = {}
    backup_root: Path | None = None
    with file_lock(vault):
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
                touched[name] = drop
                if not dry_run:
                    backup_root = situation_dir(vault) / f"_repair_backup_{time.strftime('%Y%m%d-%H%M%S')}"
                    backup_root.mkdir(parents=True, exist_ok=True)
                    atomic_write(backup_root / name, read_maybe(path))
                    atomic_write(path, "\n".join(kept) + ("\n" if kept else ""))
    removed = sum(len(v) for v in touched.values())
    if dry_run:
        print(f"repair (dry-run): {len(touched)} note(s), {removed} line(s) would be removed")
        for name, drops in touched.items():
            print(f"  {name}: {len(drops)} line(s)")
        return {"dry_run": True, "changed_count": len(touched), "removed_items": removed}
    print(f"repair: {len(touched)} note(s) changed, {removed} line(s) removed")
    for name, drops in touched.items():
        print(f"  {name}: {len(drops)} line(s)")
    print(f"backup: {backup_root}")
    return {
        "dry_run": False,
        "changed_count": len(touched),
        "removed_items": removed,
        "backup_root": str(backup_root),
    }
