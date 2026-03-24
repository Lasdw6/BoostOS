from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

logger = logging.getLogger(__name__)

DEBOUNCE_SECONDS = 2.0


class _DebounceHandler(FileSystemEventHandler):
    def __init__(self, queue: asyncio.Queue, loop: asyncio.AbstractEventLoop) -> None:
        super().__init__()
        self._queue = queue
        self._loop = loop
        # path -> (event_type, last_seen_time)
        self._pending: dict[str, tuple[str, float]] = {}

    def _enqueue(self, event_type: str, path: str) -> None:
        now = time.monotonic()
        prev = self._pending.get(path)
        if prev and (now - prev[1]) < DEBOUNCE_SECONDS:
            self._pending[path] = (event_type, now)
            return
        self._pending[path] = (event_type, now)
        try:
            self._loop.call_soon_threadsafe(self._queue.put_nowait, (event_type, path))
        except asyncio.QueueFull:
            logger.warning("Watcher queue full, dropping event for %s", path)

    def on_created(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._enqueue("created", str(event.src_path))

    def on_modified(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._enqueue("modified", str(event.src_path))

    def on_deleted(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._enqueue("deleted", str(event.src_path))

    def on_moved(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._enqueue("deleted", str(event.src_path))
            self._enqueue("created", str(event.dest_path))


def start_watcher(
    dirs: list[str],
    queue: asyncio.Queue,
    loop: asyncio.AbstractEventLoop,
) -> Observer:
    observer = Observer()
    handler = _DebounceHandler(queue, loop)
    for d in dirs:
        if Path(d).is_dir():
            observer.schedule(handler, d, recursive=True)
            logger.info("Watching %s (recursive)", d)
        else:
            logger.warning("Watch dir not found, skipping: %s", d)
    observer.start()
    return observer
