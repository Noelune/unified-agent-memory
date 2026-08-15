# -*- coding: utf-8 -*-
"""Shared plumbing: configuration, paths, redaction, atomic writes, file locks.

Dependency-free on purpose — everything here is Python standard library.
"""
from __future__ import annotations

import os
import re
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

# --------------------------------------------------------------------------
# Paths & configuration
# --------------------------------------------------------------------------

VAULT_ENV = "UNIFIED_MEMORY_VAULT"
CONFIG_PATH = Path.home() / ".unified-memory.yaml"
DEFAULT_VAULT = Path.home() / "AgentMemory"

AGENT_CONTEXT = "50-Agent-Context"

# Canonical documents: stable ids (used by `memory show <id>`) -> file names.
CANONICAL_DOCS = {
    "index": "上下文索引.md",
    "prefs": "我的偏好摘要.md",
    "env": "常用路径与环境.md",
    "rules": "工程执行规则.md",
    "tools": "工具可用性.md",
    "ui": "UI 审美.md",
    "coord": "协作规则.md",
}

SUBMISSION_DIR = "Agent提交区"
PROCESSED_DIR = "已处理"
SITUATION_DIR = "情境信息"
PENDING_FILE = "待晋升.md"
CONFLICT_FILE = "事实冲突待裁决.md"
ADJUDICATED_FILE = "事实冲突已裁决.md"
FORGET_DIR = "记忆遗忘区"
SESSION_DIR = "会话归档"
LOCK_FILE = ".lock"

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
    deadline = time.monotonic() + timeout_s
    waiting_reported = False
    owner_token = uuid.uuid4().hex
    while True:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(f"pid={os.getpid()} token={owner_token}\n")
                handle.flush()
            break
        except PermissionError:
            # Windows: another thread may be mid create/delete of the lock file;
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


# --------------------------------------------------------------------------
# Fact-line helpers
# --------------------------------------------------------------------------

WRITTEN_SUFFIX_RE = re.compile(
    r"\s*（写入 \d{4}-\d{2}-\d{2}｜来源：[^）]*）"
    r"|\s*\(written \d{4}-\d{2}-\d{2}｜source:[^)]*\)"
)
USAGE_TAG_RE = re.compile(r"｜使用 \d+ 次(·最近 \d{4}-\d{2}-\d{2})?")
VERSIONED_RE = re.compile(r"｜有效至 \d{4}-\d{2}-\d{2}）")


def strip_suffix(line: str) -> str:
    """Remove promotion/usage/version suffixes, returning the bare fact text."""
    out = line
    out = WRITTEN_SUFFIX_RE.sub("", out)
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
