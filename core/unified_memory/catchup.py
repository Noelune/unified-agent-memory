# -*- coding: utf-8 -*-
"""catchup — missed-run recovery for the two lifecycle schedules.

The OS schedules registered by `setup.py cron` are:

  * daily promotion  — 03:00 every day  (`promoter --auto`)
  * weekly forgetting — 04:00 every Monday  (`forgetter --apply`)

A machine that is off, asleep or simply has no agent running at those moments
misses the fire. This module makes "run it when the agent next comes online"
concrete: every successful lifecycle run (from any entry point) stamps its
date into `50-Agent-Context/调度状态.json`; a later `catchup` invocation
compares the stamps against the schedule anchors and re-runs exactly what the
missed cron would have run. Because the state file lives inside the vault, a
synced fleet shares it — one machine's successful run suppresses the others.

The dsh plugin calls this at startup and hourly; the CLI works anywhere:

    python -m unified_memory.catchup --check    # what is overdue? (read-only)
    python -m unified_memory.catchup            # run the overdue jobs
    python -m unified_memory.catchup --json     # machine-readable report

With no state at all (fresh vault) both jobs count as due, which bootstraps
the lifecycle on first launch. Both entry points are idempotent: nothing due
means nothing runs and nothing is written.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

from . import forgetter, promoter
from .common import ensure_vault, mark_schedule_run, read_schedule_state, resolve_vault

PROMOTE_HOUR = 3   # daily promotion fires at 03:00 local
FORGET_HOUR = 4    # weekly forgetting fires Monday 04:00 local
FORGET_WEEKDAY = 0  # Monday


def weekly_anchor(now: dt.datetime | None = None) -> dt.date:
    """The Monday whose 04:00 forget run is the one currently owed.

    On a Monday before 04:00 this week's run is not due yet, so the anchor is
    still the previous Monday.
    """
    now = now or dt.datetime.now()
    anchor = (now - dt.timedelta(days=now.weekday())).date()
    if now.weekday() == FORGET_WEEKDAY and now.hour < FORGET_HOUR:
        anchor -= dt.timedelta(days=7)
    return anchor


def _parse_day(value: str | None) -> dt.date | None:
    if not value:
        return None
    try:
        return dt.date.fromisoformat(value[:10])
    except ValueError:
        return None


def due(vault: Path, now: dt.datetime | None = None) -> dict:
    """Which lifecycle jobs are overdue right now.

    Promotion is due unless it already ran today (the daily job has no
    "time of day" requirement for the catch-up: after 03:00 any moment is a
    valid substitute). Forgetting is due unless it ran on/after the current
    weekly anchor.
    """
    now = now or dt.datetime.now()
    state = read_schedule_state(vault)
    last_promote = _parse_day(state.get("last_promote"))
    last_forget = _parse_day(state.get("last_forget"))
    anchor = weekly_anchor(now)
    return {
        "promote": last_promote != now.date(),
        "forget": last_forget is None or last_forget < anchor,
        "anchor": anchor.isoformat(),
        "last_promote": last_promote.isoformat() if last_promote else None,
        "last_forget": last_forget.isoformat() if last_forget else None,
    }


def run(vault: Path, now: dt.datetime | None = None) -> dict:
    """Run the overdue jobs, each isolated so one failure costs only itself.

    The jobs are exactly what the missed cron would have executed:
    `promoter --auto` then `forgetter --apply` (both stamp the schedule state
    themselves on success). The report keeps the failure detail verbatim so a
    caller (the dsh plugin, a bare cron, an agent) can surface it.
    """
    ensure_vault(vault)
    report = due(vault, now=now)
    report["jobs"] = {}
    for job, fire in (
        ("promote", lambda: promoter.auto_promote(vault)),
        ("forget", lambda: forgetter.demote(vault, dry_run=False)),
    ):
        if not report[job]:
            report["jobs"][job] = {"status": "skipped", "detail": "not due"}
            continue
        try:
            fire()
            # auto_promote/demote already stamped on success; stamp again with
            # the injected `now` so tests (and clock-skewed callers) stay
            # consistent with the due() computation that drove the run.
            mark_schedule_run(vault, job, day=(now or dt.datetime.now()).strftime("%Y-%m-%d"))
            report["jobs"][job] = {"status": "ran"}
        except Exception as exc:  # noqa: BLE001 — the other job must still run
            report["jobs"][job] = {"status": "failed", "detail": str(exc)}
    return report


def _print_report(report: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(report, ensure_ascii=False))
        return
    for job in ("promote", "forget"):
        outcome = report["jobs"][job] if "jobs" in report else {"status": "due" if report[job] else "not due"}
        detail = f" — {outcome['detail']}" if outcome.get("detail") else ""
        print(f"{job}: {outcome['status']}{detail}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="catchup", description="missed-run recovery for the lifecycle schedules")
    parser.add_argument("--vault", default=None)
    parser.add_argument("--check", action="store_true", help="only report what is due; run nothing")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args(argv)
    vault = Path(args.vault) if args.vault else resolve_vault()
    report = due(vault) if args.check else run(vault)
    _print_report(report, args.json)
    failed = [j for j in report.get("jobs", {}).values() if j.get("status") == "failed"]
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
