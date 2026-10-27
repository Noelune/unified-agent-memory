# -*- coding: utf-8 -*-
"""Lifecycle schedule state + cron-registration helpers (moved from common.py, B1).

Schedule state for missed-run catch-up (catchup.py). Every successful
lifecycle run stamps its date here, no matter which entry point fired it
(OS cron .bat/crontab, dsh plugin catch-up, manual `--apply`). The file
lives inside the vault so a synced fleet shares it: when one machine's cron
already promoted today, another machine's catch-up sees the stamp and stays
idle instead of promoting a second time.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from .vault import atomic_write, canonical_dir, read_maybe

SCHEDULE_STATE_FILE = "调度状态.json"


def schedule_state_path(vault: Path) -> Path:
    return canonical_dir(vault) / SCHEDULE_STATE_FILE


def core_source_dir() -> Path | None:
    """The repo's ``core/`` directory when running from a source checkout.

    Installed (site-packages) layouts have no ``unified_memory/`` package
    inside the parent directory, so they yield None. A source checkout yields
    the ``core/`` directory itself, which ``register_cron`` bakes into the
    generated schedule scripts — otherwise a task registered with an
    interpreter that never pip-installed the core fails silently at 03:00.

    (B1: this file sits one directory deeper than common.py did, so the
    parents index moved from 1 to 2; the returned path is unchanged.)
    """
    core = Path(__file__).resolve().parents[2]
    return core if (core / "unified_memory").is_dir() else None


def read_schedule_state(vault: Path) -> dict:
    """Last-run dates as ``{"last_promote": "YYYY-MM-DD", ...}``; tolerant of a missing or corrupt file."""
    try:
        data = json.loads(read_maybe(schedule_state_path(vault)) or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def mark_schedule_run(vault: Path, job: str, day: str | None = None) -> None:
    """Record that lifecycle ``job`` ("promote"/"forget") ran on ``day`` (default: today)."""
    state = read_schedule_state(vault)
    state[f"last_{job}"] = day or time.strftime("%Y-%m-%d")
    atomic_write(schedule_state_path(vault), json.dumps(state, ensure_ascii=False, indent=2) + "\n")
