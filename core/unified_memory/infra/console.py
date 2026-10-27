# -*- coding: utf-8 -*-
"""Console encoding guard (moved verbatim from common.py, B1).

Every CLI module imports ``common`` (now: the shim, which imports this), so the
module-level call below still covers all of them exactly as before. Importing
this module is the side effect; nothing else may move console state.
"""
from __future__ import annotations

import sys


def ensure_utf8_console(stream=None) -> None:
    """Make a text stream tolerate CJK output on non-UTF-8 consoles.

    Windows gives Python a cp1252 stdout/stderr when it is not a real console
    (CI runners, redirected pipes), and core prints CJK paths such as 记忆遗忘区.
    Without this the encode raises UnicodeEncodeError and the command dies.
    Every CLI module imports common, so the call at the bottom of this file
    covers all of them. Safe on streams that cannot be reconfigured.
    """
    for target in (sys.stdout, sys.stderr) if stream is None else (stream,):
        reconfigure = getattr(target, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError, AttributeError):
            pass  # detached or already-closed stream: leave it as-is


ensure_utf8_console()
