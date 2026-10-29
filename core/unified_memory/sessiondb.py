# -*- coding: utf-8 -*-
"""Shim — sessiondb moved to infra/sessiondb.py (batch B5.5a); no logic here.

Kept because ``python -m unified_memory.sessiondb`` is a documented entry
point (e2e covers --status/--show/--export) and digest/tests import the old
path. Shim lives one minor release per the taskbook §0.7 convention.
"""
from .infra.sessiondb import (  # noqa: F401
    DB_ENV,
    DEFAULT_ROLES,
    MAX_MESSAGES_PER_SESSION,
    MAX_TRANSCRIPT_CHARS,
    REQUIRED_MESSAGE_COLUMNS,
    REQUIRED_SESSION_COLUMNS,
    SessionDbUnavailable,
    available,
    dated_transcripts,
    export_markdown,
    main,
    probe,
    resolve_db,
)

if __name__ == "__main__":
    main()
