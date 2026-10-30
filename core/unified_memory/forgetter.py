# -*- coding: utf-8 -*-
"""forgetter — memory decay (optional, conservative, fully reversible).

Upgraded from a pure "90 days unused" rule to a salience × decay +
citation-reinforcement score (borrowed from rohitg00/agentmemory's retention
scoring, with the batch-A correction that only CITED facts reinforce):

    score = min(1, importance × exp(-λ · age_days) + reinforcement)

  - importance comes from the memory type (architecture 0.9 … fact 0.5) stored
    in the memory database (index.py), falling back to a keyword classification.
  - λ controls decay speed; reinforcement grows slowly with the number of
    ``used`` events (the model cited the fact in a later turn). Retrievals do
    NOT count — rewarding them pinned stale facts forever.
  - A line is demoted only when score < FORGET_THRESHOLD, it is old enough, and
    it is not a durable/protected topic.

All rollback-friendly: demotion moves a line (with its stamp) into 记忆遗忘区/
and never deletes anything. The raw session archives are untouched.

Usage:
    python -m unified_memory.forgetter [--dry-run]
    python -m unified_memory.forgetter --cron     (register a weekly schedule)
"""
from __future__ import annotations

import argparse
import math
import re
import time
from pathlib import Path

from . import index
from .domain.markdown import bare_fact_line, is_versioned, parse_stamp
from .domain.model import Change, ChangeSet
from .domain.policy import CANONICAL_DOCS, PROTECTED_TOPICS
from .infra import vault as vault_mod
from .infra.config import resolve_vault
from .infra import schedule as schedule_mod
from .infra.schedule import mark_schedule_run
from .infra.store import forget_stats
from .infra.vault import (
    canonical_dir,
    ensure_vault,
    forget_dir,
    read_maybe,
)

# Scoring knobs.
FORGET_THRESHOLD = 0.25   # demote when score drops below this
MIN_AGE_DAYS = 30         # never demote fresh facts
DECAY_LAMBDA = 0.02       # per-day decay rate above the durable floor
DURABLE_FLOOR = 0.45      # importance never fully decays; the floor keeps
                          # high-importance knowledge (prefs/architecture/rules)
                          # alive indefinitely while ordinary facts fade.
MAX_REINFORCEMENT = 0.2   # access-reinforcement cap

# Durable topics are never demoted. The whitelist itself lives in
# domain/policy.PROTECTED_TOPICS (batch C2): the old broad regex matched 75.5%
# of the live vault's facts and made forgetting a no-op — see the constant's
# comment there. The regex below is only the matcher over that explicit list.
PROTECTED_RE = re.compile("|".join(re.escape(topic) for topic in PROTECTED_TOPICS), re.I)
USAGE_RE = re.compile(r"｜使用 (\d+) 次(·最近 (\d{4}-\d{2}-\d{2}))?")


def parse_line(line: str) -> dict:
    # bare_fact_line strips the bullet too: the memories table stores the fact
    # without "- ", so a bullet-prefixed key never matched _index_stats and
    # importance/access reinforcement was silently ignored for every line.
    bare = bare_fact_line(line)
    written, _source, valid_until = parse_stamp(line)
    used = 0
    last_used = None
    u = USAGE_RE.search(line)
    if u:
        used = int(u.group(1))
        last_used = u.group(3)
    return {
        "line": line,
        "bare": bare,
        "written": written,
        "valid_until": valid_until,
        "used": used,
        "last_used": last_used,
    }


def memory_score(importance: float, used_count: int, age_days: float) -> float:
    """Salience × (durable floor + decay) + citation reinforcement, clipped [0,1].

    ``importance`` is the long-term anchor: above the floor it keeps a memory
    alive indefinitely (preferences, architecture, rules); at or below it the
    exponential decay eventually drops the score under FORGET_THRESHOLD.
    Reinforcement counts ``used`` events only — facts the model actually
    cited — not retrievals (batch A).
    """
    decay = (1.0 - DURABLE_FLOOR) * math.exp(-DECAY_LAMBDA * age_days) + DURABLE_FLOOR
    reinforcement = min(MAX_REINFORCEMENT, 0.08 * math.log1p(max(0, used_count)))
    return min(1.0, importance * decay + reinforcement)


def _index_stats(vault: Path, doc: str, bare: str) -> tuple[float, int, str] | None:
    """Return (importance, used_count, last_access_at) for a memory line.

    Thin adapter over infra.store.claims.forget_stats, which holds the SQL
    (B2). Kept because forgetter.demote reads like scoring logic, not storage.
    """
    return forget_stats(vault, doc, bare)


def _days_since(value: str, now: float) -> float | None:
    """Days between a stored ``YYYY-MM-DD…`` timestamp and ``now``."""
    text = (value or "")[:10]
    if len(text) != 10:
        return None
    try:
        return max(0.0, (now - time.mktime(time.strptime(text, "%Y-%m-%d"))) / 86400)
    except (ValueError, OverflowError):
        return None


def _forget_candidates(vault: Path) -> list[tuple[Path, str]]:
    """Scan canonical notes for decay candidates (read-only)."""
    ensure_vault(vault)
    ctx = canonical_dir(vault)
    today = time.time()
    candidates: list[tuple[Path, str]] = []
    for doc_id, name in CANONICAL_DOCS.items():
        if doc_id == "index":
            continue  # the index is a table of contents, not a fact store
        path = ctx / name
        for raw in read_maybe(path).splitlines():
            line = raw.rstrip()
            if not line.strip().startswith("-"):
                continue
            parsed = parse_line(line)
            # ｜有效至 marks a historical version, not current truth. It is
            # already excluded from search; decaying it is meaningless.
            if parsed["valid_until"] or is_versioned(line):
                continue
            if PROTECTED_RE.search(parsed["bare"]):
                continue
            if not parsed["written"]:
                continue
            written_ts = time.mktime(time.strptime(parsed["written"], "%Y-%m-%d"))
            age_days = (today - written_ts) / 86400
            if age_days < MIN_AGE_DAYS:
                continue
            # Prefer index-derived importance and the model's actual citations;
            # fall back to a keyword salience and the line's own usage tag.
            stats = _index_stats(vault, str(path), parsed["bare"])
            if stats is not None:
                importance, used, last_access = stats
            else:
                importance = index.salience_for(index.classify_type(parsed["bare"]))
                used = parsed["used"]
                last_access = ""
            # Ebbinghaus-style reinforcement: a recently recalled fact has not
            # "gone unused", even if it was written long ago.
            touched_age = _days_since(last_access, today)
            effective_age = min(age_days, touched_age) if touched_age is not None else age_days
            score = memory_score(importance, used, effective_age)
            if score >= FORGET_THRESHOLD:
                continue
            candidates.append((path, line))
    return candidates


def plan_forget(vault: Path, candidates: list[tuple[Path, str]]) -> ChangeSet:
    """Read-only: build the ChangeSet demote() would apply.

    The remaining-lines computation that used to run inside the file lock runs
    here; ``infra.vault.apply`` re-validates under the lock and re-runs this
    plan if any source note moved while it was being built.
    """
    out_dir = forget_dir(vault)
    changes: list[Change] = []
    by_doc: dict[Path, list[str]] = {}
    for path, line in candidates:
        by_doc.setdefault(path, []).append(line)
    for path, lines in by_doc.items():
        current = read_maybe(path)
        remaining = [
            ln
            for ln in current.splitlines()
            if not any(ln.rstrip() == l for l in lines)
        ]
        changes.append(
            Change(
                op="rewrite_doc", doc=path,
                before_text=current,
                after_text="\n".join(remaining) + ("\n" if remaining else ""),
                meta={"kind": "source", "moved": len(lines), "lines": list(lines)},
            )
        )
        target = out_dir / path.name
        old = read_maybe(target)
        changes.append(
            Change(
                op="rewrite_doc", doc=target,
                before_text=old,
                after_text=old + "\n".join(lines) + "\n",
                meta={"kind": "forget", "moved": len(lines)},
            )
        )
    return ChangeSet(
        actor="forgetter", reason="demote", changes=tuple(changes),
        replan=lambda: plan_forget(vault, candidates),
    )


def demote(vault: Path, dry_run: bool = True) -> list[str]:
    ensure_vault(vault)
    # Demotion rewrites canonical notes (it moves lines into 记忆遗忘区), so it
    # is one of the three write paths — but the lock now lives in the ONE
    # executor (infra.vault.apply, batch B): plan here, apply there, and
    # core/tests/test_write_lock.py keeps that shape honest. A dry run writes
    # nothing and takes no lock.
    candidates = _forget_candidates(vault)

    if dry_run:
        print(f"dry-run: {len(candidates)} candidate line(s) would be demoted to 记忆遗忘区/")
        for path, line in candidates:
            print(f"  {path.name}: {line[:90]}")
        return [line for _, line in candidates]

    changeset = plan_forget(vault, candidates)
    applied = vault_mod.apply(vault, changeset)
    moved = 0
    names: list[str] = []
    moved_lines: list[str] = []
    for change in applied.changes:
        meta = change.meta or {}
        if meta.get("kind") == "source":
            moved += int(meta["moved"])
            names.append(change.doc.name)
            moved_lines.extend(meta["lines"])
    index.record_audit(
        vault, "forgetter", "demote",
        ", ".join(names),
        "; ".join(ln[:60] for ln in moved_lines),
    )
    print(f"demoted {moved} line(s) to {forget_dir(vault)} (reversible — nothing was deleted)")
    # A completed apply counts as this week's forgetting run for catch-up
    # purposes, no matter which entry point fired it (CLI, OS cron, dsh plugin).
    mark_schedule_run(vault, "forget")
    return [line for _, line in candidates]


def register_cron(vault: Path) -> None:
    """Install the weekly forget job (Windows Task Scheduler or crontab).

    The platform dialogue lives in infra.schedule: this function only says what
    the job is. See ``infra/schedule.JobSpec`` for the fields.
    """
    schedule_mod.register_job(
        schedule_mod.JobSpec(
            job="forget",
            module="unified_memory.forgetter",
            flags=("--apply",),
            script_dir=forget_dir(vault).parent,
            script_name="forget_weekly.bat",
            log_name="forget_weekly.log",
            windows_task="UnifiedMemoryForget",
            windows_when=("WEEKLY", "/D", "MON", "/ST", "04:00"),
            cron_expr="0 4 * * 1",
            banner="# unified-agent-memory weekly forgetting (added by forgetter --cron)",
            windows_desc="weekly reversible forget run (Mon 04:00)",
            posix_desc="weekly forgetting (Mon 04:00)",
        ),
        vault,
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="forgetter", description="memory decay (optional)")
    parser.add_argument("--vault", default=None)
    parser.add_argument("--dry-run", action="store_true", help="list candidates without moving (default)")
    parser.add_argument("--apply", action="store_true", help="actually demote candidates")
    parser.add_argument("--cron", action="store_true", help="register a weekly schedule")
    args = parser.parse_args(argv)
    vault = Path(args.vault) if args.vault else resolve_vault()
    if args.cron:
        register_cron(vault)
        return
    demote(vault, dry_run=not args.apply)


if __name__ == "__main__":
    main()
