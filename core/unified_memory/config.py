# -*- coding: utf-8 -*-
"""config — the only writer of ``~/.unified-memory.yaml``.

Three places used to read-modify-write this file independently and without a
lock:

  * ``memory._persist_vault``      → the ``vault:`` key
  * ``digest._set_enabled``        → the ``digest.enabled`` key
  * a second copy of the same edit inside ``digest._set_enabled``

Two of them racing — a plugin submit while cron runs ``memory digest --off`` —
meant the later writer silently dropped the earlier writer's key, because both
did "read whole file → change one line → write whole file".

This module owns the file. Every mutation goes through one cross-process lock,
keeps unknown keys and comments untouched, backs the file up before the first
write of a run, and skips the write entirely when nothing would change (so a
repeated ``memory use`` does not churn a OneDrive-synced file).
"""
from __future__ import annotations

import os
import time
from contextlib import contextmanager
from pathlib import Path

from . import common
from .common import atomic_write, parse_config

LOCK_TIMEOUT_S = 10.0
LOCK_POLL_S = 0.05


def default_path() -> Path:
    """Resolve ``common.CONFIG_PATH`` at call time, never at import time.

    A module-level ``from .common import CONFIG_PATH`` would freeze whatever the
    value was when this module was first imported, so a caller (or a test) that
    rebinds ``common.CONFIG_PATH`` afterwards would keep writing the old file.
    """
    return Path(common.CONFIG_PATH)


def _lock_path(path: Path) -> Path:
    return path.with_name(path.name + ".lock")


@contextmanager
def _locked(path: Path):
    """Cross-process lock on the config file.

    A lock left behind by a killed process is treated as stale after
    ``LOCK_TIMEOUT_S`` and removed, so a crash can never block every later
    configuration change.
    """
    lock = _lock_path(path)
    lock.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + LOCK_TIMEOUT_S
    fd: int | None = None
    while fd is None:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            pass
        except PermissionError:
            # Windows reports a lost O_EXCL creation race as ERROR_ACCESS_DENIED
            # (PermissionError), not ERROR_FILE_EXISTS — so two writers racing
            # to create the lock crashed instead of queueing, which is exactly
            # the case this lock exists for. A directory that is genuinely
            # unwritable raises the same exception, so keep retrying until the
            # deadline and only then let it through.
            if time.monotonic() > deadline and not lock.exists():
                raise
        # Staleness and deadline are checked for both failure modes: a lock
        # file that is present (or one we just failed to create) either belongs
        # to a live writer or to a dead one.
        try:
            age = time.time() - lock.stat().st_mtime
        except OSError:
            age = 0.0
        if age > LOCK_TIMEOUT_S:
            try:
                lock.unlink()
            except OSError:
                pass
            continue
        if time.monotonic() > deadline:
            raise TimeoutError(f"config lock is held by another process: {lock}")
        time.sleep(LOCK_POLL_S)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(f"pid={os.getpid()}\n")
        yield
    finally:
        try:
            lock.unlink()
        except FileNotFoundError:
            pass


def _read_lines(path: Path) -> list[str]:
    try:
        return path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []


def _write_lines(path: Path, lines: list[str]) -> None:
    text = "\n".join(lines)
    if text and not text.endswith("\n"):
        text += "\n"
    atomic_write(path, text)


def _backup(path: Path) -> Path | None:
    """One timestamped copy per second, so a burst of edits does not spam."""
    if not path.exists():
        return None
    target = path.with_name(f"{path.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
    if target.exists():
        return target
    target.write_bytes(path.read_bytes())
    return target


def _without_key(lines: list[str], key: str) -> list[str]:
    prefix = f"{key}:"
    return [ln for ln in lines if not ln.strip().startswith(prefix)]


def get(key: str, default: str = "", path: Path | None = None) -> str:
    """Read one key (read-only; no lock needed for a single line)."""
    return parse_config(path or default_path()).get(key, default)


def set_key(key: str, value: str, path: Path | None = None) -> Path:
    """Set ``key`` to ``value``, preserving every other line.

    The write is skipped when the value is already what was asked for, so the
    common idempotent case produces no file change and no sync event.
    """
    path = path or default_path()
    key = key.strip()
    if not key:
        raise ValueError("config key must not be empty")
    with _locked(path):
        current = parse_config(path).get(key)
        if current is not None and current == str(value).strip().strip('"').strip("'"):
            return path
        lines = _without_key(_read_lines(path), key)
        lines.append(f"{key}: {value}")
        _backup(path)
        _write_lines(path, lines)
    return path


def unset_key(key: str, path: Path | None = None) -> bool:
    """Remove ``key``; returns True when the file actually changed."""
    path = path or default_path()
    key = key.strip()
    with _locked(path):
        lines = _read_lines(path)
        kept = _without_key(lines, key)
        if kept == lines:
            return False
        _backup(path)
        _write_lines(path, kept)
    return True


def set_keys(updates: dict[str, str], path: Path | None = None) -> Path:
    """Set several keys in one locked write — one backup, one sync event."""
    path = path or default_path()
    if not updates:
        return path
    with _locked(path):
        current = parse_config(path)
        pending = {
            k: v for k, v in updates.items()
            if current.get(k) != str(v).strip().strip('"').strip("'")
        }
        if not pending:
            return path
        lines = _read_lines(path)
        for key, value in pending.items():
            lines = _without_key(lines, key.strip())
            lines.append(f"{key.strip()}: {value}")
        _backup(path)
        _write_lines(path, lines)
    return path


def set_value(key: str, value: str, path: Path | None = None) -> Path:
    """Alias kept for callers that read better as ``set_value``."""
    return set_key(key, value, path)
