# -*- coding: utf-8 -*-
"""drift — compatibility shim (batch B5.3).

The implementation moved to ``app.maintain.drift``; this module keeps
``python -m unified_memory.drift`` and the historical import path working for
one minor (taskbook §0.7). Delete it when the old path's consumers are gone.
"""
from __future__ import annotations

import sys

from .app.maintain.drift import (  # noqa: F401  (re-exported)
    CANONICAL_MAP_REL,
    DRIFTRC_NAME,
    VAULT_TEMPLATE_REL,
    DriftDetector,
    DriftItem,
    DriftReport,
    main,
)

if __name__ == "__main__":
    sys.exit(main())
