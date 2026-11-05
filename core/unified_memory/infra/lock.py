# -*- coding: utf-8 -*-
"""Per-vault advisory file lock (moved verbatim from common.py, B1).

Four call paths rewrite canonical notes (promote / demote / repair / backfill),
all through the one executor ``infra.vault.apply``; every one of them takes the
same per-vault ``file_lock`` — see ``core/tests/test_write_lock.py``, which
runs them concurrently against one vault and fails if any of them forgets.
"""
from __future__ import annotations

import threading
import time
import uuid
import os
import sys
from contextlib import contextmanager
from pathlib import Path

LOCK_FILE = ".lock"

_THREAD_LOCKS: dict[str, threading.Lock] = {}
_THREAD_LOCKS_GUARD = threading.Lock()


def _thread_lock_for(vault: Path) -> threading.Lock:
    key = str(vault.expanduser().resolve())
    with _THREAD_LOCKS_GUARD:
        return _THREAD_LOCKS.setdefault(key, threading.Lock())


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


def _read_lock_fields(lock_path: Path) -> dict:
    """Parse ``pid=… token=…`` from the lock file; may raise on read/decode."""
    return dict(
        item.split("=", 1)
        for item in lock_path.read_text(encoding="utf-8").split()
        if "=" in item
    )


def _owner_alive(pid: int) -> bool:
    """True if a process with ``pid`` exists (signal-0 probe)."""
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True


def _recover_stale_or_corrupt(lock_path: Path) -> bool:
    """True → retry acquisition now; False → keep waiting.

    A partially-created or corrupt lock is never removed while fresh; after
    ten minutes no owner can safely rely on it.
    """
    try:
        if time.time() - lock_path.stat().st_mtime > 600:
            lock_path.unlink(missing_ok=True)
            return True
    except FileNotFoundError:
        # The lock vanished mid-check — retry the open immediately.
        return True
    return False


def _wait_notice(lock_path: Path, timeout_s: float, waiting_reported: bool) -> bool:
    """Print the one-time wait notice; returns the (possibly flipped) flag."""
    if waiting_reported:
        return waiting_reported
    print(
        f"waiting for lock {lock_path} (held by another writer, "
        f"up to {timeout_s:g}s)...",
        file=sys.stderr,
    )
    return True


def _raise_if_past_deadline(lock_path: Path, deadline: float, timeout_s: float) -> None:
    if time.monotonic() >= deadline:
        raise TimeoutError(
            f"could not acquire {lock_path} within {timeout_s}s — another "
            "promoter/writer holds the lock"
        )


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
                _raise_if_past_deadline(lock_path, deadline, timeout_s)
                time.sleep(poll_s)
                continue
            except FileExistsError:
                try:
                    pid = int(_read_lock_fields(lock_path).  get("pid", "0"))
                    if not _owner_alive(pid):
                        lock_path.unlink(missing_ok=True)
                        continue
                except (FileNotFoundError, ValueError, UnicodeDecodeError):
                    if _recover_stale_or_corrupt(lock_path):
                        continue
                except FileNotFoundError:
                    continue
                waiting_reported = _wait_notice(lock_path, timeout_s, waiting_reported)
                _raise_if_past_deadline(lock_path, deadline, timeout_s)
                time.sleep(poll_s)
        try:
            yield
        finally:
            try:
                if _read_lock_fields(lock_path).get("token") == owner_token:
                    _remove_lock(lock_path)
            except (FileNotFoundError, UnicodeDecodeError, PermissionError):
                pass
    finally:
        thread_lock.release()
