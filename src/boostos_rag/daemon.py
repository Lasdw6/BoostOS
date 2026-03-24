from __future__ import annotations

import asyncio
import logging
import os
import signal
import socket
import time
from pathlib import Path

import click
import uvicorn

from . import api, embedder, indexer, store, trigram
from . import watcher as watcher_mod
from .config import load_settings

logger = logging.getLogger("boostos_rag")


def _setup_logging(level: str) -> None:
    logging.basicConfig(
        format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
        datefmt="%H:%M:%S",
        level=getattr(logging, level.upper(), logging.INFO),
    )


def _sd_notify(state: str) -> None:
    sock_path = os.environ.get("NOTIFY_SOCKET")
    if not sock_path:
        return
    addr = sock_path.lstrip("@")
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as s:
        try:
            s.connect(addr)
            s.sendall(state.encode())
        except OSError:
            pass


@click.command()
@click.option(
    "--config",
    "config_path",
    default="/etc/boostos/rag.conf",
    help="Path to rag.conf",
    show_default=True,
)
def main(config_path: str) -> None:
    """BoostOS RAG daemon — file watcher + indexer + search API."""
    settings = load_settings(config_path)
    _setup_logging(settings.log_level)

    logger.info("BoostOS RAG daemon starting (v0.2.0)")
    logger.info("Chroma path:     %s", settings.chroma_path)
    logger.info("Models path:     %s", settings.models_path)
    logger.info("Embedding model: %s", settings.embedding_model)
    logger.info("HTTP:            %s:%d", settings.http_host, settings.http_port)

    store.init(settings.chroma_path)
    trigram.init(settings.trigram_db_path)
    logger.info("Trigram DB:      %s", settings.trigram_db_path)

    logger.info("Loading embedding model…")
    t0 = time.monotonic()
    embedder.load_model(settings.embedding_model, cache_folder=settings.models_path)
    logger.info("Model loaded in %.1fs", time.monotonic() - t0)

    enabled_dirs = [d.path for d in settings.watch_dirs if d.enabled]
    if enabled_dirs:
        logger.info("Initial scan of %d dir(s)…", len(enabled_dirs))
        t0 = time.monotonic()
        total_f = total_c = 0
        for d in enabled_dirs:
            if Path(d).is_dir():
                f, c = indexer.scan_directory(d)
                total_f += f
                total_c += c
                logger.info("  %-50s  %d files  %d chunks", d, f, c)
            else:
                logger.warning("Watch dir not found, skipping: %s", d)
        logger.info(
            "Scan complete: %d files, %d chunks in %.1fs",
            total_f, total_c, time.monotonic() - t0,
        )
    else:
        logger.warning("No watch directories configured — add one with: boostos-rag watch add <path>")

    asyncio.run(_async_main(settings))


async def _async_main(settings) -> None:
    loop = asyncio.get_event_loop()
    change_queue: asyncio.Queue = asyncio.Queue(maxsize=2000)

    api.configure(settings, change_queue)

    enabled_dirs = [d.path for d in settings.watch_dirs if d.enabled]
    obs = watcher_mod.start_watcher(enabled_dirs, change_queue, loop)
    api.set_observer(obs)

    indexer_task = asyncio.create_task(indexer.run_indexer_worker(change_queue))

    api.set_ready()
    _sd_notify("READY=1")
    logger.info(
        "Daemon ready — http://%s:%d",
        settings.http_host,
        settings.http_port,
    )

    config = uvicorn.Config(
        app=api.app,
        host=settings.http_host,
        port=settings.http_port,
        log_level=settings.log_level.lower(),
        access_log=False,
    )
    server = uvicorn.Server(config)

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(
            sig,
            lambda: asyncio.create_task(_shutdown(server, obs, indexer_task)),
        )

    await server.serve()


async def _shutdown(server, observer, indexer_task: asyncio.Task) -> None:
    logger.info("Graceful shutdown…")
    observer.stop()
    observer.join(timeout=5)
    indexer_task.cancel()
    server.should_exit = True


if __name__ == "__main__":
    main()
