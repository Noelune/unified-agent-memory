#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Daily promotion cron — generic version of a hosted agent's daily memory job.

Runs the full daily lifecycle against the shared vault:
  0. digest (default on): distill durable facts from newly archived sessions
     into the submission inbox (needs a SiliconFlow API key; disabled with
     --no-digest, or off entirely via digest.enabled=false in config)
  1. promote: review (default, safe) or --auto (review+apply, explicit opt-in)
  2. --repair: canonical hygiene (promoter --repair-existing, with backup)
  3. --forget: on Mondays, run the forgetting scan (reversible)

Digest runs BEFORE promotion so facts extracted from today's sessions flow
into the same day's pending list / canonical notes.

Schedule it however you like (system cron / Windows Task Scheduler / your
agent runtime's scheduler). With an agent-runtime scheduler, enable
missed-run recovery so a run that was due while the agent was offline fires
on its next startup.

Usage:
    python integrations/hermes/daily_cron.py [--vault <path>] [--auto] [--repair] [--forget] [--no-digest]
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "core"))

from unified_memory import digest as digest_mod  # noqa: E402
from unified_memory import forgetter, promoter  # noqa: E402
from unified_memory.common import CONFIG_PATH, resolve_vault  # noqa: E402

DEFAULT_DIGEST_LIMIT = 10  # max archive files distilled per daily run


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="daily_cron")
    ap.add_argument("--vault", default=None)
    ap.add_argument("--auto", action="store_true", help="promote automatically (review+apply); default is safe review-only")
    ap.add_argument("--repair", action="store_true", help="run canonical hygiene after promotion")
    ap.add_argument("--forget", action="store_true", help="run the weekly forgetting scan on Mondays")
    ap.add_argument("--no-digest", action="store_true", help="skip the session-digest step")
    ap.add_argument("--digest-limit", type=int, default=DEFAULT_DIGEST_LIMIT, help=f"max archive files to distill (default {DEFAULT_DIGEST_LIMIT})")
    args = ap.parse_args(argv)
    vault = Path(args.vault) if args.vault else resolve_vault()
    print(f"🌙 daily memory cron {dt.datetime.now().strftime('%Y-%m-%d %H:%M')} — vault {vault}")

    # 0. Session digest → submission inbox (before promotion).
    if not args.no_digest:
        if not digest_mod.digest_enabled(CONFIG_PATH):
            print("digest: disabled (digest.enabled=false) — skipped")
        else:
            report = digest_mod.digest(vault, limit=args.digest_limit)
            print(f"digest: {report['pending']} new archive(s), wrote {report['written']} file(s), {report['facts']} fact(s)")

    # 1. Promote.
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
