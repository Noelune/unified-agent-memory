#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Daily promotion cron — generic version of a hosted agent's daily memory job.

Runs the full daily lifecycle against the shared vault:
  1. promote: review (default, safe) or --auto (review+apply, explicit opt-in)
  2. --repair: canonical hygiene (promoter --repair-existing, with backup)
  3. --forget: on Mondays, run the forgetting scan (reversible)

Schedule it however you like (system cron / Windows Task Scheduler / your
agent runtime's scheduler). With an agent-runtime scheduler, enable
missed-run recovery so a run that was due while the agent was offline fires
on its next startup.

Usage:
    python integrations/hermes/daily_cron.py [--vault <path>] [--auto] [--repair] [--forget]
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "core"))

from unified_memory import forgetter, promoter  # noqa: E402
from unified_memory.common import resolve_vault  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="daily_cron")
    ap.add_argument("--vault", default=None)
    ap.add_argument("--auto", action="store_true", help="promote automatically (review+apply); default is safe review-only")
    ap.add_argument("--repair", action="store_true", help="run canonical hygiene after promotion")
    ap.add_argument("--forget", action="store_true", help="run the weekly forgetting scan on Mondays")
    args = ap.parse_args(argv)
    vault = Path(args.vault) if args.vault else resolve_vault()
    print(f"🌙 daily memory cron {dt.datetime.now().strftime('%Y-%m-%d %H:%M')} — vault {vault}")
    if args.auto:
        promoter.auto_promote(vault)
    else:
        result = promoter.review(vault)
        promoter.write_pending_list(vault, result)
        print(f"pending list written; conflicts: {result['conflicts']} (see 情境信息/待晋升.md)")
    if args.repair:
        promoter.repair_existing(vault)
    if args.forget and dt.date.today().weekday() == 0:
        forgetter.demote(vault, dry_run=False)
    print("done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
