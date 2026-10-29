# -*- coding: utf-8 -*-
"""facts — how a fact line is recognised, appended, and retired (B5.4 split).

The promoter and the adjudicator both edit canonical notes without reading
them as documents: they need to know which bullets are *active* (above the
history heading), where a new fact belongs (end of that active region), and how
to move a replaced value into history so the index marks it superseded instead
of silently deleting it.

None of that needs the vault: every function here takes text and returns text,
which is what makes these rules testable on their own and keeps the promoter's
apply path from re-implementing them.
"""
from __future__ import annotations

import re
from typing import Callable

from .markdown import bare_fact_line


# A "supersession" fact replaces an existing one (version bump, migration,
# deprecation). When a similar-but-different fact contains one of these cues it
# is routed to the pending list as a 取代 entry instead of the conflict queue.
SUPERSESSION_RE = re.compile(
    r"改为|改用|换成|迁移到|升级到|更新为|弃用|废弃|不再使用|代替|替代|替换|取代|"
    r"deprecated|superseded|replaced by|now uses|instead of|new version|新版本",
    re.I,
)


HISTORY_HEADING_RE = re.compile(
    r"^#{1,4}\s*(?:已取代|已失效|已废弃|superseded|obsolete|deprecated)", re.I
)


def history_start(lines: list[str]) -> int:
    """Index of the first history heading in ``lines``, or ``len(lines)``."""
    return next(
        (i for i, ln in enumerate(lines) if HISTORY_HEADING_RE.match(ln)),
        len(lines),
    )


def active_fact_lines(text: str, *, drop_examples: bool = False) -> list[str]:
    """Bullet facts from the active region only — history sections excluded.

    ``drop_examples`` skips the template's placeholder lines ("示例" /
    "example"), which is what the conflict detector wants and what the writers
    must not want (a user's real fact may legitimately mention an example URL).
    """
    lines = text.splitlines()
    active = lines[: history_start(lines)]
    out: list[str] = []
    for ln in active:
        if not ln.lstrip().startswith("-"):
            continue
        bare = bare_fact_line(ln)
        if not bare:
            continue
        if drop_examples and ("示例" in ln or "example" in ln.lower()):
            continue
        out.append(bare)
    return out


def append_active_facts(text: str, new_lines: list[str]) -> str:
    """Insert fact lines at the end of a note's *active* region.

    Appending to the end of the file was correct only until the note grew a
    history section: from then on every new fact landed below that heading,
    the index marked it ``superseded``, and the value that had just been
    promoted was unreachable by search. ``_move_to_superseded`` has always
    inserted *into* that section for the mirror-image reason; this is its
    complement.
    """
    additions = [ln.rstrip("\n") for ln in new_lines if ln.strip()]
    if not additions:
        return text
    lines = text.splitlines()
    at = history_start(lines)
    head, tail = lines[:at], lines[at:]
    while head and not head[-1].strip():
        head.pop()
    head.extend(additions)
    if tail:
        head.append("")  # keep a blank line between the last fact and the heading
        head.extend(tail)
    return "\n".join(head) + "\n"


def move_to_superseded(text: str, matches: Callable[[str], bool]) -> str:
    """Move the first fact line ``matches`` accepts under the history section.

    The index rebuild marks lines under a history heading as ``superseded``, so
    this keeps the record while removing the old value from active recall.

    Parameterised by a predicate because the two callers recognise the same old
    fact from different spellings: ``promote`` holds the bare text the pending
    list recorded, while ``decide`` holds whatever the conflict entry carried
    (a block entry stores the whole markdown line, stamp and bullet included)
    and has to compare through ``_comparable``. Matching by one fixed rule there
    silently removed nothing, which is why the two paths disagreed.
    """
    lines = text.splitlines()
    removed: str | None = None
    kept: list[str] = []
    for ln in lines:
        if removed is None and ln.lstrip().startswith("-") and matches(ln):
            removed = ln
            continue
        kept.append(ln)
    if removed is None:
        return text
    removed_stripped = removed.rstrip()
    section_idx = next(
        (i for i, ln in enumerate(kept) if HISTORY_HEADING_RE.match(ln)),
        None,
    )
    if section_idx is None:
        return "\n".join(kept).rstrip() + "\n\n## 已取代\n\n" + removed_stripped + "\n"
    # Insert at the end of that section: the next heading, or EOF.
    insert_at = len(kept)
    for i in range(section_idx + 1, len(kept)):
        if kept[i].startswith("#"):
            insert_at = i
            break
    kept.insert(insert_at, removed_stripped)
    return "\n".join(kept) + ("\n" if kept else "")


def _move_to_superseded(text: str, old_bare: str) -> str:
    """``move_to_superseded`` for the bare-text spelling the pending list uses."""
    return move_to_superseded(text, lambda ln: bare_fact_line(ln) == old_bare)


_STAMP_TAIL = re.compile(r"（[^（）]*(?:写入|来源)[^（）]*）\s*$")


def _comparable(text: str) -> str:
    """Fact text normalized for identity, tolerating a truncated stamp.

    `bare_fact_line` removes the canonical `（写入 …｜来源：…）` suffix, but a
    conflict recorded by hand may carry only `（写入 2026-10-16）`, which it
    leaves alone — so 用新 matched nothing and appended the new fact beside the
    old one. Dropping a trailing provenance-flavoured parenthetical makes the
    two sides comparable without eating a real `（备注）` that a fact happens to
    end with, which would remove the wrong line.
    """
    out = bare_fact_line(text)
    while True:
        trimmed = _STAMP_TAIL.sub("", out).strip()
        if trimmed == out or not trimmed:
            return out
        out = trimmed
