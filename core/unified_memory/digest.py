# -*- coding: utf-8 -*-
"""digest — extract durable facts from archived sessions (optional, default on).

New sessions archived under 50-Agent-Context/会话归档/ (and the Hermes auto
archive Hermes会话自动归档/) are summarized by a small LLM call (SiliconFlow
chat completions, OpenAI-compatible) into durable facts. The facts are written
into the submission inbox as ``digest-<ts>.md`` and flow through the normal
promoter lifecycle — nothing is ever written to canonical notes directly.

Guarantees:

  - Idempotent: a per-vault cursor (index_meta 'digest_cursor') tracks the last
    processed archive date; only newer files are considered.
  - Safe: transcripts are redacted BEFORE being sent to the LLM, and the LLM
    output is redacted + credential-checked before being written to the inbox.
  - Reversible: facts land in Agent提交区 only; the promoter's review/apply
    gates them.
  - Degradable: no key / network failure → the digest run is skipped with a
    clear note; the archive is never modified.

Usage:
    python -m unified_memory.digest            (extract new sessions)
    python -m unified_memory.digest --dry-run  (preview without writing)
    python -m unified_memory.digest --source state   (read Hermes state.db too)
    python -m unified_memory.digest --off      (disable)

Two sources exist because two kinds of session exist. The archive is the
normal path; ``--source state`` additionally reads Hermes's ``state.db``, which
holds sessions that were never archived as Markdown (191 of 369 on the machine
this was measured on, all predating the archiver). Each source keeps its own
cursor, so switching between them never re-bills a date or skips one.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import embed, index
from .common import (
    atomic_create,
    canonical_dir,
    looks_like_credential,
    parse_config,
    redact,
    resolve_vault,
)

SESSION_DIRS = ("会话归档", "Hermes会话自动归档")
CHAT_URL = "https://api.siliconflow.cn/v1/chat/completions"
DEFAULT_CHAT_MODEL = "Qwen/Qwen2.5-7B-Instruct"
MAX_INPUT_CHARS = 6000      # per-file transcript cap sent to the LLM
MAX_FACTS_PER_FILE = 30
CURSOR_KEY = "digest_cursor"
STATE_CURSOR_KEY = "digest_cursor_state"
CONFIG_ENABLED_KEY = "digest.enabled"
SOURCES = ("archive", "state")

SYSTEM_PROMPT = (
    "你是记忆提炼助手。从下面的 Agent 会话记录中提取值得长期记忆的持久事实，例如："
    "用户偏好（语言/格式/风格/语气）、技术决策及原因、路径/端口/服务/配置、工程规则与流程、"
    "项目状态与下一步。忽略临时对话、闲聊、一次性任务细节。"
    "每行输出一条事实，以“- ”开头；如果没有任何值得记忆的内容，输出“- (无)”。"
    "绝不输出 API key、token、密码、私钥等敏感凭据。"
)


def digest_enabled(config_path: Path) -> bool:
    """digest is on by default; a config ``digest.enabled: false`` turns it off."""
    try:
        cfg = parse_config(config_path)
    except OSError:
        return True
    return cfg.get(CONFIG_ENABLED_KEY, "true").strip().lower() != "false"


def _set_enabled(config_path: Path, enabled: bool) -> None:
    """Flip ``digest.enabled`` through the single config writer.

    This used to be a second read-modify-write of ~/.unified-memory.yaml that
    took no lock, so racing `memory use` could silently drop ``vault:``.
    """
    from . import config as config_mod

    config_mod.set_key(CONFIG_ENABLED_KEY, "true" if enabled else "false", config_path)


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def _archive_files(vault: Path) -> list[Path]:
    ctx = canonical_dir(vault)
    files: list[Path] = []
    for name in SESSION_DIRS:
        d = ctx / name
        if d.is_dir():
            files.extend(
                p for p in d.glob("*.md") if p.is_file() and DATE_RE.match(p.stem)
            )
    return sorted(files)


def _date_of(path: Path) -> str:
    return path.stem[:10]  # YYYY-MM-DD prefix


def _transcript_of(path: Path, cap: int = MAX_INPUT_CHARS) -> str:
    raw = path.read_text(encoding="utf-8", errors="replace")
    # Redact BEFORE sending anywhere; keep the tail (most recent) when long.
    clean = redact(raw)
    return clean[-cap:] if len(clean) > cap else clean


def _parse_facts(text: str) -> list[str]:
    facts: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line in ("-", "—", "- (无)", "（无）", "无"):
            continue
        if line.startswith(("- ", "• ", "* ")):
            line = line[2:].strip()
        if len(line) < 2:  # too short to be a durable fact
            continue
        if line and not looks_like_credential(line):
            facts.append(redact(line))
        if len(facts) >= MAX_FACTS_PER_FILE:
            break
    return facts


def chat_extract_facts(transcript: str) -> list[str] | None:
    """Ask the SiliconFlow chat model to distill facts; None on any failure."""
    key = embed.get_api_key()
    if not key:
        return None
    payload = {
        "model": DEFAULT_CHAT_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": transcript},
        ],
        "temperature": 0.2,
        "max_tokens": 1200,
    }
    req = urllib.request.Request(
        CHAT_URL,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, json.JSONDecodeError):
        return None
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return None
    return _parse_facts(content)


def _write_digest_facts(vault: Path, facts: list[str]) -> int:
    if not facts:
        return 0
    inbox = canonical_dir(vault) / "Agent提交区"
    inbox.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    body = "\n".join(f"- {f}" for f in facts) + "\n"
    for seq in range(1, 100):
        candidate = inbox / f"digest-{stamp}-{seq:02d}.md"
        if atomic_create(candidate, body):
            return len(facts)
    return 0


def _cursor(conn, key: str = CURSOR_KEY) -> str:
    row = conn.execute("SELECT value FROM index_meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else ""


def _units(vault: Path, source: str, cursor: str) -> list[tuple[str, str, str]]:
    """Collect ``(label, date, transcript)`` work items newer than ``cursor``.

    Both sources are projected onto the same triple, which is why digest never
    has to know where a transcript came from. Archive files are read lazily so
    a no-op run does not touch 82 files; the state source already filters by
    date inside SQL.
    """
    if source == "state":
        from . import sessiondb

        return [
            (f"state.db {day}", day, transcript)
            for day, transcript in sessiondb.dated_transcripts(since=cursor)
        ]
    return [
        (p.name, _date_of(p), _transcript_of(p))
        for p in _archive_files(vault)
        if _date_of(p) > cursor
    ]


def digest(vault: Path, dry_run: bool = False, limit: int = 0, source: str = "archive") -> dict:
    """Process units newer than the source's cursor. Returns a report dict."""
    if source not in SOURCES:
        raise ValueError(f"source must be one of {SOURCES}, got {source!r}")
    cursor_key = STATE_CURSOR_KEY if source == "state" else CURSOR_KEY
    avail_files = len(_archive_files(vault))
    conn = index.get_conn(vault)
    try:
        cursor = _cursor(conn, cursor_key)
    finally:
        conn.close()
    if source == "state":
        from . import sessiondb

        try:
            pending = _units(vault, source, cursor)
        except sessiondb.SessionDbUnavailable as exc:
            # An unreadable or upgraded database is a degraded source, not a
            # crash: the archive path still works and the reason is reported.
            return {
                "files": 0, "pending": 0, "written": 0, "facts": 0,
                "skipped": [f"state.db: {exc}"], "source": source,
            }
    else:
        pending = _units(vault, source, cursor)
    if limit > 0:
        pending = pending[:limit]
    report = {
        "files": avail_files, "pending": len(pending), "written": 0, "facts": 0,
        "skipped": [], "source": source,
    }
    if not pending:
        return report
    if not embed.configured():
        report["skipped"].append("no SiliconFlow API key (digest requires it)")
        return report
    for label, date, transcript in pending:
        facts = chat_extract_facts(transcript)
        if facts is None:
            report["skipped"].append(label)
            continue
        if not dry_run:
            written = _write_digest_facts(vault, facts)
            if facts and not written:
                # The inbox could not allocate a file. Do NOT advance the
                # cursor: the old code did, so the extracted facts were lost
                # permanently even though the next run could have written them.
                report["skipped"].append(f"{label} (could not write inbox)")
                continue
            report["written"] += 1 if written else 0
            report["facts"] += written
        else:
            report["facts"] += len(facts)
            # Preview lines go to stderr so programmatic callers (e.g. the
            # Hermes dream promoter) get pure JSON on stdout.
            print(f"[dry-run] {label}: {len(facts)} fact(s)", file=sys.stderr)
            for f in facts[:6]:
                print(f"    - {f[:70]}", file=sys.stderr)
        # Advance the cursor only on a real run (and only after a successful
        # extraction) so a dry-run never consumes a session.
        if not dry_run:
            conn = index.get_conn(vault)
            try:
                conn.execute(
                    "INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)",
                    (cursor_key, date),
                )
                conn.commit()
            finally:
                conn.close()
    return report


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="memory digest", description="extract durable facts from archived sessions")
    parser.add_argument("--vault", default=None, help="vault path (default: config/env)")
    parser.add_argument("--dry-run", action="store_true", help="preview extractions without writing to the inbox")
    parser.add_argument("--limit", type=int, default=0, help="max archive files to process per run (0 = all)")
    parser.add_argument(
        "--source",
        choices=SOURCES,
        default="archive",
        help="where to read sessions from: the Markdown archive (default) or Hermes state.db",
    )
    parser.add_argument("--off", action="store_true", help="disable the session digest")
    args = parser.parse_args(argv)
    vault = Path(args.vault) if args.vault else resolve_vault()
    from .common import CONFIG_PATH

    if args.off:
        _set_enabled(CONFIG_PATH, False)
        print("session digest disabled (digest.enabled=false)")
        return
    if not digest_enabled(CONFIG_PATH):
        print("session digest is disabled (set digest.enabled=true to re-enable)")
        return
    report = digest(vault, dry_run=args.dry_run, limit=args.limit, source=args.source)
    print(
        f"digest [{report['source']}]: {report['pending']} new unit(s), wrote "
        f"{report['written']} file(s), {report['facts']} fact(s)"
    )
    for skipped in report["skipped"]:
        print(f"  skipped: {skipped}")


if __name__ == "__main__":
    main()
