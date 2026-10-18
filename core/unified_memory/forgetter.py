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
    is_versioned,
    parse_stamp,
    read_maybe,
    resolve_vault,
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
# servers, credentials references, and agent coordination rules. The Chinese
# terms mirror the vault's own 记忆系统规范 list — without them the protection
# only worked for English facts, while the live vault is mostly Chinese.
PROTECTED_RE = re.compile(
    r"path|directory|config|prefer|account|server|port|credential|password|secret|"
    r"model|domain|backup|script|rule|coordinat|agent|vault|endpoint|api|url|"
    r"路径|目录|配置|偏好|账号|账户|服务器|端口|凭据|密码|密钥|模型|域名|备份|"
    r"脚本|规则|协作|代理|仓库|接口|地址|环境|版本|工具|项目|红线|流程",
    re.I,
)
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


def memory_score(importance: float, access_count: int, age_days: float) -> float:
    """Salience × (durable floor + decay) + access reinforcement, clipped to [0, 1].

    ``importance`` is the long-term anchor: above the floor it keeps a memory
    alive indefinitely (preferences, architecture, rules); at or below it the
    exponential decay eventually drops the score under FORGET_THRESHOLD.
    """
    decay = (1.0 - DURABLE_FLOOR) * math.exp(-DECAY_LAMBDA * age_days) + DURABLE_FLOOR
    reinforcement = min(MAX_REINFORCEMENT, 0.08 * math.log1p(max(0, access_count)))
    return min(1.0, importance * decay + reinforcement)


def _index_stats(vault: Path, doc: str, bare: str) -> tuple[float, int, str] | None:
    """Return (importance, access_count, last_access_at) for a memory line.

    ``updated_at`` is unusable as a "last used" signal: indexing and embedding
    also touch it. The access_log timestamp is the actual read receipt, which
    is what the reinforcement model is supposed to reward.
    """
    try:
        conn = index.get_conn(vault)
        try:
            row = conn.execute(
                "SELECT m.importance, m.access_count, "
                "(SELECT MAX(a.at) FROM access_log a WHERE a.memory_id = m.id) AS last_access "
                "FROM memories m WHERE m.doc = ? AND m.line = ? LIMIT 1",
                (doc, bare),
            ).fetchone()
            if row is None:
                row = conn.execute(
                    "SELECT m.importance, m.access_count, "
                    "(SELECT MAX(a.at) FROM access_log a WHERE a.memory_id = m.id) AS last_access "
                    "FROM memories m WHERE m.line = ? LIMIT 1",
                    (bare,),
                ).fetchone()
            if row is None:
                return None
            return float(row["importance"]), int(row["access_count"]), str(row["last_access"] or "")
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 — never let the index break forgetting
        return None


def _days_since(value: str, now: float) -> float | None:
    """Days between a stored ``YYYY-MM-DD…`` timestamp and ``now``."""
    text = (value or "")[:10]
    if len(text) != 10:
        return None
    try:
        return max(0.0, (now - time.mktime(time.strptime(text, "%Y-%m-%d"))) / 86400)
    except (ValueError, OverflowError):
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
            # Prefer index-derived importance/access; fall back to a keyword
            # salience and the line's own usage tag.
            stats = _index_stats(vault, str(path), parsed["bare"])
            if stats is not None:
                importance, access, last_access = stats
            else:
                importance = index.salience_for(index.classify_type(parsed["bare"]))
                access = parsed["used"]
                last_access = ""
            # Ebbinghaus-style reinforcement: a recently recalled fact has not
            # "gone unused", even if it was written long ago.
            touched_age = _days_since(last_access, today)
            effective_age = min(age_days, touched_age) if touched_age is not None else age_days
            score = memory_score(importance, access, effective_age)
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
