# -*- coding: utf-8 -*-
"""maintenance — compatibility shim (B5.4).

The implementation moved to ``app/maintain/repair.py``. This path stays so
``python -m unified_memory.maintenance``-style callers, the CLI and the tests
keep working for one minor (taskbook §0.7).

Note for patching: a re-export is a separate binding — patch
``unified_memory.app.maintain.repair`` instead.
"""
from __future__ import annotations

from .app.maintain.repair import (  # noqa: F401  (compat re-exports)
    TEMPLATE_PLACEHOLDER_RE,
    plan_repair,
    repair_existing,
)
