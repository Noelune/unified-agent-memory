# -*- coding: utf-8 -*-
"""infra.hookstate — the hook runtime's state directory (queue + markers).

Single owner of the path rule: env ``UNIFIED_MEMORY_HOOK_STATE`` overrides,
default ``~/.unified-memory/hooks`` — the same namespace as the existing
``~/.unified-memory.yaml``. The hook runtime (integrations/hooks/memory_hook.py)
imports this module for the WRITER side, and ``digest --queue`` (E3) reads the
same queue through it, so the writer and the drain can never drift.
"""
from __future__ import annotations

import os
from pathlib import Path

STATE_ENV = "UNIFIED_MEMORY_HOOK_STATE"

QUEUE_NAME = "queue.jsonl"
DONE_NAME = "queue.done"


def state_dir() -> Path:
    """Hook state dir: env override, else ~/.unified-memory/hooks."""
    override = os.environ.get(STATE_ENV, "")
    return Path(override) if override else Path.home() / ".unified-memory" / "hooks"


def queue_path() -> Path:
    return state_dir() / QUEUE_NAME


def done_path() -> Path:
    return state_dir() / DONE_NAME
