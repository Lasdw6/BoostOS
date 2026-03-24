from __future__ import annotations

import configparser
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

DEFAULT_HTTP_HOST = "127.0.0.1"
DEFAULT_HTTP_PORT = 7700
DEFAULT_CHROMA_PATH = "/var/lib/boostos/rag/chroma"
DEFAULT_MODELS_PATH = "/var/lib/boostos/rag/models"
DEFAULT_TRIGRAM_DB = "/var/lib/boostos/rag/trigram.db"
DEFAULT_WATCH_CONFIG = "/var/lib/boostos/rag/config.json"
DEFAULT_EMBEDDING_MODEL = "all-MiniLM-L6-v2"
DEFAULT_LOG_LEVEL = "INFO"


@dataclass
class WatchDir:
    path: str
    recursive: bool = True
    enabled: bool = True


@dataclass
class Settings:
    http_host: str = DEFAULT_HTTP_HOST
    http_port: int = DEFAULT_HTTP_PORT
    chroma_path: str = DEFAULT_CHROMA_PATH
    models_path: str = DEFAULT_MODELS_PATH
    trigram_db_path: str = DEFAULT_TRIGRAM_DB
    watch_config_path: str = DEFAULT_WATCH_CONFIG
    embedding_model: str = DEFAULT_EMBEDDING_MODEL
    log_level: str = DEFAULT_LOG_LEVEL
    watch_dirs: list[WatchDir] = field(default_factory=list)


def load_settings(config_path: Optional[str] = None) -> Settings:
    s = Settings()

    if config_path and Path(config_path).exists():
        cp = configparser.ConfigParser()
        cp.read(config_path)
        sec = cp["daemon"] if "daemon" in cp else {}
        s.http_host = sec.get("http_host", DEFAULT_HTTP_HOST)
        s.http_port = int(sec.get("http_port", str(DEFAULT_HTTP_PORT)))
        s.chroma_path = sec.get("chroma_path", DEFAULT_CHROMA_PATH)
        s.models_path = sec.get("models_path", DEFAULT_MODELS_PATH)
        s.trigram_db_path = sec.get("trigram_db_path", DEFAULT_TRIGRAM_DB)
        s.watch_config_path = sec.get("watch_config_path", DEFAULT_WATCH_CONFIG)
        s.embedding_model = sec.get("embedding_model", DEFAULT_EMBEDDING_MODEL)
        s.log_level = sec.get("log_level", DEFAULT_LOG_LEVEL)

    s.watch_dirs = load_watch_dirs(s.watch_config_path)
    return s


def load_watch_dirs(config_path: str) -> list[WatchDir]:
    p = Path(config_path)
    if not p.exists():
        return _default_watch_dirs()
    try:
        data = json.loads(p.read_text())
        return [
            WatchDir(
                path=d["path"],
                recursive=d.get("recursive", True),
                enabled=d.get("enabled", True),
            )
            for d in data.get("dirs", [])
        ]
    except Exception:
        return _default_watch_dirs()


def save_watch_dirs(config_path: str, dirs: list[WatchDir]) -> None:
    p = Path(config_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "version": 1,
        "dirs": [
            {"path": d.path, "recursive": d.recursive, "enabled": d.enabled}
            for d in dirs
        ],
    }
    p.write_text(json.dumps(data, indent=2) + "\n")


def _default_watch_dirs() -> list[WatchDir]:
    home = Path.home()
    projects = home / "projects"
    watch = projects if projects.is_dir() else home
    return [WatchDir(path=str(watch))]
