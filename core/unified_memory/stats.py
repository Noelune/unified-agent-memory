# -*- coding: utf-8 -*-
"""stats — compatibility shim (batch B5.3).

The implementation moved to ``app.query.stats``; this module keeps the
historical import path (tests, health) working for one minor (taskbook §0.7).
"""
from __future__ import annotations

from .app.query.stats import (  # noqa: F401  (re-exported)
    _day,
    _inbox_count,
    _scalar,
    _span,
    access_counts,
    build,
    daily_counts,
    envelope,
    importance_counts,
    top_accessed,
    type_counts,
)
