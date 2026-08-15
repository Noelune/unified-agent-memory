#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Append a session transcript/summary into the vault's session archive.

Substitute for a hosted runtime's session-history layer. Reads from a file or
stdin, redacts credential-shaped lines, and appends a dated block under
50-Agent-Context/会话归档/.

Usage:
    python integrations/hermes/archive_session.py [--vault <path>] [--agent NAME] [--title "T"] [--file <path>]
    ... | python integrations/hermes/archive_session.py [--vault <path>] --title "T"
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "core"))

from unified_memory.common import atomic_write, ensure_vault, file_lock, redact, resolve_vault, session_dir  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="archive_session")
    ap.add_argument("--vault", default=None)
    ap.add_argument("--agent", default="agent", help="agent name used in the header")
    ap.add_argument("--title", default="", help="short session title")
    ap.add_argument("--file", default=None, help="read transcript from this file instead of stdin")
    args = ap.parse_args(argv)
    vault = Path(args.vault) if args.vault else resolve_vault()
    try:
        ensure_vault(vault)
    except RuntimeError as exc:
        raise SystemExit(str(exc))
    raw = Path(args.file).read_text(encoding="utf-8", errors="replace") if args.file else sys.stdin.read()
    lines = [redact(ln.rstrip()) for ln in raw.splitlines() if ln.strip()]
    if not lines:
        print("nothing to archive (empty input)")
        return 0
    now = dt.datetime.now()
    target_dir = session_dir(vault)
    target = target_dir / f"{now.strftime('%Y-%m-%d')}.md"
    target_dir.mkdir(parents=True, exist_ok=True)
    header = f"## {now.strftime('%H:%M')} [{args.agent}] {args.title}".rstrip()
    body = [header, ""] + [ln if ln.startswith(("- ", "• ", "* ")) else f"- {ln}" for ln in lines] + [""]
    # Read-append-write under the vault lock so concurrent post-turn hooks
    # archiving to the same daily file never drop each other's blocks.
    with file_lock(vault):
        existing = target.read_text(encoding="utf-8") if target.exists() else ""
        atomic_write(target, existing + "\n".join(body))
    print(f"archived {len(lines)} line(s) -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
