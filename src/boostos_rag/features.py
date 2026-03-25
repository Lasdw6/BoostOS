"""
boostos_rag.features — Feature flag read/write.

Stored as JSON at /var/lib/boostos/features.json so all processes
(daemon, grep wrapper, command wrappers, CLI tools) share one source of truth
with no IPC. File reads are ~0.1ms for this tiny payload.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

_DEFAULT_PATH = os.environ.get(
    "BOOSTOS_FEATURES_FILE", "/var/lib/boostos/features.json"
)

_DESCRIPTIONS: dict[str, str] = {
    "trigram_grep":       "Trigram-accelerated grep (prunes candidate files before real grep)",
    "json_commands":      "JSON-by-default ps/ss/df/free wrappers",
    "api_proxy_tracking": "API proxy records token usage and cost per call",
    "rag_search":         "Semantic search indexing and serving",
    "fuse_overlay":       "FUSE copy-on-write overlay filesystem",
    "agent_registry":     "Agent registration and tool call tracking",
}

_DEFAULTS: dict[str, bool] = {k: True for k in _DESCRIPTIONS}


def _path() -> Path:
    return Path(_DEFAULT_PATH)


def read_features() -> dict[str, bool]:
    """Return current feature flags. Missing keys default to True."""
    try:
        data = json.loads(_path().read_text())
        return {k: bool(data.get(k, True)) for k in _DESCRIPTIONS}
    except Exception:
        return dict(_DEFAULTS)


def get_feature(name: str) -> bool:
    """Return True if feature is enabled (defaults to True if unknown or file missing)."""
    try:
        data = json.loads(_path().read_text())
        return bool(data.get(name, True))
    except Exception:
        return True


def set_feature(name: str, enabled: bool) -> None:
    """Enable or disable a feature flag. Creates file with defaults if missing."""
    p = _path()
    try:
        current = json.loads(p.read_text()) if p.exists() else {}
    except Exception:
        current = {}
    current = {k: bool(current.get(k, True)) for k in _DESCRIPTIONS}
    current[name] = enabled
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(current, indent=2) + "\n")


def all_features() -> list[dict]:
    """Return list of {name, enabled, description} dicts for all features."""
    flags = read_features()
    return [
        {"name": k, "enabled": flags.get(k, True), "description": _DESCRIPTIONS[k]}
        for k in _DESCRIPTIONS
    ]


def write_defaults(path: Optional[str] = None) -> None:
    """Write the default feature flags file (all enabled). Called by provisioning."""
    p = Path(path) if path else _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.write_text(json.dumps(_DEFAULTS, indent=2) + "\n")
