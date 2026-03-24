from __future__ import annotations

import asyncio
import time
import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from . import embedder, indexer, store
from .config import Settings, WatchDir, save_watch_dirs

_settings: Optional[Settings] = None
_change_queue: Optional[asyncio.Queue] = None
_observer = None
_status = "starting"
_start_time = time.monotonic()
_jobs: dict[str, dict[str, Any]] = {}

app = FastAPI(
    title="BoostOS RAG Daemon",
    description="Semantic search over indexed project files",
    version="0.2.0",
)


def configure(settings: Settings, change_queue: asyncio.Queue) -> None:
    global _settings, _change_queue
    _settings = settings
    _change_queue = change_queue


def set_ready() -> None:
    global _status
    _status = "ready"


def set_observer(obs) -> None:
    global _observer
    _observer = obs


# ── Request / Response Models ─────────────────────────────────────────────────

class SearchRequest(BaseModel):
    query: str
    n_results: int = 10
    path_prefix: Optional[str] = None
    min_score: float = 0.3


class SearchResult(BaseModel):
    file_path: str
    chunk_index: int
    start_line: int
    end_line: int
    language: str
    score: float
    content: str


class SearchResponse(BaseModel):
    results: list[SearchResult]
    query: str
    elapsed_ms: int


class IndexRequest(BaseModel):
    path: str
    force: bool = False


class WatchDirIn(BaseModel):
    path: str
    recursive: bool = True


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/status")
def get_status() -> dict[str, Any]:
    watched = [d.path for d in _settings.watch_dirs if d.enabled] if _settings else []
    return {
        "status": _status,
        "version": "0.2.0",
        "total_chunks": store.total_chunks(),
        "watched_dirs": watched,
        "embedding_model": _settings.embedding_model if _settings else "unknown",
        "uptime_seconds": int(time.monotonic() - _start_time),
    }


@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest) -> SearchResponse:
    if _status != "ready":
        raise HTTPException(503, detail="Daemon is still starting, try again shortly")

    t0 = time.monotonic()
    embedding = embedder.embed_one(req.query)
    results = store.query(
        embedding=embedding,
        n_results=req.n_results,
        path_prefix=req.path_prefix,
        min_score=req.min_score,
    )
    elapsed = int((time.monotonic() - t0) * 1000)

    return SearchResponse(
        results=[SearchResult(**r) for r in results],
        query=req.query,
        elapsed_ms=elapsed,
    )


@app.post("/index")
async def trigger_index(req: IndexRequest) -> dict[str, Any]:
    job_id = f"idx-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
    _jobs[job_id] = {"status": "running", "path": req.path}
    asyncio.create_task(_run_index_job(job_id, req.path))
    return {"job_id": job_id, "status": "queued", "path": req.path}


@app.get("/index/status/{job_id}")
def index_job_status(job_id: str) -> dict[str, Any]:
    if job_id not in _jobs:
        raise HTTPException(404, detail="Job not found")
    return _jobs[job_id]


@app.get("/chunks/{file_path:path}")
def get_chunks(file_path: str) -> dict[str, Any]:
    # FastAPI strips the leading slash from path params — restore it
    full = "/" + file_path
    chunks = store.get_file_chunks(full)
    return {"file_path": full, "chunk_count": len(chunks), "chunks": chunks}


@app.get("/watched")
def get_watched() -> dict[str, Any]:
    dirs = []
    if _settings:
        dirs = [
            {"path": d.path, "recursive": d.recursive, "enabled": d.enabled}
            for d in _settings.watch_dirs
        ]
    return {"dirs": dirs}


@app.post("/watched")
async def add_watched(req: WatchDirIn) -> dict[str, Any]:
    if _settings is None:
        raise HTTPException(503, detail="Settings not loaded")

    existing = {d.path for d in _settings.watch_dirs}
    if req.path in existing:
        return {"added": False, "path": req.path, "message": "Already watched"}

    new_dir = WatchDir(path=req.path, recursive=req.recursive)
    _settings.watch_dirs.append(new_dir)
    save_watch_dirs(_settings.watch_config_path, _settings.watch_dirs)

    # Live-add to running observer
    if _observer and _change_queue:
        from . import watcher as watcher_mod
        loop = asyncio.get_event_loop()
        from watchdog.events import FileSystemEventHandler
        handler = watcher_mod._DebounceHandler(_change_queue, loop)
        _observer.schedule(handler, req.path, recursive=req.recursive)

    job_id = f"idx-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
    _jobs[job_id] = {"status": "running", "path": req.path}
    asyncio.create_task(_run_index_job(job_id, req.path))

    return {"added": True, "path": req.path, "index_job_id": job_id}


@app.delete("/watched/{dir_path:path}")
def remove_watched(dir_path: str) -> dict[str, Any]:
    if _settings is None:
        raise HTTPException(503, detail="Settings not loaded")
    full = "/" + dir_path
    before = len(_settings.watch_dirs)
    _settings.watch_dirs = [d for d in _settings.watch_dirs if d.path != full]
    if len(_settings.watch_dirs) == before:
        raise HTTPException(404, detail=f"Not watching: {full}")
    save_watch_dirs(_settings.watch_config_path, _settings.watch_dirs)
    return {"removed": True, "path": full}


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _run_index_job(job_id: str, path: str) -> None:
    try:
        loop = asyncio.get_event_loop()
        files, chunks = await loop.run_in_executor(None, indexer.scan_directory, path)
        _jobs[job_id] = {
            "status": "complete",
            "path": path,
            "files_processed": files,
            "chunks_added": chunks,
        }
    except Exception as exc:
        _jobs[job_id] = {"status": "failed", "path": path, "error": str(exc)}
