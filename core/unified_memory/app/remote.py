# -*- coding: utf-8 -*-
"""app.remote — the remote index client (config + HTTP call).

The config reader and ``remote_search`` both live here (batch D5: the HTTP
call moved off the ``unified_memory.memory`` shim once the scanner's SSRF
rule no longer blocked urllib files).
"""
from __future__ import annotations

import json
import os
import urllib.request

from ..infra import config as config_mod
from ..infra.config import parse_config

REMOTE_URL_ENV = "UNIFIED_MEMORY_REMOTE_URL"
REMOTE_TOKEN_ENV = "UNIFIED_MEMORY_REMOTE_TOKEN"
REMOTE_TIMEOUT = 10


def remote_config() -> tuple[str, str] | None:
    """Return (url, token) from env or config, or None when remote is unconfigured."""
    url = os.environ.get(REMOTE_URL_ENV) or ""
    token = os.environ.get(REMOTE_TOKEN_ENV) or ""
    if not url:
        cfg = parse_config(config_mod.default_path())
        url = cfg.get("remote.url", "")
        token = cfg.get("remote.token", "")
    return (url, token) if url else None


def remote_search(url: str, token: str, query: str, limit: int) -> list[dict]:
    """POST one query to the remote index server and return its results.

    Moved verbatim from the memory shim (batch D5); the imports are
    module-level so the architecture test's lazy-import rule stays clean.
    """
    body = json.dumps({"query": query, "limit": limit}).encode("utf-8")
    req = urllib.request.Request(
        url.rstrip("/") + "/search",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
    )
    with urllib.request.urlopen(req, timeout=REMOTE_TIMEOUT) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "remote returned ok=false"))
    return data.get("results", [])
