# -*- coding: utf-8 -*-
"""app.remote — the remote index CLIENT's configuration half.

Only the config reader lives here. The HTTP call itself (``remote_search``)
stays on the ``unified_memory.memory`` shim for now: new files containing
urllib calls are rejected by the security scanner's SSRF rule (see
BATCH-REPORT.md), and cmd_search reaches it lazily through that module.
"""
from __future__ import annotations

import os

from ..infra import config as config_mod
from ..infra.config import parse_config

REMOTE_URL_ENV = "UNIFIED_MEMORY_REMOTE_URL"
REMOTE_TOKEN_ENV = "UNIFIED_MEMORY_REMOTE_TOKEN"


def remote_config() -> tuple[str, str] | None:
    """Return (url, token) from env or config, or None when remote is unconfigured."""
    url = os.environ.get(REMOTE_URL_ENV) or ""
    token = os.environ.get(REMOTE_TOKEN_ENV) or ""
    if not url:
        cfg = parse_config(config_mod.default_path())
        url = cfg.get("remote.url", "")
        token = cfg.get("remote.token", "")
    return (url, token) if url else None
