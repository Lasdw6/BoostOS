from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Optional

from . import chunker, embedder, store, trigram

logger = logging.getLogger(__name__)

SKIP_DIRS = frozenset({
    ".git", "node_modules", "__pycache__", ".venv", "venv", "env",
    ".tox", ".pytest_cache", "dist", "build", ".cache", ".next",
    ".nuxt", "target", "vendor", ".terraform", "coverage",
    ".nyc_output", "out", ".output", "tmp", ".tmp",
    ".mypy_cache", ".ruff_cache", ".eggs", "htmlcov", ".idea", ".vscode",
})

SKIP_EXTENSIONS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
    ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
    ".exe", ".dll", ".so", ".dylib", ".wasm",
    ".pyc", ".pyo", ".class", ".o", ".a", ".lib", ".pdb",
    ".db", ".sqlite", ".sqlite3",
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    ".mp3", ".mp4", ".avi", ".mov", ".wav", ".ogg",
    ".svg",
})

SKIP_FILENAMES = frozenset({
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "Cargo.lock", "poetry.lock", "Pipfile.lock", "composer.lock",
    "Gemfile.lock", ".DS_Store", "Thumbs.db",
})

MAX_FILE_BYTES = 512 * 1024  # 512 KB


def should_skip(path: str) -> bool:
    p = Path(path)
    if p.name in SKIP_FILENAMES:
        return True
    if p.suffix.lower() in SKIP_EXTENSIONS:
        return True
    if p.name.endswith(".min.js") or p.name.endswith(".min.css"):
        return True
    for part in p.parts:
        if part in SKIP_DIRS:
            return True
    return False


def _read_file(path: str) -> Optional[str]:
    p = Path(path)
    if not p.is_file():
        return None
    try:
        if p.stat().st_size > MAX_FILE_BYTES:
            return None
    except OSError:
        return None
    try:
        return p.read_text(encoding="utf-8")
    except (UnicodeDecodeError, PermissionError, OSError):
        return None


def index_file(path: str) -> int:
    """Index a single file. Returns number of chunks stored."""
    if should_skip(path):
        return 0
    text = _read_file(path)
    if text is None:
        return 0

    store.delete_file(path)
    trigram.delete_file(path)
    chunks = chunker.chunk_file(path, text)
    if not chunks:
        return 0

    embeddings = embedder.embed([c.content for c in chunks])
    for chunk, emb in zip(chunks, embeddings):
        store.upsert(
            file_path=chunk.file_path,
            chunk_index=chunk.chunk_index,
            embedding=emb,
            content=chunk.content,
            start_line=chunk.start_line,
            end_line=chunk.end_line,
            language=chunk.language,
        )
    trigram.index_file(path, text)  # no-op if not initialised; exceptions suppressed inside
    return len(chunks)


def scan_directory(root: str) -> tuple[int, int]:
    """Full recursive scan of root. Returns (files_indexed, total_chunks)."""
    files = 0
    chunks = 0
    for p in Path(root).rglob("*"):
        if p.is_file():
            n = index_file(str(p))
            if n > 0:
                files += 1
                chunks += n
    try:
        trigram.mark_scan_complete(root)
    except Exception:
        pass
    return files, chunks


async def run_indexer_worker(queue: asyncio.Queue) -> None:
    """Background asyncio task: drain change queue and re-index files."""
    while True:
        try:
            event_type, path = await queue.get()
        except asyncio.CancelledError:
            break
        try:
            if event_type == "deleted":
                removed = store.delete_file(path)
                trigram.delete_file(path)
                if removed:
                    logger.debug("Purged %d chunks for deleted: %s", removed, path)
            else:
                n = index_file(path)
                if n > 0:
                    logger.debug("Re-indexed %d chunks: %s", n, path)
        except Exception as exc:
            logger.warning("Index error for %s: %s", path, exc)
        finally:
            queue.task_done()
