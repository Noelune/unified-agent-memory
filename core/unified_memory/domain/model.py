# -*- coding: utf-8 -*-
"""model — the read-model types every output surface renders from.

``Evidence`` is the single shape a memory fact takes on its way out of the
core: CLI text, ``--json``, the remote index and the console panel all render
from this, so formatting rules live in exactly one place. It is a *view*
type — the authoritative fact lives in Markdown; nothing here is persisted.

``confidence`` is reserved for batch C (disputed / low-score gating). It is
part of the shape now so adding it later is not a breaking change, but this
module never fills it and no renderer reads it yet.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


@dataclass(frozen=True)
class Evidence:
    """One memory fact as an output surface renders it.

    ``claim_id`` is the full occurrence id; output surfaces shorten it to the
    10-char citation prefix themselves (see domain.envelope.cite_prefix).
    ``line`` carries the fact text; the lexical stream fills it with the
    matched snippet, which is the same contract the JSON output has always had.
    """

    claim_id: str = ""
    doc: str = ""
    line: str = ""
    type: str = ""
    importance: float | None = None
    score: float | None = None
    source: str = ""
    written_at: str = ""
    confidence: str = ""  # reserved (batch C): disputed / low / high; not filled yet


@dataclass(frozen=True)
class Change:
    """One file rewrite a plan wants, with the world it was computed against.

    ``before_text`` is the file content the plan READ when it decided
    ``after_text`` was correct. The executor re-checks it under the lock: if
    the file has moved on, the plan is stale and gets re-run there (batch B).
    ``before_text == ""`` means the file did not exist at plan time.

    ``facts`` / ``meta`` are writer bookkeeping and are NOT journaled:
    ``facts`` carries the (source, fact) pairs a promote added (for audit),
    ``meta`` carries per-writer report data (e.g. the dropped lines a repair
    removed). The journal only serialises op/doc/before/after.
    """

    op: str  # "rewrite_doc" | "backup_doc"
    doc: Path
    before_text: str = ""
    after_text: str = ""
    facts: tuple = ()
    meta: dict = field(default_factory=dict)


@dataclass(frozen=True)
class ChangeSet:
    """A planned, not-yet-applied unit of canonical writes.

    ``replan`` re-runs the plan against the CURRENT file state and is called
    by the executor under the lock when the staleness check fails — the same
    re-validation the old inline writers performed inside their ``with
    file_lock`` blocks, now explicit. It may be None for plans that read
    nothing (tests).
    """

    actor: str
    reason: str
    changes: tuple[Change, ...]
    replan: Callable[[], "ChangeSet"] | None = None
