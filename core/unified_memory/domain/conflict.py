# -*- coding: utf-8 -*-
"""conflict — the pure half of conflict handling (B5.4 split).

Similarity, subject extraction, classification, and the machine-to-human
rendering of one queued entry. Nothing here touches the vault: it takes
strings, returns verdicts and dicts. That is what lets the rules be tested
without a filesystem, and why both the queue writer and the CLI panel can
share them.

Rule (see ``classify_against`` — the code below is the contract):
  - exact (whitespace-normalized) text match -> duplicate (skip silently)
  - char-bigram similarity >= 0.5 (``CONFLICT_SIM_THRESHOLD``) with a
    different value and the same subject (when both sides have one) -> conflict
    (goes to the pending queue for human adjudication; canonical keeps the old
    value meanwhile). Replacement cues turn a conflict into a supersession one
    stage up, in ``app/govern/review.py``.

The vault side — reading and writing 情境信息/事实冲突待裁决.md and the
adjudication log — lives in ``app/govern/queue.py``. ``unified_memory.conflict``
re-exports both halves so the flat import path keeps working for one minor.
"""
from __future__ import annotations

import hashlib
import json
import re

from .markdown import bare_fact_line


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


# A subject is the stable head of a fact — what it is ABOUT. Three common ways a
# fact states its subject:
#   `备份目录：C:/x`            colon (but not `C:` — see the lookahead)
#   `UNIFIED_MEMORY_REMOTE_URL — optional …`   dash
#   `备份目录是 C:/x` / `已迁移到` / `放在`     verb
_SUBJECT_COLON = re.compile(r"^(.{2,20}?)\s*[：:]\s*(?![\\/])(.+)$")


_SUBJECT_DASH = re.compile(r"^(.{2,40}?)\s+(?:—|--|–)\s*(.+)$")


_SUBJECT_VERB = re.compile(
    r"^(.{2,20}?)\s*"
    r"(?:是|为|在|已改为|改为|已迁移到|迁移到|已换成|换成|现在在|放在)\s*(.+)$"
)


_DATE_ONLY = re.compile(r"^[0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{1,4}$")


# Template placeholders: a line under these headings is an example, not a fact.
_NOT_A_SUBJECT = {"示例", "example", "备注", "note"}


def subject_of(text: str) -> str:
    """The stable head of a fact: what it is about, with its value removed.

    `备份目录是 C:/backups` and `备份目录已迁移到 D:/backups` are one statement
    about 备份目录 with two values. `默认模型：X` and `可用模型：X` are two
    statements that happen to share a value. Similarity cannot tell those apart —
    on a real vault the second pair scored HIGHER (0.86) than the first (0.61) —
    because look-alikes share a template while contradictions share only a
    subject. So the head is compared separately.

    Returns "" when the line has no recognisable head. An empty head disables the
    check for that pair: falling back to similarity re-admits some look-alikes,
    which is the safer direction — a spurious question can be answered, a silently
    dropped contradiction cannot be recovered.
    """
    body = bare_fact_line(str(text or "")) or str(text or "")
    body = body.replace("**", "").strip()
    for pattern in (_SUBJECT_COLON, _SUBJECT_DASH, _SUBJECT_VERB):
        match = pattern.match(body)
        if not match:
            continue
        head = match.group(1).strip()
        # A date-headed line is a log entry, not a statement about a thing; a
        # template placeholder is an example. Both mean "no subject", and asking
        # the next pattern would only read the same line a worse way.
        if _DATE_ONLY.match(head) or head.lower() in _NOT_A_SUBJECT:
            return ""
        # A head containing a separator is a truncated path, not a subject.
        if any(ch in head for ch in "\\/"):
            return ""
        return head
    return ""


# Two subjects are the same when they are the same words. Deliberately not a
# similarity test: char-bigram overlap scores `备份目录`/`备份路径` and
# `默认模型`/`可用模型` identically (both 0.33), so any threshold loose enough to
# reunite the first also fuses the second. On a real vault every fuzzy-friendly
# pair turned out to be a look-alike — `UNIFIED_MEMORY_REMOTE_URL` against
# `UNIFIED_MEMORY_REMOTE_TOKEN` scores 0.79 and contradicts nothing — so a fuzzy
# branch would be a knob that only ever points the wrong way. Synonyms are
# therefore treated as different subjects: the pair stops being a question, but
# the new line is still written, so both readings stay on the page.
def same_subject(left: str, right: str) -> bool:
    """Whether two heads name the same thing. Empty heads never match."""
    return bool(left) and left == right


def classify_against(new_fact: str, existing_lines: list[str]) -> tuple[str, str | None]:
    """Return ('duplicate'|'conflict'|'new', existing_line_or_None).

    Only an exact (whitespace-normalized) match is a duplicate.

    A CONFLICT needs two things: the two lines are similar, AND they are about
    the same subject. Similarity alone queued pairs that merely shared a template
    — `默认模型：openrouter/free` against `可用模型：openrouter/free` — while a real
    contradiction about the same subject could score lower. Raising the
    similarity threshold cannot fix that: it drops true contradictions before it
    drops look-alikes, because the look-alikes are the ones that share a template.
    The subject check is what makes "conflict" mean "same statement, new value".

    When either side has no recognisable subject the pair falls back to plain
    similarity. That re-admits some look-alikes and never drops a real
    contradiction, which is the right side to err on: a wasted question gets
    answered and leaves no trace, a missed contradiction gets written over.
    """
    for line in existing_lines:
        bare = line.strip()
        if new_fact.strip() == bare:
            return ("duplicate", line)
        if similarity(new_fact, bare) < CONFLICT_SIM_THRESHOLD:
            continue
        left, right = subject_of(new_fact), subject_of(bare)
        if left and right and not same_subject(left, right):
            # Same template, different subjects: not this line's contradiction.
            # Keep looking — a later line about the same subject still counts.
            continue
        return ("conflict", line)
    return ("new", None)


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


# What an agent's recommendation travels under once it has read a conflict and
# could not settle it on its own. `建议` is one of `promoter.DECISIONS`; `解释`
# is the plain-language reason, written for the person who still has to choose.
ADVICE_CHOICE = "建议"


ADVICE_WHY = "解释"


# `- 新提交：…`, `- **新提交**：…`, `- 状态：[待裁决]`
_BLOCK_FIELD = re.compile(r"^-\s*\**\s*([^：:*]+?)\s*\**\s*[：:]\s*(.*)$")


# The field names a block may carry, mapped onto the internal keys the rest
# of the core already speaks (新/旧/来源/目标). `建议`/`解释` are the agent's
# recommendation on a conflict it could not settle — see `record_advice`.
_BLOCK_KEYS = {
    "新提交": "新",
    "既有": "旧",
    "来源": "来源",
    "所在": "目标",
    "状态": "状态",
    "建议": ADVICE_CHOICE,
    "解释": ADVICE_WHY,
}


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


# `- 建议：…` / `- **建议**：…` / `- 解释：…` — replaced in place rather than
# appended, so advising twice leaves one recommendation, not a pile.
_ADVICE_LINE = re.compile(r"^-\s*\**\s*(?:建议|解释)\s*\**\s*[：:]")


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
