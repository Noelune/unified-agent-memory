# -*- coding: utf-8 -*-
"""preview — read-only governance views over the shared memory.

Four views, all strictly read-only (no writes, no index mutation beyond the
self-healing update_index call every command performs):

  pending     inbox files awaiting promotion (Agent提交区)
  conflicts   memories flagged as conflicting (unsupported until the detector
              writes type='conflict' — see CONFLICTS_UNSUPPORTED_REASON)
  forgetting  low-salience active memories, decay-ordered
  recent      canonical notes by modification time

Vault content is returned under ``line``/``doc``/``name`` fields and is always
redacted. Callers must treat these as DATA. The CLI wraps them in
<memory-data> on the text path; the JSON path marks records ``untrusted``.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from . import index as index_mod
from .common import AGENT_CONTEXT, SUBMISSION_DIR, canonical_dir, redact

VIEWS = ("pending", "conflicts", "forgetting", "recent")

# Inbox path relative to the vault root. Derived from common.py's own folder
# names (never a second hand-typed literal) so the inbox can only ever be
# named once. common.submission_dir(vault) returns the same directory as an
# absolute helper; this constant is kept for callers that hold a vault string
# rather than a Path, and for the CLI's read_inbox_item() join.
INBOX_REL = os.path.join(AGENT_CONTEXT, SUBMISSION_DIR)

# Why the conflicts view cannot answer yet: no code path writes this type.
# classify_type() covers MEMORY_TYPES only, and the column default is 'fact'.
CONFLICTS_UNSUPPORTED_REASON = (
    "no memory is ever typed 'conflict': classify_type() only emits index.py "
    "MEMORY_TYPES and the column default is 'fact'. An empty list here means "
    "'no rows carry that type', NOT 'there are no conflicts'. Only a "
    "hand-written row with type='conflict' can surface. Wire the conflict "
    "detector (core/unified_memory/conflict.py) to make this view meaningful."
)


def build(vault: Path, view: str, limit: int = 20) -> dict:
    """Return one view as {"view", "status", "count", "items"}. Read-only.

    ``status`` is ``"ok"`` when the view can actually answer the question, or
    ``"unsupported"`` when it structurally cannot — the latter carries a
    ``reason`` so an empty list is never mistaken for a successful negative.
    """
    if vault is None:
        raise SystemExit("preview needs a vault")
    if view not in VIEWS:
        raise SystemExit(f"unknown view {view!r} — choose from {', '.join(VIEWS)}")
    index_mod.update_index(vault)  # self-healing derived db, same as every command
    builders = {
        "pending": _pending,
        "conflicts": _conflicts,
        "forgetting": _forgetting,
        "recent": _recent,
    }
    items = builders[view](vault, limit)
    data = {"view": view, "status": "ok", "count": len(items), "items": items}
    if view == "conflicts" and not items:
        # The type is unreachable from every writer, so an empty result is the
        # absence of an answer, never a negative answer.
        data["status"] = "unsupported"
        data["reason"] = CONFLICTS_UNSUPPORTED_REASON
    return data


def envelope(view: str, data: dict) -> str:
    """Wrap a view in the same JSON envelope the rest of the CLI uses."""
    return json.dumps({"ok": True, "command": "preview", "data": data}, ensure_ascii=False)


def _pending(vault: Path, limit: int) -> list[dict]:
    inbox = Path(vault) / INBOX_REL
    if not inbox.is_dir():
        return []
    files = sorted(inbox.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    return [
        {"name": p.name, "path": str(p), "mtime": p.stat().st_mtime, "untrusted": True}
        for p in files
    ]


def _conflicts(vault: Path, limit: int) -> list[dict]:
    conn = index_mod.get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT id, doc, line, type, importance FROM memories "
            "WHERE status = 'active' AND type = 'conflict' LIMIT ?",
            (limit,),
        ).fetchall()
    except Exception:  # noqa: BLE001 — a missing column/table must not crash the view
        return []
    finally:
        conn.close()
    return [
        {"id": r["id"], "doc": redact(Path(r["doc"]).name), "line": redact(r["line"]),
         "type": r["type"], "importance": r["importance"], "untrusted": True}
        for r in rows
    ]


def _forgetting(vault: Path, limit: int) -> list[dict]:
    conn = index_mod.get_conn(vault)
    try:
        rows = conn.execute(
            "SELECT id, doc, line, type, importance, access_count FROM memories "
            "WHERE status = 'active' ORDER BY access_count ASC, importance ASC LIMIT ?",
            (limit,),
        ).fetchall()
    except Exception:  # noqa: BLE001
        return []
    finally:
        conn.close()
    return [
        {"id": r["id"], "doc": redact(Path(r["doc"]).name), "line": redact(r["line"]),
         "type": r["type"], "importance": r["importance"],
         "accessCount": r["access_count"], "untrusted": True}
        for r in rows
    ]


def _recent(vault: Path, limit: int) -> list[dict]:
    ctx = canonical_dir(vault)
    if not ctx.is_dir():
        return []
    files = [p for p in ctx.glob("*.md") if p.is_file()]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [
        {"name": p.name, "path": str(p), "mtime": p.stat().st_mtime, "untrusted": True}
        for p in files[:limit]
    ]


def _safe_inbox_name(name: str) -> bool:
    """A submission filename only — never a path.

    The inbox is user-owned data reached from a browser button, so the name
    arrives from outside the trust boundary. Reject anything that could name
    a different file once joined: separators, traversal, drive letters,
    absolute markers and NUL.
    """
    if not name or name in (".", ".."):
        return False
    if "\x00" in name:
        return False
    if "/" in name or "\\" in name:
        return False
    if ":" in name:  # drive letter or stream syntax
        return False
    return not name.startswith("~")


def read_inbox_item(vault: str, name: str) -> dict:
    """Read one submission's body. Returns body=None when unreadable.

    Body=None (not "") is deliberate: "no such item" and "empty item" are
    different facts, and the UI shows different copy for each. Failure records
    also carry a ``reason`` ("invalid-name" | "not-found") so a caller can tell
    a refused name from a missing file — the two are different problems and
    only one of them is a user error.

    The record carries ``untrusted: true`` because the body is a whole
    free-text file the user controls, reached from the browser. Per
    docs/JSON-CONTRACT.md §2 that marker is required on every vault-derived
    record and is not removable.
    """
    def _fail(reason: str) -> dict:
        return {"name": name, "body": None, "reason": reason, "untrusted": True}

    if not _safe_inbox_name(name):
        return _fail("invalid-name")
    inbox = os.path.join(vault, INBOX_REL)
    target = os.path.join(inbox, name)
    # Belt and braces: even with the name checked, confirm the *resolved file*
    # is still inside the resolved inbox. Checking realpath(target) rather than
    # its dirname is what closes the hole: a symlink planted inside the inbox
    # pointing outside it resolves to a path with the wrong prefix.
    # ponytail: a symlinked inbox root itself is accepted (both sides resolve
    # through it). Upgrade path if that ever matters: also require
    # realpath(inbox) == abspath(inbox).
    inbox_real = os.path.realpath(inbox)
    target_real = os.path.realpath(target)
    if os.path.dirname(target_real) != inbox_real:
        return _fail("invalid-name")
    try:
        with open(target_real, encoding="utf-8", errors="replace") as fh:
            return {"name": name, "body": fh.read(), "untrusted": True}
    except OSError:
        return _fail("not-found")
