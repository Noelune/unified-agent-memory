# -*- coding: utf-8 -*-
"""Conflict detection: char-bigram similarity + pending/adjudicated queues.

Rule (same as the vault's coordination convention):
  - similarity >= 0.9 and identical text  -> duplicate (skip silently)
  - similarity >= 0.5 but different value -> conflict (goes to the pending
    queue for human adjudication; canonical keeps the old value meanwhile)

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
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path

from .common import (
    ADJUDICATED_FILE,
    CONFLICT_FILE,
    atomic_write,
    file_lock,
    read_maybe,
    situation_dir,
)


def char_bigrams(text: str) -> set[tuple[str, str]]:
    text = text.strip()
    return {(text[i], text[i + 1]) for i in range(len(text) - 1)}


def similarity(a: str, b: str) -> float:
    """Jaccard-style overlap of char-bigram sets, 0.0 .. 1.0."""
    ba, bb = char_bigrams(a), char_bigrams(b)
    if not ba and not bb:
        return 1.0 if a == b else 0.0
    if not ba or not bb:
        return 0.0
    return len(ba & bb) / max(len(ba), len(bb))


CONFLICT_SIM_THRESHOLD = 0.5


def classify_against(new_fact: str, existing_lines: list[str]) -> tuple[str, str | None]:
    """Return ('duplicate'|'conflict'|'new', existing_line_or_None).

    Only an exact (whitespace-normalized) match is a duplicate. A similar-but-
    different fact is a CONFLICT for human adjudication — the conservative
    choice, since similar wording with a different value is usually a state
    change or a contradiction.
    """
    for line in existing_lines:
        bare = line.strip()
        if new_fact.strip() == bare:
            return ("duplicate", line)
        if similarity(new_fact, bare) >= CONFLICT_SIM_THRESHOLD:
            return ("conflict", line)
    return ("new", None)


# --------------------------------------------------------------------------
# Pending conflict queue (情境信息/事实冲突待裁决.md)
# --------------------------------------------------------------------------


def _signature(entry: dict) -> tuple[str, str, str]:
    """Identity of a conflict, for de-duplication across the two shapes.

    Deliberately excludes the `format`/`heading`/`id` bookkeeping keys: the same
    conflict must compare equal whether it came from a JSON line or from a
    block, otherwise `append_conflict` re-queues what is already queued.
    """
    return (
        str(entry.get("新", "")).strip(),
        str(entry.get("旧", "")).strip(),
        str(entry.get("来源", "")).strip(),
    )


def entry_key(entry: dict) -> str:
    """A stable id for one conflict, usable as a form value.

    Preferred source is the human-written `#20261019030125-1` stamp, because it
    is what the user can point at in the file. Falls back to a hash of the
    content so the JSON shape has a key too — a list index would shift whenever
    an earlier entry is resolved, which is exactly when a stale click arrives.
    """
    ident = str(entry.get("id") or "").strip().lstrip("#")
    if ident:
        return ident
    return hashlib.sha1("\x1f".join(_signature(entry)).encode("utf-8")).hexdigest()[:16]


# `- 新提交：…`, `- **新提交**：…`, `- 状态：[待裁决]`
_BLOCK_FIELD = re.compile(r"^-\s*\**\s*([^：:*]+?)\s*\**\s*[：:]\s*(.*)$")
# The five field names a block may carry, mapped onto the internal keys the rest
# of the core already speaks (新/旧/来源/目标).
_BLOCK_KEYS = {"新提交": "新", "既有": "旧", "来源": "来源", "所在": "目标", "状态": "状态"}
# No `\s*` after the hash: `## 2026-10-19 … #20261019030125-1` must yield the
# stamp, not the date — a heading starts with `## `, so a permissive gap makes
# the date the first match and the id the second.
_BLOCK_ID = re.compile(r"#([0-9][0-9A-Za-z._-]*)")
# A block that says it is already resolved is not pending, even if whoever
# resolved it never deleted the block. Counting it would resurrect a decision.
_SETTLED_MARKERS = ("已裁决", "已处理", "已完成", "已解决")


def _parse_inline_conflict(line: str) -> dict:
    """Parse one `- [ ] 冲突 …` line: a JSON body, or the legacy ｜k：v｜ form."""
    body = line[len("- [ ] 冲突"):].strip()
    if body.startswith("{"):
        try:
            fields = json.loads(body)
        except (json.JSONDecodeError, TypeError):
            return {}
        if not isinstance(fields, dict):
            return {}
        entry = {str(key): str(value) for key, value in fields.items()}
        entry["format"] = "json"
        return entry
    fields: dict[str, str] = {}
    for part in body.lstrip("｜").split("｜"):
        key, _, value = part.partition("：")
        if key and value:
            fields[key.strip()] = value.strip()
    if not fields:
        return {}
    fields["format"] = "legacy"
    return fields


def append_conflict(vault: Path, new_fact: str, existing_line: str, source: str, target_file: str = "") -> None:
    """Queue one conflict; never touches canonical notes.

    Always writes the single-line JSON shape: it is unambiguous for a machine
    to read back, and both shapes are read, so there is nothing to gain from
    emitting the human one. Duplicate suppression compares `_signature`, not
    dict equality — dict equality would stop matching the moment a reader adds
    bookkeeping keys, and the queue would grow a copy per pass.
    """
    path = situation_dir(vault) / CONFLICT_FILE
    fields = {"新": new_fact, "旧": existing_line, "来源": source}
    if target_file:
        fields["目标"] = target_file
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


# --------------------------------------------------------------------------
# Making a conflict readable: what each side SAYS, and where it came from
# --------------------------------------------------------------------------
#
# A queued entry is written by an agent, for an agent: a bullet, a stamp and an
# event id, all in one line. Handing that line to a person and asking "which is
# right?" is not a question they can answer — the first thing they have to do
# is strip the noise, and the second is find the one substring that differs in
# two nearly identical paths. Both are mechanical, so both belong here.

_BULLET = re.compile(r"^\s*[-*+]\s+")
# A parenthetical is provenance only when it mentions 写入 or 来源. `（随时可回滚）`
# is part of the fact and must survive: dropping every trailing parenthetical
# would delete the very clause that tells the reader what the backup is for.
_PROVENANCE_TAIL = re.compile(r"（[^（）]*(?:写入|来源)[^（）]*）\s*$")
_RECORDED_AT = re.compile(r"写入\s*([0-9]{4}-[0-9]{2}-[0-9]{2})")
_SOURCE_IN_STAMP = re.compile(r"来源：\s*([^，）]+)")
_WIKILINK = re.compile(r"^\[\[(.+?)\]\]$")


def describe(text: str) -> dict:
    """Split one side of a conflict into the fact, when, and from where.

    Returns ``{"text", "recorded", "source"}``. ``text`` never loses a clause
    that carries meaning: only a trailing parenthetical about 写入/来源 is
    removed, so `（随时可回滚）` stays attached to the fact it qualifies. When
    stripping would leave nothing (the line is nothing but a stamp), the
    original text is returned rather than an empty string.
    """
    raw = str(text or "").strip()
    body = _BULLET.sub("", raw)
    recorded = ""
    source = ""
    while True:
        match = _PROVENANCE_TAIL.search(body)
        if not match:
            break
        stamp = match.group(0)
        if not recorded:
            found = _RECORDED_AT.search(stamp)
            if found:
                recorded = found.group(1)
        if not source:
            found = _SOURCE_IN_STAMP.search(stamp)
            if found:
                source = found.group(1).strip()
        body = body[: match.start()].rstrip()
    link = _WIKILINK.match(source)
    if link:
        source = link.group(1)
    return {"text": body or raw, "recorded": recorded, "source": source}


# Where a difference may start. Cutting inside a path segment produces a
# difference nobody can read ("character 61 changed"), so the split snaps back
# to one of these.
_BOUNDARY = ("\\", "/", "｜", "|", "：", ":", "，", ",", " ", "`", "、")

# How far back the snap may look for a boundary. Enough to reach the previous
# path segment, short enough that the shared context the reader needs to compare
# the two values is never swallowed.
_SNAP_LIMIT = 40


def split_change(new: str, old: str) -> dict | None:
    """Where two versions of one fact stop agreeing.

    Returns ``{"prefix", "new", "old", "suffix"}`` — everything before the
    difference, the two differing middles, and the shared tail — or None when
    the two are identical.

    The split snaps to a separator so the difference starts at something a
    reader can point at: ``…\\backups\\`` shared, then ``soul\\SOUL.md.bak-…``
    against ``adjudicate-…\\``. Without the snap, two values differing only in
    their last digits are reported as "they diverge mid-word", which is true and
    useless.
    """
    if not new or not old or new == old:
        return None
    limit = min(len(new), len(old))
    i = 0
    while i < limit and new[i] == old[i]:
        i += 1
    floor = max(0, i - _SNAP_LIMIT)
    for k in range(i, floor, -1):
        if new[k - 1] in _BOUNDARY and old[k - 1] in _BOUNDARY:
            i = k
            break
    j = 0
    while j < min(len(new), len(old)) - i and new[-1 - j] == old[-1 - j]:
        j += 1
    # A one-character suffix is a coincidence, not a shared ending.
    if j < 2:
        j = 0
    return {
        "prefix": new[:i],
        "new": new[i: len(new) - j],
        "old": old[i: len(old) - j],
        "suffix": new[len(new) - j:] if j else "",
    }



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


def record_adjudication(vault: Path, entry: dict, decision: str, *, locked: bool = False) -> None:
    if not locked:
        with file_lock(vault):
            record_adjudication(vault, entry, decision, locked=True)
        return
    path = situation_dir(vault) / ADJUDICATED_FILE
    if not path.exists():
        atomic_write(
            path,
            "# 事实冲突已裁决\n\n"
            "> 裁决记录（decision ∈ 用新 / 保留旧 / 并存 / 跳过）。\n\n",
        )
    stamp = time.strftime("%Y-%m-%d %H:%M")
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"- {stamp}｜裁决：{decision}｜新：{entry.get('新', '')}｜旧：{entry.get('旧', '')}\n")
