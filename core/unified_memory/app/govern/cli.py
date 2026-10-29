# -*- coding: utf-8 -*-
"""cli — the `python -m unified_memory.promoter` entry point (B5.4 split).

Argparse and dispatch only: every branch calls one function from review /
promote / decide / queue, or hands a JobSpec to infra.schedule. Keeping the
parser here means importing the promotion logic no longer costs an argparse
grammar, and `unified_memory.promoter` can stay a pure re-export shim.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from ...domain.policy import PENDING_FILE
from ...infra import schedule as schedule_mod
from ...infra.config import resolve_vault
from ...infra.vault import situation_dir
from ..maintain.repair import repair_existing
from .decide import adjudicate
from .promote import apply_pending, auto_promote
from .review import review, write_pending_list


def register_cron(vault: Path) -> None:
    """Install the daily promotion job (Windows Task Scheduler or crontab).

    The platform dialogue lives in infra.schedule: this function only says what
    the job is. See ``infra/schedule.JobSpec`` for the fields.
    """
    schedule_mod.register_job(
        schedule_mod.JobSpec(
            job="promote",
            module="unified_memory.promoter",
            flags=("--auto",),
            script_dir=situation_dir(vault).parent,
            script_name="promote_daily.bat",
            log_name="promote.log",
            windows_task="UnifiedMemoryPromote",
            windows_when=("DAILY", "/ST", "03:00"),
            cron_expr="0 3 * * *",
            banner="# unified-agent-memory daily promotion (added by promoter --cron)",
            windows_desc="daily promotion at 03:00",
            posix_desc="daily promotion at 03:00",
        ),
        vault,
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="promoter", description="unified memory promoter (sole promotion entry point)")
    parser.add_argument("--vault", default=None, help="vault path (default: config/env)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--review", action="store_true", help="build the pending list only (default)")
    group.add_argument("--apply", action="store_true", help="execute the pending list")
    group.add_argument("--auto", action="store_true", help="review + apply in one step (explicit opt-in)")
    group.add_argument("--cron", action="store_true", help="register a daily schedule")
    group.add_argument("--adjudicate", action="store_true", help="interactive conflict resolution")
    group.add_argument("--repair-existing", action="store_true", help="canonical hygiene: drop duplicate/template-placeholder lines (with backup)")
    parser.add_argument("--dry-run", action="store_true", help="with --repair-existing: preview only, change nothing")
    args = parser.parse_args(argv)

    vault = Path(args.vault) if args.vault else resolve_vault()
    if args.adjudicate:
        adjudicate(vault)
        return
    if args.cron:
        register_cron(vault)
        return
    if args.repair_existing:
        repair_existing(vault, dry_run=args.dry_run)
        return
    if args.apply:
        apply_pending(vault)
        return
    if args.auto:
        auto_promote(vault)
        return
    # default: --review
    result = review(vault)
    write_pending_list(vault, result)
    pending_file = situation_dir(vault) / PENDING_FILE
    print(f"pending list written to {pending_file}")
