# -*- coding: utf-8 -*-
"""Vault layout and atomic file primitives (moved verbatim from common.py, B1).

This is the ONLY module allowed to write files inside the vault (atomic_write /
atomic_create; see core/tests/test_architecture.py). ``VaultMissing`` is
defined at its raise site here and re-exported by infra.config so the import
surface named in the batch-B taskbook keeps working.
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path

from ..domain.policy import (
    AGENT_CONTEXT,
    CANONICAL_DOCS,
    FORGET_DIR,
    PROCESSED_DIR,
    SESSION_DIR,
    SITUATION_DIR,
    SUBMISSION_DIR,
    UNCLASSIFIED_FACT_REL,
    VAULT_ENV,
    is_conflict_copy,
)


class VaultMissing(RuntimeError):
    """This machine has no memory vault at the resolved path.

    A subclass rather than a bare RuntimeError so the CLI can turn *exactly*
    this one condition into a one-line error while leaving every other
    RuntimeError a traceback. Ten commands call `ensure_vault` as their first
    step, so a user who follows doctor's own advice on a fresh machine
    (`memory gc --apply`) used to get a stack trace for a state the message
    already knows how to fix in one documented command.
    """


def canonical_dir(vault: Path) -> Path:
    return vault / AGENT_CONTEXT


def canonical_path(vault: Path, doc_id: str) -> Path:
    if doc_id not in CANONICAL_DOCS:
        raise KeyError(
            f"unknown document {doc_id!r} — choose from: {', '.join(CANONICAL_DOCS)}"
        )
    return canonical_dir(vault) / CANONICAL_DOCS[doc_id]


def is_bare_note_name(name: str) -> bool:
    """Return whether ``name`` is one *.md file name, with no path in it.

    This is the traversal gate: a name that carries a directory, a drive letter
    or a parent reference is refused outright rather than resolved and checked
    afterwards, because every caller of this predicate turns the name into a
    path under the canonical directory.
    """
    if not name:
        return False
    if Path(name).name != name or ".." in name:
        return False
    return name.lower().endswith(".md")


def note_named(name: str) -> str:
    """A note name as one ``*.md`` segment, adding the suffix Obsidian omits.

    The vault refers to its own notes by wikilink — ``[[我的偏好摘要]]``, never
    ``[[我的偏好摘要.md]]`` — so the name a person or an agent copies out of the
    context index has no suffix. Refusing it made the one spelling the vault
    itself uses unreachable from `memory show`.

    A suffix is *added*, never stripped: a name that already ends in ``.md`` is
    returned unchanged, so nothing that resolved before resolves differently.
    The traversal gate still runs afterwards (``is_bare_note_name``), and this
    function does not sanitise anything — ``"../x"`` stays ``"../x.md"`` and is
    still refused there.
    """
    base = (name or "").strip()
    if not base:
        return ""
    if base.lower().endswith(".md"):
        return base
    # A name that already carries some *other* extension is not a note name
    # missing its suffix — `notes.txt` stays `notes.txt` and is refused by
    # ``is_bare_note_name``, which is a clearer answer than resolving it to
    # `notes.txt.md` and reporting "no such note".
    if Path(base).suffix:
        return base
    return base + ".md"


def resolve_canonical_note(vault: Path, name: str) -> Path | None:
    """Resolve a note name to a real note under 50-Agent-Context.

    Top-level notes are the normal case. ``情境信息/未归类事实.md`` is also
    indexed (see ``index.indexed_files``), so the exact file name a search hit
    reports has to be readable by name — otherwise that one hit is the single
    row the console can show but cannot open.

    Returns None for a refused or missing name. The input is a single segment
    after ``note_named`` (``is_bare_note_name``), so nothing outside the
    canonical directory can be reached.
    """
    name = note_named(name)
    if not is_bare_note_name(name):
        return None
    ctx = canonical_dir(vault)
    direct = ctx / name
    if direct.is_file():
        return direct
    nested = ctx / UNCLASSIFIED_FACT_REL
    if nested.name == name and nested.is_file():
        return nested
    return None


def submission_dir(vault: Path) -> Path:
    return canonical_dir(vault) / SUBMISSION_DIR


def processed_dir(vault: Path) -> Path:
    return submission_dir(vault) / PROCESSED_DIR


def situation_dir(vault: Path) -> Path:
    return canonical_dir(vault) / SITUATION_DIR


def forget_dir(vault: Path) -> Path:
    return canonical_dir(vault) / FORGET_DIR


def session_dir(vault: Path) -> Path:
    return canonical_dir(vault) / SESSION_DIR


def ensure_vault(vault: Path) -> None:
    if not (vault / AGENT_CONTEXT).is_dir():
        raise VaultMissing(
            f"vault not initialized at {vault} — run \"memory init --vault <path>\" "
            f"(or set {VAULT_ENV})"
        )


def atomic_write(path: Path, text: str) -> None:
    """Write via temp file + rename so concurrent readers never see partial content."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def atomic_create(path: Path, text: str) -> bool:
    """Create ``path`` with complete content, without replacing an existing file.

    A same-directory hard link makes both publication and exclusive creation a
    single filesystem operation.  This lets concurrent submitters retry a new
    file name without exposing a partly-written inbox entry to the promoter.
    On filesystems without hard-link support (FAT32, some network mounts) we
    fall back to O_CREAT|O_EXCL so exclusive creation is still preserved.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with tmp.open("w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(tmp, path)
        except FileExistsError:
            return False
        except OSError:
            # Hard links unsupported here: publish via an exclusive create.
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                return False
            with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
                handle.write(text)
                handle.flush()
        return True
    finally:
        tmp.unlink(missing_ok=True)


def read_maybe(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def indexed_files(vault: Path) -> list[Path]:
    """Canonical .md files that actually hold facts (moved verbatim from
    index.py, B2 — this is vault layout, not storage).

    Top-level notes, plus the one situation note the promoter writes facts
    into. `情境信息/未归类事实.md` used to be excluded by a top-level-only
    glob, so every fact the classifier could not place was written, stamped
    and locked — and then permanently invisible to search. The rest of
    情境信息/ is workflow state (待晋升 / 冲突 / 已裁决) and 已处理/ is the
    inbox archive; indexing those would surface duplicates and stale rows.

    Sync-client conflict copies (``note 2.md``, ``note-副本.md`` …) are skipped:
    they are an unresolved duplicate of a note, not another source of truth.
    """
    ctx = canonical_dir(vault)
    if not ctx.is_dir():
        return []
    files = [
        p
        for p in sorted(ctx.glob("*.md"))
        if p.is_file() and not is_conflict_copy(p.name)
    ]
    unclassified = ctx / UNCLASSIFIED_FACT_REL
    if unclassified.is_file() and not is_conflict_copy(unclassified.name):
        files.append(unclassified)
    return files
