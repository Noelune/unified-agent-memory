# -*- coding: utf-8 -*-
"""preview — compatibility shim (batch B5.3).

The implementation moved to ``app.query.preview``; this module keeps the
historical import path (tests, stats, inbox) working for one minor
(taskbook §0.7).
"""
from __future__ import annotations

from .app.query.preview import (  # noqa: F401  (re-exported)
    INBOX_REL,
    VIEWS,
    _advice,
    _conflicts,
    _forgetting,
    _note_name,
    _pending,
    _recent,
    _safe_inbox_name,
    build,
    envelope,
    read_inbox_item,
)
