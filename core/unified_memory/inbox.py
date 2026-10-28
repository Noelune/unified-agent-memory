# -*- coding: utf-8 -*-
"""inbox — compatibility shim (batch B5.3).

The implementation moved to ``app.ingest.inbox``; this module keeps the
historical import path (tests, promoter) working for one minor (taskbook §0.7).
"""
from __future__ import annotations

from .app.ingest.inbox import (  # noqa: F401  (re-exported)
    DONE_DIR,
    _unique_target,
    process_inbox_item,
)
