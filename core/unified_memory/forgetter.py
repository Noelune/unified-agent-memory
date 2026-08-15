# -*- coding: utf-8 -*-
"""forgetter — memory decay (optional, conservative, fully reversible).

Rules (all rollback-friendly — nothing is ever deleted):
  1. A canonical line is demoted to 记忆遗忘区/ when:
     - written more than ANCIENT_DAYS (90) ago, AND
     - used 0 times or last used more than USAGE_STALE_DAYS (90) ago, AND
     - it does not match the durable-topic protection list.
  2. Demotion moves the line (with its stamp) into 记忆遗忘区/<doc>.md and
     removes it from the canonical note — the raw archives are untouched.

Usage:
    python -m unified_memory.forgetter [--dry-run]
    python -m unified_memory.forgetter --cron     (register a weekly schedule)
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

from .common import (
    CANONICAL_DOCS,
    atomic_write,
    canonical_dir,
    ensure_vault,
    file_lock,
    forget_dir,
    read_maybe,
    resolve_vault,
    strip_suffix,
)

ANCIENT_DAYS = 90
USAGE_STALE_DAYS = 90

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
            if age_days < ANCIENT_DAYS:
                continue
            last = parsed["last_used"] or parsed["written"]
            last_ts = time.mktime(time.strptime(last, "%Y-%m-%d"))
            stale_days = (today - last_ts) / 86400
            if parsed["used"] > 0 and stale_days < USAGE_STALE_DAYS:
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
    return []


def register_cron(vault: Path) -> None:
    import platform as _platform

    python = str(Path(sys.executable).resolve())
    system = _platform.system()
    if system == "Windows":
        bat = forget_dir(vault).parent / "forget_weekly.bat"
        content = (
            "@echo off\r\n"
            f"chcp 65001 >nul\r\n"
            f"\"{python}\" -m unified_memory.forgetter --vault \"{vault}\"\r\n"
        )
        bat.write_bytes(b"\xef\xbb\xbf" + content.encode("utf-8"))
        subprocess.run(
            ["schtasks", "/Create", "/TN", "UnifiedMemoryForget", "/TR", str(bat), "/SC", "WEEKLY", "/D", "MON", "/ST", "04:00", "/F"],
            check=False,
        )
        print("scheduled weekly forget scan (Mon 04:00) via Windows Task Scheduler")
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
