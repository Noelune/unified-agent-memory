# -*- coding: utf-8 -*-
"""Shim — the config writer moved to infra.config in B1; no logic here.

Kept for exactly one minor release (batch-B taskbook §0.7): setup/, the
integrations and the tests import ``unified_memory.config``. New code imports
``unified_memory.infra.config`` directly.
"""
from .infra.config import (
    CONFIG_PATH,
    DEFAULT_VAULT,
    LOCK_POLL_S,
    LOCK_TIMEOUT_S,
    VaultMissing,
    default_path,
    get,
    parse_config,
    resolve_vault,
    set_key,
    set_keys,
    set_value,
    unset_key,
)
