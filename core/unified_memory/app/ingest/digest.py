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
    python -m unified_memory.digest --queue    (drain the hook queue, batch E3)
    python -m unified_memory.digest --off      (disable)
    python -m unified_memory.digest --on       (re-enable)

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

from ...infra.providers import embed
from ...infra import hookstate, sessiondb
from ...domain.markdown import looks_like_credential, redact
from ...infra.config import parse_config, resolve_vault
from ...infra import config as config_mod
from ...infra.store import get_meta, record_audit, set_meta
from ...infra.transcripts.claude_code import claude_code_transcript
from ...infra.vault import atomic_create, atomic_write, canonical_dir, read_maybe

SESSION_DIRS = ("会话归档", "Hermes会话自动归档")
CHAT_URL = "https://api.siliconflow.cn/v1/chat/completions"
DEFAULT_CHAT_MODEL = "Qwen/Qwen2.5-14B-Instruct"  # 7B missed facts buried in session noise; 8B (reasoning) burns TPM — see CHANGELOG 0.12.0
MAX_INPUT_CHARS = 6000      # per-chunk cap sent to the LLM (3C: chunked, not tail-truncated)
CHUNK_OVERLAP = 500         # context shared between neighbouring chunks (3C)
MAX_FACTS_PER_FILE = 30
CURSOR_KEY = "digest_cursor"
STATE_CURSOR_KEY = "digest_cursor_state"
CONFIG_ENABLED_KEY = "digest.enabled"
SOURCES = ("archive", "state", "queue")
DONE_KEEP = 5000  # batch D4: queue.done line cap (oldest dropped)

SYSTEM_PROMPT = (
    "你是记忆提炼助手。下面是一段 Agent 会话记录，请逐段仔细阅读，提取所有值得长期记忆的"
    "持久事实：用户偏好（语言/格式/风格）、技术决策及原因、路径/端口/服务/配置、工程规则、"
    "项目状态与下一步。"
    "输出要求：每条一行、以“- ”开头、保留具体数值与路径，即使只有一条也要输出；"
    "会话里确实没有任何值得记忆的内容时才输出“- (无)”。"
    "示例：会话说“数据库从 14 迁到 16” → 输出“- 生产数据库从 Postgres 14 迁移到 Postgres 16”。"
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
    took no lock, so racing `memory use` could silently drop `vault:`.
    """
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


def _transcript_of(path: Path) -> str:
    """The archive's full text, redacted. 3C: no tail truncation here — the
    extraction stage chunks the whole session instead, so the head of a long
    session is no longer dropped without a trace."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    return redact(raw)


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


def chat_completion(messages: list[dict], *, temperature: float, max_tokens: int) -> str | None:
    """One SiliconFlow chat call; the assistant text, or None on any failure.

    The one HTTP path every LLM feature shares (digest extraction, 3B drift
    entailment): no key or any transport/shape failure degrades to None and
    the caller reports it — never raises into the caller's flow.
    """
    key = embed.get_api_key()
    if not key:
        return None
    payload = {
        "model": DEFAULT_CHAT_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
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
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return None


def _chunk_transcript(
    text: str, cap: int = MAX_INPUT_CHARS, overlap: int = CHUNK_OVERLAP
) -> list[str]:
    """Sliding windows of <= cap chars sharing `overlap` chars between
    neighbours (3C), so a fact straddling a boundary is visible from both
    sides. A single chunk when the text already fits."""
    if len(text) <= cap:
        return [text]
    step = cap - overlap
    chunks: list[str] = []
    start = 0
    while start < len(text):
        chunks.append(text[start : start + cap])
        if start + cap >= len(text):
            break
        start += step
    return chunks


def _extract_facts_chunked(transcript: str) -> tuple[list[str] | None, int, int]:
    """Per-chunk extraction with cross-chunk dedup (3C).

    Returns (facts, chars_sent, chars_total). ``facts`` is None when ANY chunk
    failed: a partial extraction must neither be written nor advance the
    cursor — the same no-silent-loss guarantee the single-shot path had. The
    per-file fact cap applies to the aggregate.
    """
    total = len(transcript)
    seen: set[str] = set()
    facts: list[str] = []
    sent = 0
    for chunk in _chunk_transcript(transcript):
        extracted = chat_extract_facts(chunk)
        if extracted is None:
            return None, sent, total
        sent += len(chunk)
        for fact in extracted:
            key = " ".join(fact.split())
            if key not in seen:
                seen.add(key)
                facts.append(fact)
    return facts[:MAX_FACTS_PER_FILE], sent, total


def chat_extract_facts(transcript: str) -> list[str] | None:
    """Ask the SiliconFlow chat model to distill facts; None on any failure."""
    content = chat_completion(
        [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": transcript},
        ],
        temperature=0.2,
        max_tokens=1200,
    )
    if content is None:
        return None
    return _parse_facts(content)


def _write_digest_facts(vault: Path, facts: list[str], origin: str = "") -> int:
    if not facts:
        return 0
    inbox = canonical_dir(vault) / "Agent提交区"
    inbox.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    body = "\n".join(f"- {f}" for f in facts) + "\n"
    if origin:
        # 3A provenance (P0-3): the machine-readable source line review reads
        # back so a digest fact can be traced to its session archive after
        # promotion. A comment never parses as a fact line (fact_lines skips
        # it), so this cannot leak a fact into the pending list by itself.
        body = f"<!-- digest-source: {origin} -->\n" + body
    for seq in range(1, 100):
        candidate = inbox / f"digest-{stamp}-{seq:02d}.md"
        if atomic_create(candidate, body):
            record_audit(
                vault, "digest", "digest", candidate.name, str(len(facts))
            )
            return len(facts)
    return 0


def _cursor(vault: Path, key: str = CURSOR_KEY) -> str:
    return get_meta(vault, key)


def _queue_units() -> tuple[list[tuple[str, str, str, str]], dict[str, str]]:
    """Hook-queue entries -> digest work units plus their paths (done-marking).

    The queue is written by the hook runtime's session-end (E1) and drained
    here. Idempotency lives in queue.done (one path per line): already
    processed paths are skipped; bad lines and missing transcripts are skipped
    too (the drain never crashes on a bad entry). The transcript itself goes
    through the platform adapter, which redacts every line at its exit. The
    fourth field is the provenance origin (3A): the transcript path, verbatim.
    """
    queue = hookstate.queue_path()
    if not queue.is_file():
        return [], {}
    done: set[str] = set()
    done_file = hookstate.done_path()
    if done_file.is_file():
        done = {
            ln.strip()
            for ln in done_file.read_text(encoding="utf-8", errors="replace").splitlines()
            if ln.strip()
        }
    units: list[tuple[str, str, str, str]] = []
    paths: dict[str, str] = {}
    for raw in queue.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict):
            continue
        path = str(entry.get("path", "") or "").strip()
        if not path or path in done:
            continue
        transcript_file = Path(path)
        if not transcript_file.is_file():
            continue
        ts = str(entry.get("ts", "") or "")
        label = f"claude-code {transcript_file.name}"
        if label in paths:
            label = f"{label} #{len(units) + 1}"
        units.append((label, ts[:10], claude_code_transcript(transcript_file), path))
        paths[label] = path
    return units, paths


def _mark_queue_done(path: str) -> None:
    """Record a processed queue path (read + atomic_write: only infra.vault may
    open files for writing — the B4 writes boundary, same pattern
    queue.record_adjudication uses).

    The done file is capped at DONE_KEEP lines (batch D4): a hook queue runs
    forever, so the oldest entries are dropped once the cap is hit — a path
    older than that simply becomes eligible for reprocessing, which the
    extraction's own dedup handles.
    """
    done_file = hookstate.done_path()
    lines = [ln.strip() for ln in read_maybe(done_file).splitlines() if ln.strip()]
    lines.append(path)
    if len(lines) > DONE_KEEP:
        lines = lines[-DONE_KEEP:]
    atomic_write(done_file, "\n".join(lines) + "\n")


def _units(vault: Path, source: str, cursor: str) -> list[tuple[str, str, str, str]]:
    """Collect ``(label, date, transcript, origin)`` work items newer than the
    cursor.

    Both sources are projected onto the same quadruple, which is why digest
    never has to know where a transcript came from — except for provenance
    (3A), where the origin IS the answer: the archive path relative to the
    vault, or the state.db day. Archive files are read lazily so a no-op run
    does not touch 82 files; the state source already filters by date inside
    SQL.
    """
    if source == "state":
        return [
            (f"state.db {day}", day, transcript, f"state.db {day}")
            for day, transcript in sessiondb.dated_transcripts(since=cursor)
        ]
    return [
        (p.name, _date_of(p), _transcript_of(p), str(p.relative_to(vault)))
        for p in _archive_files(vault)
        if _date_of(p) > cursor
    ]


def _pending_units(vault: Path, source: str, cursor_key: str) -> tuple[list[tuple[str, str, str, str]], dict | None, dict[str, str]]:
    """Collect the work units for one digest source.

    Returns (pending, degraded-report-or-None, queue-paths): an unreadable
    Hermes database is a degraded source, not a crash — the archive path still
    works and the reason is reported instead of raising. Queue paths map each
    unit label to its transcript path for done-marking.
    """
    if source == "queue":
        pending, paths = _queue_units()
        return pending, None, paths
    if source == "state":
        try:
            return _units(vault, source, _cursor(vault, cursor_key)), None, {}
        except sessiondb.SessionDbUnavailable as exc:
            return [], {
                "files": 0, "pending": 0, "written": 0, "facts": 0,
                "skipped": [f"state.db: {exc}"], "source": source,
            }, {}
    return _units(vault, source, _cursor(vault, cursor_key)), None, {}


def digest(vault: Path, dry_run: bool = False, limit: int = 0, source: str = "archive") -> dict:
    """Process units newer than the source's cursor. Returns a report dict."""
    if source not in SOURCES:
        raise ValueError(f"source must be one of {SOURCES}, got {source!r}")
    cursor_key = STATE_CURSOR_KEY if source == "state" else CURSOR_KEY
    avail_files = len(_archive_files(vault))
    pending, degraded, queue_paths = _pending_units(vault, source, cursor_key)
    if limit > 0:
        pending = pending[:limit]
    report = {
        "files": avail_files, "pending": len(pending), "written": 0, "facts": 0,
        "skipped": [], "source": source, "charsSent": 0, "charsTotal": 0,
    }
    if degraded is not None:
        return degraded
    if not pending:
        return report
    if not embed.configured():
        report["skipped"].append("no SiliconFlow API key (digest requires it)")
        return report
    for label, date, transcript, origin in pending:
        facts, sent, total = _extract_facts_chunked(transcript)
        report["charsSent"] += sent
        report["charsTotal"] += total
        if facts is None:
            # 3C: a failed chunk means an incomplete extraction — the unit is
            # skipped whole (no partial write, cursor untouched).
            report["skipped"].append(f"{label} (chunk extraction failed, {sent}/{total} chars sent)")
            continue
        if not dry_run:
            written = _write_digest_facts(vault, facts, origin=origin)
            if facts and not written:
                # The inbox could not allocate a file. Do NOT advance the
                # cursor / mark the queue entry done: the old code did, so the
                # extracted facts were lost permanently even though the next
                # run could have written them.
                report["skipped"].append(f"{label} (could not write inbox)")
                continue
            report["written"] += 1 if written else 0
            report["facts"] += written
        else:
            report["facts"] += len(facts)
            # Preview lines go to stderr so programmatic callers (e.g. the
            # Hermes dream promoter) get pure JSON on stdout.
            print(f"[dry-run] {label}: {len(facts)} fact(s), {sent}/{total} chars sent", file=sys.stderr)
            for f in facts[:6]:
                print(f"    - {f[:70]}", file=sys.stderr)
        # Advance the cursor / mark the queue entry done only on a real run
        # (and only after a successful extraction) so a dry-run never consumes
        # a session.
        if not dry_run:
            if source == "queue":
                _mark_queue_done(queue_paths[label])
            else:
                set_meta(vault, cursor_key, date)
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
        help="where to read sessions from: the Markdown archive (default), Hermes state.db, or the hook queue",
    )
    parser.add_argument(
        "--queue",
        action="store_true",
        help="drain the hook queue (UNIFIED_MEMORY_HOOK_STATE/queue.jsonl) — same as --source queue",
    )
    parser.add_argument("--off", action="store_true", help="disable the session digest")
    parser.add_argument("--on", action="store_true", help="re-enable a digest turned off with --off")
    args = parser.parse_args(argv)
    vault = Path(args.vault) if args.vault else resolve_vault()

    if args.queue and args.source != "archive":
        raise SystemExit("digest: --queue and --source are mutually exclusive")
    if args.off and args.on:
        raise SystemExit("digest: --on and --off are mutually exclusive")
    if args.off:
        _set_enabled(config_mod.CONFIG_PATH, False)
        print("session digest disabled (digest.enabled=false)")
        return
    if args.on:
        # --off had no counterpart: once disabled, the only way back was to
        # hand-edit the config file that --off itself had just written.
        _set_enabled(config_mod.CONFIG_PATH, True)
        print("session digest enabled (digest.enabled=true)")
        return
    if not digest_enabled(config_mod.CONFIG_PATH):
        print("session digest is disabled (run `memory digest --on` to re-enable)")
        return
    source = "queue" if args.queue else args.source
    report = digest(vault, dry_run=args.dry_run, limit=args.limit, source=source)
    print(
        f"digest [{report['source']}]: {report['pending']} new unit(s), wrote "
        f"{report['written']} file(s), {report['facts']} fact(s)"
    )
    for skipped in report["skipped"]:
        print(f"  skipped: {skipped}")


if __name__ == "__main__":
    main()
