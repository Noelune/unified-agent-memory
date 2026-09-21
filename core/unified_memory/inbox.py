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
from pathlib import Path

from .common import file_lock
from .preview import INBOX_REL, _safe_inbox_name

DONE_DIR = "已处理"

# Give up rather than loop forever if 已处理/ somehow holds this many variants
# of one name. Matches promoter.archive_sources' own `range(2, 1000)` ceiling.
_MAX_VARIANTS = 1000


def _unique_target(done: str, name: str) -> str:
    """Return a path in ``done`` that does not exist yet — never an occupied one.

    A name collision means the same submission title was used more than once.
    Every one of those files is user data, so all of them are kept: later ones
    get a timestamp suffix.

    The timestamp alone cannot guarantee uniqueness. Two calls in the same
    second produce the *same* stamp, and ``shutil.move`` within one volume is a
    rename that silently clobbers the occupant and still reports success — that
    is exactly how a third same-name dismissal destroyed the second. So probe
    until a free name is found instead of trusting the stamp. Ordinals after the
    stamp (``-2``, ``-3``, like ``promoter.archive_sources``) carry the case
    where even the stamped name is taken.

    ``lexists`` rather than ``exists``: a *dangling* symlink occupies the name
    but ``exists`` follows the link and reports False, which would hand the
    move a name that is already there.
    """
    target = os.path.join(done, name)
    if not os.path.lexists(target):
        return target
    stem, ext = os.path.splitext(name)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for ordinal in range(1, _MAX_VARIANTS):
        suffix = "" if ordinal == 1 else f"-{ordinal}"
        candidate = os.path.join(done, f"{stem}.{stamp}{suffix}{ext}")
        if not os.path.lexists(candidate):
            return candidate
    raise OSError(f"could not allocate a free name in {done!r} for {name!r}")


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
    except OSError as exc:
        return {"ok": False, "name": name, "movedTo": None,
                "reason": f"io-error: {exc}"}
    # The destination gets the same realpath ownership check the source does
    # (mirroring preview.read_inbox_item). Without it a 已处理/ that is a symlink
    # to somewhere else on disk would quietly receive the file, moving data out
    # of the inbox through the write path.
    inbox_real = os.path.realpath(inbox)
    done_real = os.path.realpath(done)
    if os.path.dirname(done_real) != inbox_real:
        return {"ok": False, "name": name, "movedTo": None,
                "reason": "outside-inbox"}

    try:
        # Probe-then-move must be atomic against the promoter, which archives
        # this same directory under the same lock (archive_sources(..., locked=True)).
        with file_lock(Path(vault)):
            target = _unique_target(done, name)
            # ponytail: same-volume move is a rename (atomic, no window). If
            # 已处理/ ever lands on another volume shutil.move degrades to
            # copy+delete and a crash mid-copy leaves a partial copy behind —
            # recoverable by hand, never a silent overwrite. Upgrade path:
            # copy to a temp name in `done`, fsync, then os.replace into place.
            shutil.move(src, target)
    except OSError as exc:
        return {"ok": False, "name": name, "movedTo": None,
                "reason": f"io-error: {exc}"}
    return {"ok": True, "name": name,
            "movedTo": os.path.relpath(target, inbox), "reason": None}
