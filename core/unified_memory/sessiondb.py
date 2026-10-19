# -*- coding: utf-8 -*-
"""sessiondb — read Hermes's ``state.db`` as dated transcripts (read-only).

Why this exists: ``digest`` distils facts from archive Markdown under
``50-Agent-Context/会话归档/`` and ``Hermes会话自动归档/``. Sessions that were
never archived therefore never become facts. On the machine this was measured
on, 191 of 369 sessions — 8616 messages, all between 2026-05-30 and
2026-08-28 — sat in ``state.db`` with no archive file covering their date.

The fix is deliberately narrow. This module does not import digest's logic and
digest does not learn Hermes's schema; the only thing that crosses the boundary
is the existing contract, a ``(date, transcript)`` pair. Everything here is
read-only: the database is opened with ``mode=ro`` so a bug cannot corrupt an
841 MB production state file, and the transcript is redacted before it leaves
this module because it is on its way to an LLM.

Schema drift is expected, not exceptional: Hermes owns this database and
changes it across releases (``schema_version`` was 32 when this was written).
``probe()`` therefore checks the columns it actually uses and raises a message
naming the missing ones, so an upgrade produces "this no longer works, here is
why" instead of a ``KeyError`` in the middle of a digest run.

Usage:
    python -m unified_memory.sessiondb --status
    python -m unified_memory.sessiondb --since 2026-05-01 --dry-run
    python -m unified_memory.sessiondb --since 2026-05-01 --export ./out
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path

from .common import redact

DB_ENV = "UNIFIED_MEMORY_SESSION_DB"
# Durable facts live in what the human said and what the agent concluded. Tool
# output is mostly file dumps and command noise (11615 of 22198 messages on the
# machine this was written for), and session_meta is bookkeeping.
DEFAULT_ROLES = ("user", "assistant")
MAX_TRANSCRIPT_CHARS = 6000   # matches digest.MAX_INPUT_CHARS
MAX_MESSAGES_PER_SESSION = 60

REQUIRED_SESSION_COLUMNS = ("id", "started_at")
REQUIRED_MESSAGE_COLUMNS = ("session_id", "role", "content", "timestamp")


class SessionDbUnavailable(RuntimeError):
    """The database is absent, unreadable, or its schema moved."""


def resolve_db(path: Path | str | None = None) -> Path:
    """Locate ``state.db``: explicit argument, then env, then Hermes's default."""
    if path:
        return Path(path).expanduser()
    override = os.environ.get(DB_ENV, "").strip()
    if override:
        return Path(override).expanduser()
    local = os.environ.get("LOCALAPPDATA", "").strip()
    if local:
        return Path(local) / "hermes" / "state.db"
    return Path.home() / ".local" / "share" / "hermes" / "state.db"


def _connect(db: Path) -> sqlite3.Connection:
    """Open read-only. ``mode=ro`` is the whole safety story: no writes, no DDL."""
    if not db.is_file():
        raise SessionDbUnavailable(f"session database not found: {db}")
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5.0)
    except sqlite3.Error as exc:  # pragma: no cover - filesystem dependent
        raise SessionDbUnavailable(f"cannot open {db} read-only: {exc}") from exc
    conn.row_factory = sqlite3.Row
    return conn


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}


def probe(db: Path | str | None = None) -> dict:
    """Report what this database looks like, or raise if it is unusable.

    Raises ``SessionDbUnavailable`` naming the columns that are missing, which
    is the difference between "Hermes upgraded and this needs a look" and an
    unexplained failure inside a digest run.
    """
    path = resolve_db(db)
    conn = _connect(path)
    try:
        session_cols = _columns(conn, "sessions")
        message_cols = _columns(conn, "messages")
        missing_sessions = [c for c in REQUIRED_SESSION_COLUMNS if c not in session_cols]
        missing_messages = [c for c in REQUIRED_MESSAGE_COLUMNS if c not in message_cols]
        if missing_sessions or missing_messages:
            raise SessionDbUnavailable(
                f"{path} is not a readable Hermes state database: "
                f"sessions is missing {missing_sessions or 'nothing'}, "
                f"messages is missing {missing_messages or 'nothing'}. "
                "Hermes changed its schema; update sessiondb.py's column list."
            )
        version = None
        try:
            row = conn.execute("SELECT * FROM schema_version").fetchone()
            version = row[0] if row else None
        except sqlite3.Error:
            pass
        sessions = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        messages = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        first, last = conn.execute(
            "SELECT MIN(started_at), MAX(started_at) FROM sessions"
        ).fetchone()
        return {
            "path": str(path),
            "schema_version": version,
            "sessions": sessions,
            "messages": messages,
            "first_session": _iso(first),
            "last_session": _iso(last),
        }
    finally:
        conn.close()


def available(db: Path | str | None = None) -> bool:
    """True when a usable database is present (never raises)."""
    try:
        probe(db)
        return True
    except (SessionDbUnavailable, sqlite3.Error):
        return False


def _iso(ts: float | None) -> str:
    if not ts:
        return ""
    return time.strftime("%Y-%m-%d", time.localtime(ts))


def _session_transcript(conn: sqlite3.Connection, session_id: str) -> str:
    placeholders = ",".join("?" * len(DEFAULT_ROLES))
    rows = conn.execute(
        f"SELECT role, content FROM messages "
        f"WHERE session_id = ? AND role IN ({placeholders}) "
        f"AND content IS NOT NULL AND content <> '' "
        f"ORDER BY timestamp ASC, id ASC LIMIT ?",
        (session_id, *DEFAULT_ROLES, MAX_MESSAGES_PER_SESSION),
    )
    parts: list[str] = []
    for row in rows:
        speaker = "用户" if row["role"] == "user" else "助手"
        parts.append(f"{speaker}: {row['content']}")
    return "\n\n".join(parts)


def dated_transcripts(
    db: Path | str | None = None,
    since: str = "",
    cap: int = MAX_TRANSCRIPT_CHARS,
) -> list[tuple[str, str]]:
    """Yield ``(YYYY-MM-DD, transcript)`` for sessions newer than ``since``.

    One entry per *chunk*, not per day: a busy day (126 sessions / 5925 messages
    on 2026-06-01 on the machine this was written for) would otherwise be
    reduced to its last 6000 characters, which is one session's tail. Chunks
    break on session boundaries and never exceed ``cap``, so a day can produce
    several entries. ``since`` is a lower bound on the *date string*, matching
    digest's cursor, which stores the last processed date; all chunks of a date
    are produced in one pass, so a date is only ever skipped once it is done.

    Every transcript is redacted here — the caller's next step is an LLM call.
    """
    path = resolve_db(db)
    conn = _connect(path)
    try:
        if not since:
            rows = conn.execute(
                "SELECT id, started_at, title FROM sessions "
                "ORDER BY started_at ASC"
            ).fetchall()
        else:
            cutoff = _start_of_day(since)
            rows = conn.execute(
                "SELECT id, started_at, title FROM sessions "
                "WHERE started_at >= ? ORDER BY started_at ASC",
                (cutoff,),
            ).fetchall()

        per_day: dict[str, list[str]] = {}
        for row in rows:
            day = _iso(row["started_at"])
            if not day or day <= since:
                continue
            body = _session_transcript(conn, row["id"])
            if not body.strip():
                continue
            title = (row["title"] or "").strip()
            header = f"## {row['id']}" + (f" — {title}" if title else "")
            per_day.setdefault(day, []).append(_clip(redact(f"{header}\n\n{body}"), cap))

        out: list[tuple[str, str]] = []
        for day, sessions in sorted(per_day.items()):
            for chunk in _pack(sessions, cap):
                out.append((day, chunk))
        return out
    finally:
        conn.close()


def _pack(sessions: list[str], cap: int) -> list[str]:
    """Greedily group whole sessions into ``cap``-sized chunks."""
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for session in sessions:
        if current and size + len(session) + 2 > cap:
            chunks.append("\n\n".join(current))
            current, size = [], 0
        current.append(session)
        size += len(session) + 2
    if current:
        chunks.append("\n\n".join(current))
    return chunks


def _start_of_day(date: str) -> float:
    """Local-midnight epoch for ``YYYY-MM-DD`` (so ``>=`` means "on or after")."""
    try:
        parsed = time.strptime(date[:10], "%Y-%m-%d")
    except ValueError:
        return 0.0
    return time.mktime((parsed.tm_year, parsed.tm_mon, parsed.tm_mday, 0, 0, 0, 0, 0, -1))


def _clip(text: str, cap: int) -> str:
    """Keep the tail: the end of a session is where conclusions land."""
    return text[-cap:] if len(text) > cap else text


def export_markdown(
    out_dir: Path | str,
    db: Path | str | None = None,
    since: str = "",
    dry_run: bool = False,
) -> dict:
    """Write archive-format ``YYYY-MM-DD.md`` files into ``out_dir``.

    This is the backfill path for sessions that predate the archiver. It
    deliberately writes *outside* the vault: canonical notes have a single
    declared writer (see ``common.assert_canonical_writable``), and a read-only
    adapter does not get to become a second one just because its output looks
    like an archive file. The operator decides whether to import the result.
    """
    target = Path(out_dir).expanduser()
    pairs = dated_transcripts(db, since=since)
    report = {"dates": len(pairs), "written": 0, "dir": str(target), "dry_run": dry_run}
    if dry_run:
        return report
    target.mkdir(parents=True, exist_ok=True)
    for day, transcript in pairs:
        path = target / f"{day}.md"
        existed = path.exists()
        with path.open("a", encoding="utf-8") as handle:
            if not existed:
                handle.write(f"# 会话归档 {day}\n\n")
            handle.write(transcript + "\n")
        report["written"] += 1
    return report


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="sessiondb",
        description="read Hermes state.db as dated transcripts (read-only)",
    )
    parser.add_argument("--db", default=None, help=f"path to state.db (default: ${DB_ENV} or Hermes's)")
    parser.add_argument("--since", default="", help="only dates after YYYY-MM-DD")
    parser.add_argument("--status", action="store_true", help="report schema and row counts, then exit")
    parser.add_argument("--dry-run", action="store_true", help="count what would be produced, write nothing")
    parser.add_argument("--export", default=None, metavar="DIR", help="write archive-format .md files into DIR")
    parser.add_argument("--show", action="store_true", help="print the transcripts instead of exporting")
    args = parser.parse_args(argv)

    try:
        info = probe(args.db)
    except SessionDbUnavailable as exc:
        print(f"sessiondb: {exc}", file=sys.stderr)
        raise SystemExit(1)

    if args.status or not (args.export or args.show or args.dry_run):
        print(f"database: {info['path']}")
        print(f"schema version: {info['schema_version']}")
        print(f"sessions: {info['sessions']}, messages: {info['messages']}")
        print(f"range: {info['first_session']} .. {info['last_session']}")
        if not (args.export or args.show or args.dry_run):
            return

    if args.show:
        for day, transcript in dated_transcripts(args.db, since=args.since):
            print(f"=== {day} ({len(transcript)} chars) ===")
            print(transcript[:400])
            print("...")
        return

    if args.dry_run and not args.export:
        pairs = dated_transcripts(args.db, since=args.since)
        total = sum(len(t) for _, t in pairs)
        print(f"would export {len(pairs)} date(s), {total} chars")
        for day, transcript in pairs:
            print(f"  {day}: {len(transcript)} chars")
        return

    report = export_markdown(args.export, args.db, since=args.since, dry_run=args.dry_run)
    print(f"exported {report['written']} file(s) to {report['dir']}")


if __name__ == "__main__":
    main()
