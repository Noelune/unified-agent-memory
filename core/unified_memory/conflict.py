# -*- coding: utf-8 -*-
"""conflict — compatibility shim (B5.4 split).

The implementation moved: the pure rules are in ``domain/conflict.py`` and the
vault I/O is in ``app/govern/queue.py``. This module re-exports both halves so
``python -m unified_memory.promoter``, the panels and the tests keep importing
``unified_memory.conflict`` for one minor (taskbook §0.7).

Note for patching: a re-export is a separate binding. Patching a name HERE does
not reach the implementation — patch ``unified_memory.domain.conflict`` or
``unified_memory.app.govern.queue`` instead.
"""
from __future__ import annotations

from .domain.conflict import (
    char_bigrams,
    similarity,
    subject_of,
    same_subject,
    classify_against,
    _signature,
    entry_key,
    _parse_inline_conflict,
    describe,
    split_change,
    CONFLICT_SIM_THRESHOLD,
    _SUBJECT_COLON,
    _SUBJECT_DASH,
    _SUBJECT_VERB,
    _DATE_ONLY,
    _NOT_A_SUBJECT,
    ADVICE_CHOICE,
    ADVICE_WHY,
    _BLOCK_FIELD,
    _BLOCK_KEYS,
    _BLOCK_ID,
    _SETTLED_MARKERS,
    _ADVICE_LINE,
    _BULLET,
    _PROVENANCE_TAIL,
    _RECORDED_AT,
    _SOURCE_IN_STAMP,
    _WIKILINK,
    _BOUNDARY,
    _SNAP_LIMIT,
)
from .app.govern.queue import (
    append_conflict,
    record_advice,
    read_conflicts,
    find_conflict,
    _drop_block,
    remove_conflict,
    record_adjudication,
)
