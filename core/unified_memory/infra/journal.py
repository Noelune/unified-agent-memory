# -*- coding: utf-8 -*-
"""journal — the write-ahead log for canonical rewrites (batch B).

Every ``infra.vault.apply`` writes one ``intent`` record BEFORE touching any
file and one ``commit`` record AFTER all files are written. If a process dies
in between, the next writer's ``recover()`` finds the uncommitted intent and
rolls every change BACK to ``before_text`` — rollback, not replay, because an
intent without a commit means nobody promised the new content.

The journal lives OUTSIDE the vault (``~/.unified-memory/journal/<vault-tag>.jsonl``):
the vault syncs through OneDrive and a synced journal would race its own
recovery. The per-vault tag is the same sha256[:16] scheme the index database
uses (infra.store.schema).

Records are one JSON object per line, appended (``open(..., "a")`` + fsync) —
that is why this module is on the architecture test's WRITES_OK list (the B0
comment reserved the seat). Lines:

  {"seq": n, "kind": "intent", "at": ..., "actor": ..., "reason": ...,
   "changes": [{"op", "doc", "before_text", "after_text"}, ...]}
  {"seq": n, "kind": "commit", "at": ..., "intent_seq": n}
  {"seq": n, "kind": "rollback", "at": ..., "intent_seq": n, "restored": n}

Because every writer takes the vault lock before applying, and ``recover``
runs inside that lock, the last line decides: if it is an ``intent``, the
change set it describes was never committed.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path

# Tests rebind this to a temp dir (the same pattern memory.INDEX_DB uses);
# production default is under the user profile, next to the index databases.
JOURNAL_BASE = Path.home() / ".unified-memory" / "journal"


def journal_path(vault: Path) -> Path:
    """The per-vault journal file (same vault tag as the index database)."""
    tag = hashlib.sha256(str(Path(vault).resolve()).encode("utf-8")).hexdigest()[:16]
    return JOURNAL_BASE / f"{tag}.jsonl"


def _append(record: dict) -> None:
    path = record["_path"]
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({k: v for k, v in record.items() if k != "_path"}, ensure_ascii=False)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def _read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    records: list[dict] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # a torn tail line is the crash we are here to reason about
    return records


def _next_seq(records: list[dict]) -> int:
    return (records[-1]["seq"] + 1) if records else 1


def write_intent(vault: Path, changeset) -> int:
    """Record the planned changes BEFORE any file is touched. Returns its seq."""
    path = journal_path(vault)
    records = _read(path)
    record = {
        "seq": _next_seq(records),
        "kind": "intent",
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "actor": changeset.actor,
        "reason": changeset.reason,
        "changes": [
            {
                "op": change.op,
                "doc": str(change.doc),
                "before_text": change.before_text,
                "after_text": change.after_text,
            }
            for change in changeset.changes
        ],
        "_path": path,
    }
    _append(record)
    return record["seq"]


def write_commit(vault: Path, intent_seq: int) -> None:
    path = journal_path(vault)
    records = _read(path)
    _append({
        "seq": _next_seq(records),
        "kind": "commit",
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "intent_seq": intent_seq,
        "_path": path,
    })


def pending_intent(vault: Path) -> dict | None:
    """The last intent record without a commit/rollback after it, if any."""
    path = journal_path(vault)
    records = _read(path)
    if not records or records[-1].get("kind") != "intent":
        return None
    return records[-1]


def recover(vault: Path) -> dict:
    """Roll back an uncommitted intent. Call under the vault lock.

    For every change in the pending intent, the file is restored to
    ``before_text`` unless it already matches. ``current == after_text`` is the
    crash-mid-apply case — the intent was never committed, so the planned
    "after" has no authority and is undone like every other divergence. A
    change whose file is missing and whose ``before_text`` is empty (a planned
    creation) is rolled back by removing the file.
    """
    intent = pending_intent(vault)
    if intent is None:
        return {"recovered": False, "restored": 0}
    restored = 0
    for change in intent.get("changes", []):
        doc = Path(change["doc"])
        current = doc.read_text(encoding="utf-8") if doc.exists() else ""
        if current == change["before_text"]:
            continue
        before = change["before_text"]
        if before:
            doc.parent.mkdir(parents=True, exist_ok=True)
            doc.write_text(before, encoding="utf-8")
        else:
            doc.unlink(missing_ok=True)
        restored += 1
    path = journal_path(vault)
    records = _read(path)
    _append({
        "seq": _next_seq(records),
        "kind": "rollback",
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "intent_seq": intent["seq"],
        "restored": restored,
        "_path": path,
    })
    return {"recovered": True, "restored": restored}
