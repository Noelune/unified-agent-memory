# -*- coding: utf-8 -*-
"""digest — compatibility shim (batch B5.3).

The implementation moved to ``app.ingest.digest``; this module keeps
``python -m unified_memory.digest``, the daily-cron integration and the
historical import path working for one minor (taskbook §0.7).
"""
from __future__ import annotations

import sys

from .app.ingest.digest import (  # noqa: F401  (re-exported)
    CHAT_URL,
    CONFIG_ENABLED_KEY,
    CURSOR_KEY,
    DEFAULT_CHAT_MODEL,
    MAX_FACTS_PER_FILE,
    MAX_INPUT_CHARS,
    SESSION_DIRS,
    SOURCES,
    STATE_CURSOR_KEY,
    SYSTEM_PROMPT,
    _archive_files,
    _cursor,
    _date_of,
    _parse_facts,
    _set_enabled,
    _transcript_of,
    _units,
    _write_digest_facts,
    chat_extract_facts,
    digest,
    digest_enabled,
    main,
)

if __name__ == "__main__":
    main()
