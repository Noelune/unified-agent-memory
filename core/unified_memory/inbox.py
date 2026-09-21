"""The one write path in this project: retire a submission from the inbox.

Deliberately narrow. It moves a file from `Agent提交区/` into
`Agent提交区/已处理/`. It never deletes, never edits, and never reaches
into the canonical share — that area is maintained by the promoter and is
read-only for every other writer.
"""
from __future__ import annotations

import os
import shutil
import time
from datetime import datetime

from .preview import INBOX_REL, _safe_inbox_name

DONE_DIR = "已处理"


def _unique_target(done: str, name: str) -> str:
    """Never overwrite an already-processed item.

    A name collision means the same submission title was used twice. Both are
    user data, so keep both: suffix the later one with a timestamp rather
    than letting the move silently clobber the earlier.
    """
    target = os.path.join(done, name)
    if not os.path.exists(target):
        return target
    stem, ext = os.path.splitext(name)
    stamp = datetime.fromtimestamp(time.time()).strftime("%Y%m%d-%H%M%S")
    return os.path.join(done, f"{stem}.{stamp}{ext}")


def process_inbox_item(vault: str, name: str) -> dict:
    """Move one inbox item into 已处理/. Reports why when it cannot."""
    if not _safe_inbox_name(name):
        return {"ok": False, "name": name, "movedTo": None,
                "reason": "invalid-name"}
    inbox = os.path.join(vault, INBOX_REL)
    src = os.path.join(inbox, name)
    if os.path.realpath(os.path.dirname(src)) != os.path.realpath(inbox):
        return {"ok": False, "name": name, "movedTo": None,
                "reason": "outside-inbox"}
    if not os.path.isfile(src):
        return {"ok": False, "name": name, "movedTo": None,
                "reason": "not-found"}

    done = os.path.join(inbox, DONE_DIR)
    try:
        os.makedirs(done, exist_ok=True)
        target = _unique_target(done, name)
        shutil.move(src, target)
    except OSError as exc:
        return {"ok": False, "name": name, "movedTo": None,
                "reason": f"io-error: {exc}"}
    return {"ok": True, "name": name,
            "movedTo": os.path.relpath(target, inbox), "reason": None}
