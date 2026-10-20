# -*- coding: utf-8 -*-
"""Shared plumbing: configuration, paths, redaction, atomic writes, file locks.

Dependency-free on purpose — everything here is Python standard library.
"""
from __future__ import annotations

import os
import re
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

_THREAD_LOCKS: dict[str, threading.Lock] = {}
_THREAD_LOCKS_GUARD = threading.Lock()


def ensure_utf8_console(stream=None) -> None:
    """Make a text stream tolerate CJK output on non-UTF-8 consoles.

    Windows gives Python a cp1252 stdout/stderr when it is not a real console
    (CI runners, redirected pipes), and core prints CJK paths such as 记忆遗忘区.
    Without this the encode raises UnicodeEncodeError and the command dies.
    Every CLI module imports common, so the call at the bottom of this file
    covers all of them. Safe on streams that cannot be reconfigured.
    """
    for target in (sys.stdout, sys.stderr) if stream is None else (stream,):
        reconfigure = getattr(target, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError, AttributeError):
            pass  # detached or already-closed stream: leave it as-is


ensure_utf8_console()


def _thread_lock_for(vault: Path) -> threading.Lock:
    key = str(vault.expanduser().resolve())
    with _THREAD_LOCKS_GUARD:
        return _THREAD_LOCKS.setdefault(key, threading.Lock())
# --------------------------------------------------------------------------
# Paths & configuration
# --------------------------------------------------------------------------

VAULT_ENV = "UNIFIED_MEMORY_VAULT"
CONFIG_PATH = Path.home() / ".unified-memory.yaml"
DEFAULT_VAULT = Path.home() / "AgentMemory"

AGENT_CONTEXT = "50-Agent-Context"

# Canonical documents: stable ids (used by `memory show <id>`) -> file names.
# Names match the live vault's 50-Agent-Context layout (对齐真实 vault 文件名).
CANONICAL_DOCS = {
    "index": "上下文索引.md",
    "prefs": "我的偏好摘要.md",
    "env": "常用路径与环境.md",
    "rules": "工程执行规则.md",
    "tools": "工具可用性检查.md",
    "ui": "UI审美准则.md",
    "coord": "Codex-Claude-Hermes协作规则.md",
}

SUBMISSION_DIR = "Agent提交区"
PROCESSED_DIR = "已处理"

# Files that live in the submission directory but are NOT submissions.
#
#   README.md      documents the directory.
#   前缀登记.md    the prefix registry that `memory_setup` and the upgrade flow
#                 merge into (src/upgrade-run.ts). A bookkeeping table, never a
#                 batch of facts.
#
# Every inbox reader used to hard-code `name != "README.md"`, and that is exactly
# how the registry became a phantom pending item: the panel listed it under
# 待确认, `status` counted it, the doctor reported "1 inbox file". There was
# nothing to confirm — the file is the plugin's own note to itself.
#
# The consequences were not merely cosmetic. `promote --review` reads every
# unmasked `*.md` as fact lines, so it would have ingested the table rows as
# memories; `dismiss` (the panel's 归档) moves the file into 已处理/, where the
# next upgrade cannot merge it and recreates it with only this runtime's row —
# silently dropping every other runtime's registrations, which the merge exists
# to preserve. One constant, checked at every reader, is what keeps those three
# paths consistent.
NON_SUBMISSION_FILES = frozenset({"README.md", "前缀登记.md"})

SITUATION_DIR = "情境信息"
PENDING_FILE = "待晋升.md"
CONFLICT_FILE = "事实冲突待裁决.md"
ADJUDICATED_FILE = "事实冲突已裁决.md"
# The one note under 情境信息/ that holds facts rather than workflow state.
# Written by promoter's `other` fallback; indexed by index.indexed_files().
UNCLASSIFIED_FACT_REL = "情境信息/未归类事实.md"
FORGET_DIR = "记忆遗忘区"
SESSION_DIR = "会话归档"
LOCK_FILE = ".lock"

# --------------------------------------------------------------------------
# Write coordination
# --------------------------------------------------------------------------
#
# Three functions in this package rewrite canonical notes: `promoter.promote`,
# `forgetter.demote` and `maintenance.repair_existing`. They are the only ones
# that do, and each takes the same per-vault `file_lock` — see
# `core/tests/test_write_lock.py`, which runs them concurrently against one
# vault and fails if any of them forgets.
#
# There used to be a second mechanism here: a declaration file naming a single
# "owner" of the canonical notes, with a claim/release CLI and a refusal in all
# three writers. It was removed. It described a deployment where some *other*
# product owns the vault and this package must stand down, which is not a
# situation a user of this plugin can be in — it ships with dsh and is the only
# writer. For everyone else the file was either absent (so it did nothing) or
# present by accident (so it silently refused every promotion, with a message
# naming a product they had never installed). The hazard it claimed to solve,
# two writers racing, was already covered by the lock.

# --------------------------------------------------------------------------
# Secret redaction (never let credential-shaped text reach canonical notes,
# the index, logs or the console).
# --------------------------------------------------------------------------

SECRET_PATTERNS = [
    (re.compile(r"(?i)(api[_-]?key\s*[:=]\s*)([^\s`'\"]{4,})"), r"\1<REDACTED>"),
    (re.compile(r"(?i)(access[_-]?token\s*[:=]\s*)([^\s`'\"]{4,})"), r"\1<REDACTED>"),
    (re.compile(r"(?i)(auth[_-]?token\s*[:=]\s*)([^\s`'\"]{4,})"), r"\1<REDACTED>"),
    (re.compile(r"(?i)(?<![A-Za-z_])(token\s*[:=]\s*)([^\s`'\"]{4,})"), r"\1<REDACTED>"),
    (re.compile(r"(?i)(secret\s*[:=]\s*)([^\s`'\"]{4,})"), r"\1<REDACTED>"),
    (re.compile(r"(?i)(password\s*[:=]\s*)([^\s`'\"]{4,})"), r"\1<REDACTED>"),
    (re.compile(r"sk-[A-Za-z0-9_\-]{20,}"), "<REDACTED_API_KEY>"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "<REDACTED_AWS_ACCESS_KEY>"),
    (re.compile(r"(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])"), "<REDACTED_HEX_SECRET>"),
]

# Credential-shaped lines are REJECTED at submission time (never written).
CREDENTIAL_LINE_RE = re.compile(
    r"(?i)(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]"
    r"|(?<![A-Za-z_])token\s*[:=]"
    r"|sk-[A-Za-z0-9_\-]{20,}"
    r"|AKIA[0-9A-Z]{16}"
    r"|(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])"
)


def redact(text: str) -> str:
    out = text or ""
    for pattern, replacement in SECRET_PATTERNS:
        out = pattern.sub(replacement, out)
    return out


def looks_like_credential(line: str) -> bool:
    return bool(CREDENTIAL_LINE_RE.search(line))


# --------------------------------------------------------------------------
# Vault resolution
# --------------------------------------------------------------------------


def parse_config(path: Path) -> dict[str, str]:
    """Parse the tiny `key: value` subset used by ~/.unified-memory.yaml."""
    result: dict[str, str] = {}
    if not path.exists():
        return result
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        result[key.strip()] = value.strip().strip('"').strip("'")
    return result


def resolve_vault() -> Path:
    env = os.environ.get(VAULT_ENV)
    if env:
        return Path(env)
    cfg = parse_config(CONFIG_PATH)
    if "vault" in cfg:
        return Path(cfg["vault"])
    return DEFAULT_VAULT


def ensure_vault(vault: Path) -> None:
    if not (vault / AGENT_CONTEXT).is_dir():
        raise RuntimeError(
            f"vault not initialized at {vault} — run \"memory init --vault <path>\" "
            f"(or set {VAULT_ENV})"
        )


def canonical_dir(vault: Path) -> Path:
    return vault / AGENT_CONTEXT


def canonical_path(vault: Path, doc_id: str) -> Path:
    if doc_id not in CANONICAL_DOCS:
        raise KeyError(
            f"unknown document {doc_id!r} — choose from: {', '.join(CANONICAL_DOCS)}"
        )
    return canonical_dir(vault) / CANONICAL_DOCS[doc_id]


def is_bare_note_name(name: str) -> bool:
    """Return whether ``name`` is one *.md file name, with no path in it.

    This is the traversal gate: a name that carries a directory, a drive letter
    or a parent reference is refused outright rather than resolved and checked
    afterwards, because every caller of this predicate turns the name into a
    path under the canonical directory.
    """
    if not name:
        return False
    if Path(name).name != name or ".." in name:
        return False
    return name.lower().endswith(".md")


def resolve_canonical_note(vault: Path, name: str) -> Path | None:
    """Resolve a bare *.md file name to a real note under 50-Agent-Context.

    Top-level notes are the normal case. ``情境信息/未归类事实.md`` is also
    indexed (see ``index.indexed_files``), so the exact file name a search hit
    reports has to be readable by name — otherwise that one hit is the single
    row the console can show but cannot open.

    Returns None for a refused or missing name. The input is a single segment
    (``is_bare_note_name``), so nothing outside the canonical directory can be
    reached.
    """
    if not is_bare_note_name(name):
        return None
    ctx = canonical_dir(vault)
    direct = ctx / name
    if direct.is_file():
        return direct
    nested = ctx / UNCLASSIFIED_FACT_REL
    if nested.name == name and nested.is_file():
        return nested
    return None


def submission_dir(vault: Path) -> Path:
    return canonical_dir(vault) / SUBMISSION_DIR


def processed_dir(vault: Path) -> Path:
    return submission_dir(vault) / PROCESSED_DIR


def situation_dir(vault: Path) -> Path:
    return canonical_dir(vault) / SITUATION_DIR


def forget_dir(vault: Path) -> Path:
    return canonical_dir(vault) / FORGET_DIR


def session_dir(vault: Path) -> Path:
    return canonical_dir(vault) / SESSION_DIR


# Sync clients (OneDrive, Dropbox, iCloud) create a second file instead of
# merging when two machines edit the same note. Those copies are not canonical
# notes: indexing them makes every fact appear twice with different "truth",
# and the promoter may then classify conflicts against the copy. Detect the
# common naming schemes and keep them out of the derived index. The user still
# sees the files in Obsidian and can decide which copy wins.
CONFLICT_COPY_RE = re.compile(
    r"(?:[ _]\d+\.md$"                       # "note 2.md" / "note_2.md"
    r"|[（(]\d+[)）]\.md$"                    # "note(2).md"
    r"|[-_ ](?:副本|冲突副本|copy)\.md$"       # "note-副本.md"
    r"|(?:conflicted copy|冲突副本)[^/]*\.md$)",  # "note (conflicted copy).md"
    re.I,
)


def is_conflict_copy(name: str) -> bool:
    """True for a sync-client conflict copy, never for a normal dated note."""
    return bool(CONFLICT_COPY_RE.search(Path(name).name))


# --------------------------------------------------------------------------
# Atomic writes & file locking (multi-agent safe)
# --------------------------------------------------------------------------


def atomic_write(path: Path, text: str) -> None:
    """Write via temp file + rename so concurrent readers never see partial content."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def atomic_create(path: Path, text: str) -> bool:
    """Create ``path`` with complete content, without replacing an existing file.

    A same-directory hard link makes both publication and exclusive creation a
    single filesystem operation.  This lets concurrent submitters retry a new
    file name without exposing a partly-written inbox entry to the promoter.
    On filesystems without hard-link support (FAT32, some network mounts) we
    fall back to O_CREAT|O_EXCL so exclusive creation is still preserved.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with tmp.open("w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(tmp, path)
        except FileExistsError:
            return False
        except OSError:
            # Hard links unsupported here: publish via an exclusive create.
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                return False
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
                handle.write(text)
                handle.flush()
        return True
    finally:
        tmp.unlink(missing_ok=True)


def read_maybe(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _remove_lock(lock_path: Path, retries: int = 20, delay: float = 0.05) -> None:
    """Delete the advisory lock file, retrying around Windows' open-file rule.

    On POSIX deleting an open file is fine; on Windows it raises PermissionError
    until every handle is closed. A concurrent acquirer holds the file open for
    only a few microseconds (exclusive-create → write → close), so a short retry
    loop makes the finally-cleanup reliable without blocking callers.
    """
    for _ in range(retries):
        try:
            lock_path.unlink(missing_ok=True)
            return
        except PermissionError:
            time.sleep(delay)
    # Give up quietly; a lock that could not be removed is broken by the stale
    # recovery on the next acquisition instead of crashing the current writer.
    try:
        lock_path.unlink(missing_ok=True)
    except PermissionError:
        pass


@contextmanager
def file_lock(vault: Path, timeout_s: float = 30.0, poll_s: float = 0.5):
    """Exclusive lock file at <vault>/.lock; times out with a clear error.

    The lock is advisory: every writer in this package takes it before
    touching canonical files. A lock from a dead process is recovered; a live
    process keeps ownership even when a long operation outlasts the old
    stale-file threshold.
    """
    lock_path = vault / LOCK_FILE
    thread_lock = _thread_lock_for(vault)
    deadline = time.monotonic() + timeout_s
    if not thread_lock.acquire(timeout=max(0.0, timeout_s)):
        raise TimeoutError(
            f"could not acquire in-process lock for {vault} within {timeout_s}s"
        )
    waiting_reported = False
    owner_token = uuid.uuid4().hex
    try:
        while True:
            try:
                fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(f"pid={os.getpid()} token={owner_token}\n")
                    handle.flush()
                break
            except PermissionError:
                # Windows: another process may be mid create/delete of the lock file;
                # treat it as transient contention and retry.
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"could not acquire {lock_path} within {timeout_s}s — another "
                        "promoter/writer holds the lock"
                    )
                time.sleep(poll_s)
                continue
            except FileExistsError:
                try:
                    fields = dict(
                        item.split("=", 1)
                        for item in lock_path.read_text(encoding="utf-8").split()
                        if "=" in item
                    )
                    pid = int(fields.get("pid", "0"))
                    try:
                        os.kill(pid, 0)
                        owner_is_alive = True
                    except ProcessLookupError:
                        owner_is_alive = False
                    except PermissionError:
                        owner_is_alive = True
                    except OSError:
                        owner_is_alive = True
                    if not owner_is_alive:
                        lock_path.unlink(missing_ok=True)
                        continue
                except (FileNotFoundError, ValueError, UnicodeDecodeError):
                    # A partially-created or corrupt lock is never removed while
                    # fresh; after ten minutes no owner can safely rely on it.
                    try:
                        if time.time() - lock_path.stat().st_mtime > 600:
                            lock_path.unlink(missing_ok=True)
                            continue
                    except FileNotFoundError:
                        continue
                except FileNotFoundError:
                    continue
                if not waiting_reported:
                    print(
                        f"waiting for lock {lock_path} (held by another writer, "
                        f"up to {timeout_s:g}s)...",
                        file=sys.stderr,
                    )
                    waiting_reported = True
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"could not acquire {lock_path} within {timeout_s}s — another "
                        "promoter/writer holds the lock"
                    )
                time.sleep(poll_s)
        try:
            yield
        finally:
            try:
                fields = dict(
                    item.split("=", 1)
                    for item in lock_path.read_text(encoding="utf-8").split()
                    if "=" in item
                )
                if fields.get("token") == owner_token:
                    _remove_lock(lock_path)
            except (FileNotFoundError, UnicodeDecodeError, PermissionError):
                pass
    finally:
        thread_lock.release()


# --------------------------------------------------------------------------
# Fact-line helpers
# --------------------------------------------------------------------------

# Promotion stamps come in two dialects:
#
#   repo / dsh   （写入 2026-08-16｜来源：Agent提交区/dsh-20260816-001-01.md）
#   Hermes       （写入 2026-09-22｜来源：[[Agent提交区/dsh-20260922-000818-01.md]]）
#                （写入 2026-09-23｜来源：[[Hermes会话自动归档/2026-09-23]]，事件 `3d2f428c…`）
#
# Both may carry optional `｜使用 N 次·最近 YYYY-MM-DD` and `｜有效至 YYYY-MM-DD`
# segments. Hermes is the writer that actually owns the live vault, so parsing
# only the repo dialect silently dropped dates/sources for every real fact
# (0/460 on the reference vault) — which in turn disabled decay-by-age and left
# superseded versions searchable. One parser covers both.
STAMP_RE = re.compile(
    r"\s*（"
    r"(?:(?:写入\s*)?(?P<date>\d{4}-\d{2}-\d{2})\s*｜\s*)?"
    r"来源[:：]\s*(?P<source>[^）]+?)"
    r"(?:[，,]\s*事件\s*`[^`]*`)?"
    r"(?:｜使用\s*\d+\s*次(?:·最近\s*\d{4}-\d{2}-\d{2})?)?"
    r"(?:｜有效至\s*(?P<valid_until>\d{4}-\d{2}-\d{2}))?"
    r"）"
)
# Legacy English stamp kept for backwards compatibility with older vaults.
EN_STAMP_RE = re.compile(
    r"\s*\(written (?P<date>\d{4}-\d{2}-\d{2})｜source:\s*(?P<source>[^)]*)\)"
)
# Backwards-compatible alias: older callers imported WRITTEN_SUFFIX_RE.
WRITTEN_SUFFIX_RE = STAMP_RE
USAGE_TAG_RE = re.compile(r"｜使用 \d+ 次(·最近 \d{4}-\d{2}-\d{2})?")
VERSIONED_RE = re.compile(r"｜有效至 \d{4}-\d{2}-\d{2}")


def parse_stamp(line: str) -> tuple[str | None, str, str | None]:
    """Return (written_date, source, valid_until) from a canonical fact line.

    ``source`` keeps the vault-relative form (``Agent提交区/x.md`` or
    ``Hermes会话自动归档/2026-09-23``) with any ``[[...]]`` link wrapper
    removed. Missing pieces are ``None`` / ``""``.
    """
    match = STAMP_RE.search(line or "") or EN_STAMP_RE.search(line or "")
    if not match:
        return None, "", None
    source = (match.group("source") or "").strip()
    if source.startswith("[[") and source.endswith("]]"):
        source = source[2:-2].strip()
    else:
        source = source.strip("[]").strip()
    return match.group("date"), source, match.groupdict().get("valid_until")


def source_agent(source: str) -> str:
    """Best-effort agent name from a stamp source.

    Submission files start with the agent prefix (``dsh-2026...md``); archive
    sources carry the archive name instead, so map the known archives to their
    owning runtime rather than returning a date fragment.
    """
    text = (source or "").strip().strip("[]").replace("\\", "/")
    if not text:
        return ""
    compact = text.replace(" ", "")
    if "Hermes会话自动归档" in compact:
        return "hermes"
    if "会话归档" in compact:
        return "archive"
    name = text.rsplit("/", 1)[-1]
    agent = name.split("-", 1)[0].strip()
    return agent if agent and not agent[0].isdigit() else ""


def strip_suffix(line: str) -> str:
    """Remove promotion/usage/version suffixes, returning the bare fact text."""
    out = EN_STAMP_RE.sub("", STAMP_RE.sub("", line or ""))
    out = USAGE_TAG_RE.sub("", out)
    out = out.strip()
    return out


def fact_lines(text: str) -> list[str]:
    """Parse a submission file into fact lines (skips headers/comments/blank)."""
    lines = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(("- ", "• ", "* ")):
            line = line[2:].strip()
        if line:
            lines.append(line)
    return lines


def bare_fact_line(line: str) -> str:
    """Canonical-line -> comparable fact text: strip bullet prefix AND all
    promotion/usage/version suffixes. Used for dedup and conflict checks."""
    t = line.strip()
    if t.startswith(("- ", "• ", "* ")):
        t = t[2:]
    return strip_suffix(t).strip()


def is_versioned(line: str) -> bool:
    return bool(VERSIONED_RE.search(line))

def write_stamp(src_name: str, when: str | None = None) -> str:
    day = when or time.strftime("%Y-%m-%d")
    return f"（写入 {day}｜来源：Agent提交区/{src_name}）"
