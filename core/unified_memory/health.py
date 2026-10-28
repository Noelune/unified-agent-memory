# -*- coding: utf-8 -*-
"""health — compatibility shim (batch B5.3).

The implementation moved to ``app.maintain.health``; this module keeps the
historical import path (tests, gc) working for one minor (taskbook §0.7).
"""
from __future__ import annotations

from .app.maintain.health import (  # noqa: F401  (re-exported)
    ACCESS_RETENTION_DAYS,
    BLOAT_BYTES,
    ORPHAN_INDEX_DAYS,
    QUERY_CACHE_RETENTION_DAYS,
    STALE_INBOX_DAYS,
    UNCLASSIFIED_FILE,
    _days_ago,
    _issue,
    doctor,
    gc,
)
