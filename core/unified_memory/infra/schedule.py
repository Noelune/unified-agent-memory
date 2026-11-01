# -*- coding: utf-8 -*-
"""Lifecycle schedule state + OS job registration (moved from common.py, B1;
job registration generalised in B5.4).

Schedule state for missed-run catch-up (catchup.py). Every successful
lifecycle run stamps its date here, no matter which entry point fired it
(OS cron .bat/crontab, dsh plugin catch-up, manual `--apply`). The file
lives inside the vault so a synced fleet shares it: when one machine's cron
already promoted today, another machine's catch-up sees the stamp and stays
idle instead of promoting a second time.

`register_job` is the ONLY place in the package that shells out or writes an
executable script: `promoter --cron` and `forgetter --cron` are thin callers
that hand it a `JobSpec`. Keeping the schtasks/crontab dialogue here means the
business modules never touch subprocess, and the two jobs cannot drift apart
in quoting, PYTHONPATH or idempotency.
"""
from __future__ import annotations

import json
import platform
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
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


# ---------------------------------------------------------------------------
# OS job registration (B5.4: was a copy per job in promoter and forgetter)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class JobSpec:
    """Everything one lifecycle job needs to be scheduled — data, no behaviour.

    The caller (promoter/forgetter) knows its module, flags and where its
    script belongs; this module knows how Windows Task Scheduler and crontab
    want that written. Splitting it this way is what removed the duplicated
    quoting/PYTHONPATH/idempotency logic from the two callers.
    """

    job: str                     # "promote" — how the job is named in prose
    module: str                  # "-m" target, and the crontab dedupe marker
    flags: tuple[str, ...]       # flags placed before --vault
    script_dir: Path             # where the Windows .bat lands
    script_name: str             # "promote_daily.bat"
    log_name: str                # redirect target, relative to the vault
    windows_task: str            # Task Scheduler name
    windows_when: tuple[str, ...]  # extra schtasks args: ("DAILY", "/ST", "03:00")
    cron_expr: str               # "0 3 * * *"
    banner: str                  # comment line written above the cron entry
    windows_desc: str            # "daily promotion at 03:00"
    posix_desc: str              # "daily promotion at 03:00"


def shlex_quote(value: str | Path) -> str:
    """POSIX shell quoting for one path or argument."""
    return shlex.quote(str(value))


def _windows_script_text(spec: JobSpec, vault: Path, core: Path | None) -> str:
    """The .bat body, with a BOM so cmd.exe/PowerShell 5.1 read non-ASCII paths."""
    pyline = f"set \"PYTHONPATH={core};%PYTHONPATH%\"\r\n" if core else ""
    flags = " ".join(spec.flags)
    command = f'"{Path(sys.executable).resolve()}" -m {spec.module} {flags} --vault "{vault}"'
    return (
        "\ufeff"
        "@echo off\r\n"
        "chcp 65001 >nul\r\n"
        f"{pyline}"
        f'{command} >> "{vault / spec.log_name}" 2>&1\r\n'
        "exit /b %errorlevel%\r\n"
    )


def _register_windows(spec: JobSpec, vault: Path) -> None:
    bat = spec.script_dir / spec.script_name
    # atomic_write with newline="" keeps the CRLF body byte-exact and gives the
    # BOM for free (U+FEFF encodes to EF BB BF), so no raw file handle is
    # needed here — see the write boundary in tests/test_architecture.py.
    atomic_write(bat, _windows_script_text(spec, vault, core_source_dir()))
    subprocess.run(
        ["schtasks", "/Create", "/TN", spec.windows_task, "/TR", f'"{bat}"', *spec.windows_when, "/F"],
        check=False,
    )
    print(f"scheduled {spec.windows_desc} via Windows Task Scheduler ({spec.windows_task})")
    print(f"script: {bat}")


def _register_posix(spec: JobSpec, vault: Path) -> None:
    core = core_source_dir()
    prefix = f"PYTHONPATH={shlex_quote(core)} " if core else ""
    flags = " ".join(spec.flags)
    line = (
        f"{spec.cron_expr} {prefix}{Path(sys.executable).resolve()} -m {spec.module} {flags} "
        f"--vault {shlex_quote(vault)} >> {shlex_quote(vault / spec.log_name)} 2>&1"
    )
    crontab_path = Path.home() / ".crontab"
    existing = read_maybe(crontab_path)
    if spec.module in existing:
        print("cron entry already present — nothing changed")
        return
    atomic_write(crontab_path, existing + "\n".join([spec.banner, line, ""]))
    subprocess.run(["crontab", str(crontab_path)], check=False)
    print(f"scheduled {spec.posix_desc} via crontab")
    print(f"entries written to {crontab_path}")


def register_job(spec: JobSpec, vault: Path) -> None:
    """Install a daily/weekly lifecycle job, idempotently, on either platform."""
    if platform.system() == "Windows":
        _register_windows(spec, vault)
    else:
        _register_posix(spec, vault)


def run_command(
    args: list[str], *, cwd: Path | None = None, timeout: float = 30.0
) -> subprocess.CompletedProcess | None:
    """Run one external command; None when it could not be started at all.

    The package's single process boundary: cron registration and drift's git
    probe both come through here, so ``import subprocess`` appears in exactly
    one module (tests/test_architecture.py enforces it). A missing binary or a
    timeout is a normal condition for both callers — they degrade instead of
    crashing — hence None rather than a raise.
    """
    try:
        return subprocess.run(
            args,
            capture_output=True,
            text=True,
            errors="replace",
            cwd=cwd,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None


