# -*- coding: utf-8 -*-
"""promoter — the ONLY promotion entry point of the memory system.

Scans the submission inbox (50-Agent-Context/Agent提交区), classifies facts,
dedups against canonical notes, detects conflicts, and — after human review —
appends facts to canonical notes with a write stamp, then archives the inbox
files into 已处理/.

Independent of any agent runtime: pure Python standard library. Schedule it
any way you like (system cron / Windows Task Scheduler / dsh schedule / manual).

Safety defaults (per the project's coordination rules):
  - --review (default): only builds a pending list (情境信息/待晋升.md)
  - --apply: executes the pending list (human-confirmed)
  - --auto: review + apply in one step (explicit opt-in)
  - adjudicate: interactive conflict resolution CLI
"""
from __future__ import annotations

import argparse
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from .common import (
    ADJUDICATED_FILE,
    CANONICAL_DOCS,
    CONFLICT_FILE,
    PENDING_FILE,
    atomic_write,
    canonical_dir,
    canonical_path,
    ensure_vault,
    fact_lines,
    file_lock,
    is_versioned,
    processed_dir,
    read_maybe,
    redact,
    resolve_vault,
    situation_dir,
    bare_fact_line,
    strip_suffix,
    write_stamp,
)
from .conflict import (
    append_conflict,
    classify_against,
    read_conflicts,
    record_adjudication,
    remove_conflict,
)

# --------------------------------------------------------------------------
# Classification rules (keyword -> canonical target). Neutral & generic.
# --------------------------------------------------------------------------

CATEGORY_RULES: list[tuple[str, re.Pattern, str]] = [
    ("ui", re.compile(r"\bui\b|user interface|interface|design|theme|color|aesthetic|layout|style|dashboard", re.I), "ui"),
    ("rules", re.compile(r"rule|workflow|process|policy|must|should|always|never|verify|audit|rollback|deploy|red line|红线", re.I), "rules"),
    ("prefs", re.compile(r"prefer|like|dislike|default|language|format|tone|writing", re.I), "prefs"),
    ("env", re.compile(r"path|directory|install|version|environment|config|port|server|model|provider|endpoint|host|url|account|backup|cache|storage|home", re.I), "env"),
    ("tools", re.compile(r"tool|available|broken|status|doctor|install|uninstall|health", re.I), "tools"),
    ("coord", re.compile(r"coordinat|collaborat|agent|relay|handoff|ownership|boundary|inbox", re.I), "coord"),
]

UNCLASSIFIED_TARGET = "情境信息/未归类事实.md"
UNCLASSIFIED_DOC = "情境信息/未归类事实.md"


def classify(fact: str) -> str:
    for _name, pattern, doc_id in CATEGORY_RULES:
        if pattern.search(fact):
            return doc_id
    return "other"


def target_path(vault: Path, doc_id: str) -> Path:
    if doc_id == "other":
        return situation_dir(vault) / "未归类事实.md"
    return canonical_path(vault, doc_id)


# --------------------------------------------------------------------------
# Review: build the pending list
# --------------------------------------------------------------------------


def review(vault: Path, verbose: bool = True) -> dict:
    ensure_vault(vault)
    inbox = canonical_dir(vault) / "Agent提交区"
    if not inbox.is_dir():
        raise SystemExit(f"inbox missing at {inbox} — run \"memory init --vault <path>\"")
    pending: list[dict] = []
    duplicates = 0
    conflicts = 0
    for src in sorted(inbox.glob("*.md")):
        if src.name == "README.md":
            continue
        for fact in fact_lines(src.read_text(encoding="utf-8", errors="replace")):
            clean = redact(fact.strip())
            doc_id = classify(clean)
            target = target_path(vault, doc_id)
            existing = [
                bare_fact_line(ln)
                for ln in read_maybe(target).splitlines()
                if ln.strip().startswith("-") and "示例" not in ln and "example" not in ln.lower()
            ]
            status, hit = classify_against(clean, existing)
            if status == "duplicate":
                duplicates += 1
                continue
            if status == "conflict":
                conflicts += 1
                append_conflict(vault, clean, hit or "", src.name, doc_id)
                continue
            pending.append(
                {
                    "fact": clean,
                    "doc": doc_id,
                    "target": str(target.relative_to(vault)) if target.is_relative_to(vault) else str(target),
                    "source": src.name,
                }
            )
    if verbose:
        print(f"review: {len(pending)} pending, {duplicates} duplicate(s), {conflicts} conflict(s)")
        for p in pending:
            print(f"  -> {p['doc']:6s} | {p['fact'][:80]}")
    return {"pending": pending, "duplicates": duplicates, "conflicts": conflicts}


def write_pending_list(vault: Path, result: dict) -> None:
    path = situation_dir(vault) / PENDING_FILE
    lines = [
        "# 待晋升清单",
        "",
        f"> 生成于 {time.strftime('%Y-%m-%d %H:%M')}。运行 \"python -m unified_memory.promoter --apply\" 晋升；",
        "> 或 \"--auto\" 一步完成（需显式开启）。",
        "",
    ]
    if not result["pending"]:
        lines.append("_无待晋升事实。_")
    for i, p in enumerate(result["pending"], 1):
        lines.append(f"- [ ] {i}. 分类:{p['doc']}｜目标:{p['target']}｜来源:{p['source']}｜内容:{p['fact']}")
    lines.append("")
    atomic_write(path, "\n".join(lines))
    return path


# --------------------------------------------------------------------------
# Apply: promote the pending list into canonical notes
# --------------------------------------------------------------------------


def parse_pending_list(vault: Path) -> list[dict]:
    path = situation_dir(vault) / PENDING_FILE
    entries = []
    for raw in read_maybe(path).splitlines():
        line = raw.strip()
        m = re.match(r"^- \[ \]\s*\d+\.\s+(分类:.*)$", line)
        if not m:
            continue
        fields: dict[str, str] = {}
        for part in m.group(1).split("｜"):
            key, _, value = part.partition(":")
            fields[key.strip()] = value.strip()
        entries.append(fields)
    return entries


def promote(vault: Path, entries: list[dict]) -> list[str]:
    """Append facts to canonical notes under the file lock; returns promoted lines."""
    promoted: list[str] = []
    today = time.strftime("%Y-%m-%d")
    with file_lock(vault):
        for entry in entries:
            doc = entry.get("分类", "other")
            target = target_path(vault, doc)
            existing = read_maybe(target)
            if not existing.endswith("\n") and existing:
                existing += "\n"
            fact = entry.get("内容") or entry.get("fact") or ""
            line = f"- {fact}{write_stamp(entry.get('来源', 'inbox'), today)}\n"
            # Re-check dedup under the lock (another promoter may have raced).
            bare = strip_suffix(line)
            prior = [bare_fact_line(ln) for ln in existing.splitlines() if ln.strip().startswith("-")]
            if any(p.strip() == bare.strip() for p in prior):
                continue
            atomic_write(target, existing + line)
            promoted.append(line.strip())
    return promoted


def archive_sources(vault: Path, sources: set[str]) -> None:
    done = processed_dir(vault)
    done.mkdir(parents=True, exist_ok=True)
    inbox = canonical_dir(vault) / "Agent提交区"
    for name in sorted(sources):
        src = inbox / name
        if src.is_file():
            shutil.move(str(src), str(done / name))


def apply_pending(vault: Path, verbose: bool = True) -> int:
    entries = parse_pending_list(vault)
    if not entries:
        if verbose:
            print("pending list is empty — nothing to apply")
        return 0
    promoted = promote(vault, entries)
    archive_sources(vault, {e.get("来源", "") for e in entries})
    if verbose:
        print(f"applied {len(promoted)} fact(s) to canonical notes")
        for line in promoted:
            print(f"  + {line[:100]}")
        print("inbox files archived to 已处理/")
    return len(promoted)


def auto_promote(vault: Path, verbose: bool = True) -> int:
    result = review(vault, verbose=False)
    if result["conflicts"]:
        print(f"warning: {result['conflicts']} conflict(s) queued to {CONFLICT_FILE} (adjudicate manually)")
    promoted = promote(vault, result["pending"])
    archive_sources(vault, {p["source"] for p in result["pending"]})
    if verbose:
        print(f"auto-promoted {len(promoted)} fact(s) ({result['duplicates']} duplicate(s) skipped)")
        for line in promoted:
            print(f"  + {line[:100]}")
    return len(promoted)


# --------------------------------------------------------------------------
# Adjudication: interactive conflict resolution
# --------------------------------------------------------------------------


def adjudicate(vault: Path) -> None:
    conflicts = read_conflicts(vault)
    if not conflicts:
        print("no pending conflicts — nothing to adjudicate")
        return
    print(f"{len(conflicts)} conflict(s) in {CONFLICT_FILE}:")
    for i, entry in enumerate(conflicts, 1):
        print(f"\n--- conflict {i} ---")
        print(f"  new: {entry.get('新', '')}")
        print(f"  old: {entry.get('旧', '')}")
        print(f"  src: {entry.get('来源', '')}")
        choice = input("decision [用新/保留旧/并存/跳过] (default 跳过): ").strip() or "跳过"
        if choice not in ("用新", "保留旧", "并存", "跳过"):
            print(f"  unknown choice {choice!r} — treated as 跳过")
            choice = "跳过"
        if choice in ("用新", "并存"):
            doc_id = entry.get("目标") or classify(entry.get("新", ""))
            target = canonical_path(vault, doc_id) if doc_id in CANONICAL_DOCS else target_path(vault, doc_id)
            with file_lock(vault):
                existing = read_maybe(target)
                line = f"- {entry.get('新', '')}{write_stamp(entry.get('来源', 'inbox'))}\n"
                atomic_write(target, existing + ("" if existing.endswith("\n") else "\n") + line)
        # 保留旧 and 跳过: do not touch canonical; the submission stays archived by the next --apply/--auto
        # 保留旧 and 跳过: do not touch canonical; the submission stays archived by the next --apply/--auto
        record_adjudication(vault, entry, choice)
        remove_conflict(vault, entry)
    print("\nadjudication recorded in " + str(situation_dir(vault) / ADJUDICATED_FILE))


# --------------------------------------------------------------------------
# Scheduler registration (one of several equivalent options)
# --------------------------------------------------------------------------


def register_cron(vault: Path) -> None:
    promoter = str(Path(sys.executable).resolve())
    module = str(Path(__file__).resolve())
    system = platform.system()
    if system == "Windows":
        bat = situation_dir(vault).parent / "promote_daily.bat"
        # UTF-8 BOM so cmd.exe/PowerShell 5.1 read non-ASCII paths correctly.
        content = (
            "@echo off\r\n"
            f"chcp 65001 >nul\r\n"
            f"\"{promoter}\" -m unified_memory.promoter --auto --vault \"{vault}\"\r\n"
        )
        bat.write_bytes(b"\xef\xbb\xbf" + content.encode("utf-8"))
        task = "UnifiedMemoryPromote"
        subprocess.run(
            ["schtasks", "/Create", "/TN", task, "/TR", str(bat), "/SC", "DAILY", "/ST", "03:00", "/F"],
            check=False,
        )
        print(f"scheduled daily promotion at 03:00 via Windows Task Scheduler ({task})")
        print(f"script: {bat}")
    else:
        cron = "\n".join(
            [
                "# unified-agent-memory daily promotion (added by promoter --cron)",
                f"0 3 * * * {promoter} -m unified_memory.promoter --auto --vault {shlex_quote(str(vault))} >> {shlex_quote(str(vault / 'promote.log'))} 2>&1",
                "",
            ]
        )
        existing = ""
        crontab_path = Path.home() / ".crontab"
        if crontab_path.exists():
            existing = crontab_path.read_text(encoding="utf-8")
        if "unified_memory.promoter" in existing:
            print("cron entry already present — nothing changed")
            return
        crontab_path.write_text(existing + cron, encoding="utf-8")
        subprocess.run(["crontab", str(crontab_path)], check=False)
        print("scheduled daily promotion at 03:00 via crontab")
        print(f"entries written to {crontab_path}")


def shlex_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="promoter", description="unified memory promoter (sole promotion entry point)")
    parser.add_argument("--vault", default=None, help="vault path (default: config/env)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--review", action="store_true", help="build the pending list only (default)")
    group.add_argument("--apply", action="store_true", help="execute the pending list")
    group.add_argument("--auto", action="store_true", help="review + apply in one step (explicit opt-in)")
    group.add_argument("--cron", action="store_true", help="register a daily schedule")
    group.add_argument("--adjudicate", action="store_true", help="interactive conflict resolution")
    args = parser.parse_args(argv)

    vault = Path(args.vault) if args.vault else resolve_vault()
    if args.adjudicate:
        adjudicate(vault)
        return
    if args.cron:
        register_cron(vault)
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


if __name__ == "__main__":
    main()
