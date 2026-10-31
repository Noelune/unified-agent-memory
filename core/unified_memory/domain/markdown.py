# -*- coding: utf-8 -*-
"""Markdown fact-line and stamp handling (moved verbatim from common.py, B1).

Standard library only: redaction, credential detection, the DATA envelope
encoding (domain.envelope owns the fence), promotion-stamp parsing and the
bare-fact comparisons the dedup / conflict / forgetting paths all share.
"""
from __future__ import annotations

import re
import time

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


def encode_untrusted(text: str) -> str:
    """Make vault text safe to place inside the DATA envelope.

    A fact line that itself contains a closing fence tag would close the
    envelope early and turn everything after it into model-visible
    instructions (reproduced end to end in the batch-A audit). ``<`` and
    ``>`` are therefore escaped to their ``\\uXXXX`` forms — the same trick
    the JS side has used in repair-prompt.encodePayload since it was written:
    a model reads the escaped form as the same character, but it can no
    longer terminate a tag. NUL and the other C0 controls are dropped so a
    crafted byte cannot forge line structure either.

    Every field that reaches the envelope must pass through here: doc names,
    fact lines, snippets, echoed queries, whole-note bodies.
    """
    out = (text or "").replace("<", "\\u003c").replace(">", "\\u003e")
    return "".join(
        ch for ch in out if ch in ("\n", "\t") or (ch >= " " and ch != "\x7f")
    )


def looks_like_credential(line: str) -> bool:
    return bool(CREDENTIAL_LINE_RE.search(line))


def collapse_whitespace(text: str) -> str:
    """One line, no runs of whitespace — or "" when there is nothing to say.

    A reason is free text: an agent writes it, a person pastes it, and it has to
    travel into a line-oriented markdown block. Newlines would split the entry
    it belongs to, and a reason of pure whitespace would be written out as an
    empty field — which is how `- 解释：` with nothing after it ends up in the
    queue. Both are answered by the same collapse, so the check for "is there
    anything to say" and the normalisation of what is said cannot drift apart.
    """
    return " ".join(str(text or "").split())


# --------------------------------------------------------------------------
# Promotion stamps
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
# Obsidian-native block ID (batch D): the stable identity of a fact line,
# appended at first promotion / backfill and never regenerated. The `c-`
# prefix marks claim ids so they cannot collide with user-chosen block ids.
BLOCK_ID_RE = re.compile(r"\s+\^c-([0-9a-f]{16})\s*$")


def claim_id_of(line: str) -> str:
    """The 16-hex claim id a fact line carries, or "" when it has none."""
    m = BLOCK_ID_RE.search(line or "")
    return m.group(1) if m else ""


def has_claim_id(line: str) -> bool:
    return bool(BLOCK_ID_RE.search(line or ""))


def with_claim_id(line: str, claim_id: str) -> str:
    """Append (or replace) the line's block-id suffix."""
    stripped = BLOCK_ID_RE.sub("", (line or "").rstrip())
    return f"{stripped} ^c-{claim_id}"


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
    """Remove promotion/usage/version suffixes, returning the bare fact text.

    The block-id suffix strips too (batch D): the bare text that feeds
    dedup/conflict comparison and the search index must stay id-free, so two
    copies of the same fact never differ by their identity suffix.
    """
    out = BLOCK_ID_RE.sub("", line or "")
    out = EN_STAMP_RE.sub("", STAMP_RE.sub("", out))
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


# --------------------------------------------------------------------------
# CJK-aware tokenisation + canonical-note line parsing (moved verbatim from
# index.py, B2 — pure text processing, no storage). The store's lexical index
# and the migrations both need these, and infra may import domain freely.
# --------------------------------------------------------------------------

_CJK_RUN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+")
_WORD_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.\-]*")


def cjk_tokens(text: str) -> list[str]:
    """Overlapping-bigram tokens for Chinese + lowercased ASCII words.

    unicode61 treats a contiguous Chinese run as a single token, so a query
    like 记忆 can never match a line containing 记忆系统. Bigrams restore
    ordinary substring recall without a third-party segmenter.
    """
    tokens: list[str] = []
    for run in _CJK_RUN_RE.findall(text or ""):
        if len(run) == 1:
            tokens.append(run)
        else:
            tokens.extend(run[i : i + 2] for i in range(len(run) - 1))
    for word in _WORD_RE.findall(text or ""):
        word = word.lower()
        if len(word) >= 2:
            tokens.append(word)
    # Stable dedupe: repeated tokens add nothing to a BM25 query.
    seen: set[str] = set()
    return [t for t in tokens if not (t in seen or seen.add(t))]


SUPERSEDED_HEADING_RE = re.compile(r"已取代|已失效|已废弃|superseded|obsolete", re.I)


def parse_write_stamp(line: str) -> tuple[str | None, str]:
    """Return (created_date, source_agent) parsed from a promoted line's stamp.

    Delegates to parse_stamp so both the repo/dsh dialect and the Hermes
    ``[[Agent提交区/...]]`` / ``事件`` dialect resolve. Returning "" for every
    Hermes-written line used to make the whole live vault look undated and
    unattributed.
    """
    created, source, _valid_until = parse_stamp(line)
    return created, source_agent(source)


def doc_lines(text: str) -> list[tuple[str, str, str]]:
    """Parse a canonical note into (status, bare_line, raw_line) tuples.

    A line under a heading that mentions 已取代/已失效/已废弃 (or superseded)
    is marked ``superseded``; everything else is ``active``. Non-fact lines
    (headings, prose, tables) are ignored.
    """
    out: list[tuple[str, str, str]] = []
    heading = ""
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped.startswith("#"):
            heading = stripped
            continue
        if not stripped.startswith(("- ", "• ", "* ")):
            continue
        bare = bare_fact_line(stripped)
        if not bare:
            continue
        # Bi-temporal versioning: a line carrying ｜有效至 is a historical
        # version even when it is not physically under a 已取代 heading. That
        # is how the Hermes promoter records supersession, so it must not stay
        # searchable as current truth.
        status = (
            "superseded"
            if SUPERSEDED_HEADING_RE.search(heading) or is_versioned(stripped)
            else "active"
        )
        out.append((status, bare, stripped))
    return out
