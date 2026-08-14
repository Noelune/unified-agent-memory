# -*- coding: utf-8 -*-
"""Shared helpers for core tests: scratch vaults under a temp dir.

The real ~/.unified-memory.yaml and index.db are NEVER touched: both the
config path and the index path are redirected into the scratch dir.
"""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unified_memory import memory as mem_mod
from unified_memory import common


def make_scratch_vault() -> Path:
    root = Path(tempfile.mkdtemp(prefix="um-test-"))
    vault = root / "vault"
    # Redirect config + index away from the real home directory.
    common.CONFIG_PATH = root / "config.yaml"
    mem_mod.CONFIG_PATH = common.CONFIG_PATH
    mem_mod.INDEX_DB = root / "index.db"
    os.environ["UNIFIED_MEMORY_VAULT"] = str(vault)
    mem_mod.init_vault(vault)
    return vault


def destroy_scratch(vault: Path) -> None:
    shutil.rmtree(vault.parent, ignore_errors=True)
    os.environ.pop("UNIFIED_MEMORY_VAULT", None)
