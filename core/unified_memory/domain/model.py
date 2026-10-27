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

from dataclasses import dataclass


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
