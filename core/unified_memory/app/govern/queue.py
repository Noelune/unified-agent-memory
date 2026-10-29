# -*- coding: utf-8 -*-
"""queue — the vault half of conflict handling (B5.4 split).

The pending queue (``情境信息/事实冲突待裁决.md``) is written by TWO runtimes in
two different shapes, and this module reads both:

  core     ``- [ ] 冲突 {"新":"…","旧":"…","来源":"…","目标":"…"}``
           One line per conflict; written by `append_conflict`, trivially
           machine-readable.

  Hermes   ``## 2026-10-19 03:01 冲突 #20261019030125-1``
           ``- 状态：[待裁决]``
           ``- 新提交：…``
           ``- 来源：…``
           ``- 既有：…``
           ``- 所在：…``
           A human-readable block. This is the shape a *person* writes and the
           shape the user's own vault actually contained.

`read_conflicts` used to accept only the first. On a real vault holding one
pending conflict in the block shape it returned `[]`, so `adjudicate` printed
"no pending conflicts" and the panel reported an empty queue while the conflict
sat in plain sight. An empty parse is not an empty queue: it is a reader that
matched nothing, and it must never be reported as "there is nothing to decide".

What a conflict *is* (similarity, subjects, rendering) lives in
``domain/conflict.py``; this module only moves that decision in and out of the
vault, which is why it is the only place that knows the file names.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from ...domain.conflict import (
    ADVICE_CHOICE,
    ADVICE_WHY,
    _ADVICE_LINE,
    _BLOCK_FIELD,
    _BLOCK_ID,
    _BLOCK_KEYS,
    _SETTLED_MARKERS,
    _parse_inline_conflict,
    _signature,
    entry_key,
)
from ...domain.markdown import collapse_whitespace
from ...domain.policy import ADJUDICATED_FILE, CONFLICT_FILE
from ...infra.lock import file_lock
from ...infra.vault import atomic_write, read_maybe, situation_dir


def append_conflict(
    vault: Path,
    new_fact: str,
    existing_line: str,
    source: str,
    target_file: str = "",
    cross_doc: str = "",
) -> None:
    """Queue one conflict; never touches canonical notes.

    Always writes the single-line JSON shape: it is unambiguous for a machine
    to read back, and both shapes are read, so there is nothing to gain from
    emitting the human one. Duplicate suppression compares `_signature`, not
    dict equality — dict equality would stop matching the moment a reader adds
    bookkeeping keys, and the queue would grow a copy per pass.

    ``cross_doc`` names the note that already holds the contradicting value
    when the hit came from a document other than the fact's classification
    target (batch A): the old line was invisible to the target-note-only
    comparison, so without the field the queue showed a conflict whose "旧"
    side could not be located by a reader.
    """
    path = situation_dir(vault) / CONFLICT_FILE
    fields = {"新": new_fact, "旧": existing_line, "来源": source}
    if target_file:
        fields["目标"] = target_file
    if cross_doc:
        fields["跨文档"] = cross_doc
    with file_lock(vault):
        if not path.exists():
            atomic_write(
                path,
                "# 事实冲突待裁决\n\n"
                "> 新提交事实与 canonical 既有行高度相似但值不同。裁决命令：\n"
                "> \"python -m unified_memory.promoter adjudicate\"（交互式）。\n\n",
            )
        wanted = _signature(fields)
        if any(_signature(existing) == wanted for existing in read_conflicts(vault)):
            return
        entry = "- [ ] 冲突 " + json.dumps(fields, ensure_ascii=False, separators=(",", ":")) + "\n"
        current = read_maybe(path)
        if not current.endswith("\n"):
            current += "\n"
        atomic_write(path, current + entry)


def record_advice(
    vault: Path, entry: dict, choice: str, why: str, *, locked: bool = False
) -> bool:
    """Attach an agent's recommendation to a still-pending conflict.

    Exists for the case the whole feature is built around: an agent reads both
    sides, cannot honestly tell which one is true, and stops. Leaving the person
    with the same two undifferentiated lines is what made the queue unreadable,
    so the recommendation and its reason travel WITH the entry — the panel can
    then show "Agent 建议共存，因为…" above the buttons instead of asking a
    question the reader has no way to answer.

    Rewrites the entry in place; returns False when the entry is gone (someone
    else ruled while the advice was being composed, which is not an error).
    """
    if not locked:
        with file_lock(vault):
            return record_advice(vault, entry, choice, why, locked=True)
    path = situation_dir(vault) / CONFLICT_FILE
    lines = read_maybe(path).splitlines()
    note = collapse_whitespace(why)
    wanted = _signature(entry)

    if entry.get("format") == "block":
        heading = str(entry.get("heading", "")).strip()
        if not heading:
            return False
        start = next((n for n, line in enumerate(lines) if line.strip() == heading), None)
        if start is None:
            return False
        end = len(lines)
        for n in range(start + 1, len(lines)):
            if lines[n].strip().startswith("## "):
                end = n
                break
        body = [line for line in lines[start + 1: end] if not _ADVICE_LINE.match(line.strip())]
        while body and not body[-1].strip():
            body.pop()
        body.extend([f"- 建议：{choice}", f"- 解释：{note}"])
        atomic_write(path, "\n".join(lines[: start + 1] + body + lines[end:]) + "\n")
        return True

    for n, line in enumerate(lines):
        stripped = line.strip()
        if not stripped.startswith("- [ ] 冲突"):
            continue
        parsed = _parse_inline_conflict(stripped)
        if not parsed or _signature(parsed) != wanted:
            continue
        fields = {k: v for k, v in parsed.items() if k != "format"}
        fields[ADVICE_CHOICE] = choice
        fields[ADVICE_WHY] = note
        # Rewritten as the JSON shape whichever shape it arrived in: the reader
        # accepts both, and string surgery on the legacy `｜k：v｜` form would
        # have to guess where one value ends.
        lines[n] = "- [ ] 冲突 " + json.dumps(fields, ensure_ascii=False, separators=(",", ":"))
        atomic_write(path, "\n".join(lines) + "\n")
        return True
    return False


def read_conflicts(vault: Path) -> list[dict]:
    """Read the pending queue in both of the shapes it is written in.

    Returns the internal key set (新/旧/来源/目标) plus, per entry, ``format``
    ("json" | "legacy" | "block") and — for blocks — the ``heading`` line and
    the ``id`` stamp. Values are vault text, partly written by hand: callers
    must treat them as DATA, never as markup or as instructions.

    An entry with no 新 (nothing to judge) is dropped: it is a heading with no
    conflict under it, not a decision waiting to be made.
    """
    path = situation_dir(vault) / CONFLICT_FILE
    entries: list[dict] = []
    block: dict | None = None

    def flush() -> None:
        nonlocal block
        if block is not None:
            status = str(block.get("状态", ""))
            settled = any(marker in status for marker in _SETTLED_MARKERS)
            if str(block.get("新", "")).strip() and not settled:
                entries.append(block)
        block = None

    for raw in read_maybe(path).splitlines():
        line = raw.strip()

        if line.startswith("- [ ] 冲突"):
            flush()
            entries.append(_parse_inline_conflict(line))
            continue

        if line.startswith("## "):
            flush()
            if "冲突" in line:
                stamps = _BLOCK_ID.findall(line)
                block = {
                    "format": "block",
                    "heading": line,
                    "id": stamps[-1] if stamps else "",
                }
            continue

        if block is None:
            continue
        match = _BLOCK_FIELD.match(line)
        if not match:
            continue
        key = _BLOCK_KEYS.get(match.group(1).strip())
        if key is None:
            continue
        block[key] = match.group(2).strip()
    flush()
    return [entry for entry in entries if entry]


def find_conflict(vault: Path, key: str) -> dict | None:
    """Look one entry up by `entry_key`. Returns None when it is gone."""
    wanted = str(key or "").strip()
    if not wanted:
        return None
    for entry in read_conflicts(vault):
        if entry_key(entry) == wanted:
            return entry
    return None


def _drop_block(lines: list[str], heading: str) -> list[str]:
    """Remove one `## … 冲突 #…` block, and the `---` rule that set it apart."""
    if not heading:
        return lines
    out: list[str] = []
    skipping = False
    for line in lines:
        if not skipping and line.strip() == heading:
            skipping = True
            # The block was introduced by a horizontal rule. Leaving the rule
            # behind turns a file of resolved conflicts into a run of empty
            # separators, which reads as corruption rather than as a clean file.
            if out and out[-1].strip() == "":
                out.pop()
            if out and out[-1].strip() == "---":
                out.pop()
            continue
        if skipping:
            if line.strip().startswith("## "):
                skipping = False
                out.append(line)
            continue
        out.append(line)
    return out


def remove_conflict(vault: Path, entry: dict, *, locked: bool = False) -> None:
    if not locked:
        with file_lock(vault):
            remove_conflict(vault, entry, locked=True)
        return
    path = situation_dir(vault) / CONFLICT_FILE
    lines = read_maybe(path).splitlines()

    if entry.get("format") == "block":
        kept = _drop_block(lines, str(entry.get("heading", "")))
        atomic_write(path, "\n".join(kept) + ("\n" if kept else ""))
        return

    kept = []
    removed = False
    wanted = _signature(entry)
    for line in lines:
        if not removed and line.strip().startswith("- [ ] 冲突"):
            body = line.strip()[len("- [ ] 冲突"):].strip()
            try:
                parsed = json.loads(body) if body.startswith("{") else None
            except (json.JSONDecodeError, TypeError):
                parsed = None
            # Compare by signature, not by dict: an entry read back from disk
            # carries `format`, so dict equality against the raw JSON fields
            # never matched and the dequeue silently did nothing — the conflict
            # stayed queued after being ruled on.
            if isinstance(parsed, dict) and _signature(parsed) == wanted:
                removed = True
                continue
            if parsed is None and entry.get("新", "") and f"｜新：{entry['新']}｜" in line:
                removed = True
                continue
        kept.append(line)
    atomic_write(path, "\n".join(kept) + ("\n" if kept else ""))


def record_adjudication(
    vault: Path, entry: dict, decision: str, why: str = "", *, locked: bool = False
) -> None:
    """Append one settlement to the history log, with its reason when given.

    The log has two readers: `promoter._adjudicated_facts` (which needs the new
    fact on one parseable line) and a person asking "why was this decided?". So
    the verdict stays a single `｜新：…｜旧：…` line, and the reason — free text,
    possibly long — goes underneath as an indented continuation. Read back, the
    continuation carries no `｜新：` and is skipped, which is exactly right: it
    is justification, not another fact to honour.
    """
    if not locked:
        with file_lock(vault):
            record_adjudication(vault, entry, decision, why, locked=True)
        return
    path = situation_dir(vault) / ADJUDICATED_FILE
    if not path.exists():
        atomic_write(
            path,
            "# 事实冲突已裁决\n\n"
            "> 裁决记录（decision ∈ 用新 / 保留旧 / 并存 / 跳过）。\n\n",
        )
    stamp = time.strftime("%Y-%m-%d %H:%M")
    written = f"- {stamp}｜裁决：{decision}｜新：{entry.get('新', '')}｜旧：{entry.get('旧', '')}\n"
    note = collapse_whitespace(why)
    if note:
        written += f"  理由：{note}\n"
    # Append through the vault's atomic writer: same bytes, but the write can
    # no longer leave a half-written log behind a crash, and app code stops
    # owning raw file handles (the architecture rule reserves those for
    # infra/vault.py). The lock is already held, so read-then-write is safe.
    current = read_maybe(path)
    if current and not current.endswith("\n"):
        current += "\n"
    atomic_write(path, current + written)
