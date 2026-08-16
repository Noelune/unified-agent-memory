# -*- coding: utf-8 -*-
"""forgetter — memory decay (optional, conservative, fully reversible).

Upgraded from a pure "90 days unused" rule to a salience × decay +
reinforcement score (borrowed from rohitg00/agentmemory's retention scoring):

    score = min(1, importance × exp(-λ · age_days) + reinforcement)

  - importance comes from the memory type (architecture 0.9 … fact 0.5) stored
    in the memory database (index.py), falling back to a keyword classification.
  - λ controls decay speed; reinforcement grows slowly with read/access count.
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
import platform
import re
import subprocess
import sys
import time
from pathlib import Path

from . import index
from .common import (
    CANONICAL_DOCS,
    atomic_write,
    bare_fact_line,
    canonical_dir,
    ensure_vault,
    file_lock,
    forget_dir,
    read_maybe,
    resolve_vault,
    strip_suffix,
)

# Scoring knobs.
FORGET_THRESHOLD = 0.25   # demote when score drops below this
MIN_AGE_DAYS = 30         # never demote fresh facts
DECAY_LAMBDA = 0.02       # per-day decay rate above the durable floor
DURABLE_FLOOR = 0.45      # importance never fully decays; the floor keeps
                          # high-importance knowledge (prefs/architecture/rules)
                          # alive indefinitely while ordinary facts fade.
MAX_REINFORCEMENT = 0.2   # access-reinforcement cap

# Durable topics are never demoted: paths, configs, preferences, accounts,
# servers, credentials references, and agent coordination rules.
PROTECTED_RE = re.compile(
    r"path|directory|config|prefer|account|server|port|credential|password|secret|"
    r"model|domain|backup|script|rule|coordinat|agent|vault|endpoint|api|url",
    re.I,
)
WRITTEN_RE = re.compile(r"（写入 (\d{4}-\d{2}-\d{2})｜来源：([^）]*)）")
USAGE_RE = re.compile(r"｜使用 (\d+) 次(·最近 (\d{4}-\d{2}-\d{2}))?")


def parse_line(line: str) -> dict:
    bare = strip_suffix(line)
    written = None
    used = 0
    last_used = None
    m = WRITTEN_RE.search(line)
    if m:
        written = m.group(1)
    u = USAGE_RE.search(line)
    if u:
        used = int(u.group(1))
        last_used = u.group(3)
    return {"line": line, "bare": bare, "written": written, "used": used, "last_used": last_used}


def memory_score(importance: float, access_count: int, age_days: float) -> float:
    """Salience × (durable floor + decay) + access reinforcement, clipped to [0, 1].

    ``importance`` is the long-term anchor: above the floor it keeps a memory
    alive indefinitely (preferences, architecture, rules); at or below it the
    exponential decay eventually drops the score under FORGET_THRESHOLD.
    """
    decay = (1.0 - DURABLE_FLOOR) * math.exp(-DECAY_LAMBDA * age_days) + DURABLE_FLOOR
    reinforcement = min(MAX_REINFORCEMENT, 0.08 * math.log1p(max(0, access_count)))
    return min(1.0, importance * decay + reinforcement)


def _index_stats(vault: Path, doc: str, bare: str) -> tuple[float, int] | None:
    """Return (importance, access_count) for a memory line, or None."""
    try:
        conn = index.get_conn(vault)
        try:
            row = conn.execute(
                "SELECT importance, access_count FROM memories WHERE doc = ? AND line = ? LIMIT 1",
                (doc, bare),
            ).fetchone()
            if row is None:
                row = conn.execute(
                    "SELECT importance, access_count FROM memories WHERE line = ? LIMIT 1",
                    (bare,),
                ).fetchone()
            if row is None:
                return None
            return float(row["importance"]), int(row["access_count"])
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 — never let the index break forgetting
        return None


def demote(vault: Path, dry_run: bool = True) -> list[str]:
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
            if PROTECTED_RE.search(parsed["bare"]):
                continue
            if not parsed["written"]:
                continue
            written_ts = time.mktime(time.strptime(parsed["written"], "%Y-%m-%d"))
            age_days = (today - written_ts) / 86400
            if age_days < MIN_AGE_DAYS:
                continue
            # Prefer index-derived importance/access; fall back to a keyword
            # salience and the line's own usage tag.
            stats = _index_stats(vault, str(path), parsed["bare"])
            if stats is not None:
                importance, access = stats
            else:
                importance = index.salience_for(index.classify_type(parsed["bare"]))
                access = parsed["used"]
            score = memory_score(importance, access, age_days)
            if score >= FORGET_THRESHOLD:
                continue
            candidates.append((path, line))

    if dry_run:
        print(f"dry-run: {len(candidates)} candidate line(s) would be demoted to 记忆遗忘区/")
        for path, line in candidates:
            print(f"  {path.name}: {line[:90]}")
        return [line for _, line in candidates]

    out_dir = forget_dir(vault)
    out_dir.mkdir(parents=True, exist_ok=True)
    moved = 0
    with file_lock(vault):
        by_doc: dict[Path, list[str]] = {}
        for path, line in candidates:
            by_doc.setdefault(path, []).append(line)
        for path, lines in by_doc.items():
            remaining = [
                ln
                for ln in read_maybe(path).splitlines()
                if not any(ln.rstrip() == l for l in lines)
            ]
            atomic_write(path, "\n".join(remaining) + ("\n" if remaining else ""))
            target = out_dir / path.name
            old = read_maybe(target)
            additions = "\n".join(lines) + "\n"
            atomic_write(target, old + additions)
            moved += len(lines)
    print(f"demoted {moved} line(s) to {out_dir} (reversible — nothing was deleted)")
    return [line for _, line in candidates]


def register_cron(vault: Path) -> None:
    python = str(Path(sys.executable).resolve())
    system = platform.system()
    if system == "Windows":
        bat = forget_dir(vault).parent / "forget_weekly.bat"
        log = vault / "forget_weekly.log"
        content = (
            "@echo off\r\n"
            f"chcp 65001 >nul\r\n"
            f"\"{python}\" -m unified_memory.forgetter --vault \"{vault}\" --apply >> \"{log}\" 2>&1\r\n"
            "exit /b %errorlevel%\r\n"
        )
        bat.write_bytes(b"\xef\xbb\xbf" + content.encode("utf-8"))
        subprocess.run(
            ["schtasks", "/Create", "/TN", "UnifiedMemoryForget", "/TR", f'"{bat}"', "/SC", "WEEKLY", "/D", "MON", "/ST", "04:00", "/F"],
            check=False,
        )
        print("scheduled weekly reversible forget run (Mon 04:00) via Windows Task Scheduler")
    else:
        print(
            "add a weekly cron line yourself, e.g.:\n"
            f"  0 4 * * 1 {python} -m unified_memory.forgetter --vault {vault}\n"
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
