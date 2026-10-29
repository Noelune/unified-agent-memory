# -*- coding: utf-8 -*-
"""config_yaml — the one sanctioned home for the optional PyYAML dependency.

driftrc.yaml is the only YAML the project reads, and PyYAML is deliberately
NOT a core dependency (core-only/CI setups have no yaml). This module owns
the optional import once, at module level, behind a try/except — so every
consumer imports a stable name and the "is yaml available?" check is a plain
attribute instead of a scattered lazy import.

If PyYAML is missing, ``AVAILABLE`` is False and ``safe_load`` raises
:class:`YamlUnavailable` (a RuntimeError so callers that catch broad
exceptions still work); ``YAMLError`` is re-exported for `except` clauses so
callers never need to import yaml themselves.
"""
from __future__ import annotations

try:  # optional dependency: PyYAML may not be installed on CI/core-only setups
    import yaml as _yaml
except ModuleNotFoundError:  # pragma: no cover - environment dependent
    _yaml = None

AVAILABLE = _yaml is not None

if _yaml is not None:
    YAMLError = _yaml.YAMLError
else:  # pragma: no cover - only reachable without PyYAML
    class YAMLError(Exception):
        """Placeholder so `except YAMLError` stays importable without PyYAML."""


class YamlUnavailable(RuntimeError):
    """PyYAML is not installed, so YAML content cannot be parsed."""


def require_yaml() -> None:
    """Raise :class:`YamlUnavailable` when PyYAML is missing."""
    if _yaml is None:
        raise YamlUnavailable(
            "PyYAML is not installed — install it (pip install pyyaml) to read "
            "YAML configuration."
        )


def safe_load(text: str):
    """Parse YAML text with the optional dependency, or raise YamlUnavailable."""
    require_yaml()
    try:
        return _yaml.safe_load(text)
    except _yaml.YAMLError as exc:
        raise YAMLError(str(exc)) from exc
