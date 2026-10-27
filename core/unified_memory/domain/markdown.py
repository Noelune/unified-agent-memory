# -*- coding: utf-8 -*-
"""Markdown fact-line and stamp handling (moved verbatim from common.py, B1).

Standard library only: redaction, credential detection, the <memory-data>
envelope encoding, promotion-stamp parsing and the bare-fact comparisons the
dedup / conflict / forgetting paths all share.
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


# The one fence this project speaks. Kept next to encode_untrusted so the
# tag and its escaping rule cannot drift apart.
MEMORY_DATA_TAG = "memory-data"


def encode_untrusted(text: str) -> str:
    """Make vault text safe to place inside a ``<memory-data>`` envelope.

    A fact line that itself contains ``</memory-data>`` would close the
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
    """Remove promotion/usage/version suffixes, returning the bare fact text."""
    out = EN_STAMP_RE.sub("", STAMP_RE.sub("", line or ""))
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
