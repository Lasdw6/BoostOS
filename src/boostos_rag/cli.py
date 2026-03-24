from __future__ import annotations

import json
import os
import sys
from typing import Optional

import click
import httpx

DEFAULT_URL = os.environ.get("BOOSTOS_RAG_URL", "http://127.0.0.1:7700")
TIMEOUT = 30.0


def _not_running(url: str) -> None:
    click.echo(f"Cannot connect to RAG daemon at {url}.", err=True)
    click.echo("Start it with:  systemctl start boostos-rag", err=True)
    click.echo("Check logs with: journalctl -u boostos-rag -n 50", err=True)
    sys.exit(1)


def _get(url: str, path: str) -> dict:
    try:
        with httpx.Client(base_url=url, timeout=TIMEOUT) as c:
            r = c.get(path)
            r.raise_for_status()
            return r.json()
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.TimeoutException):
        _not_running(url)


def _post(url: str, path: str, payload: dict) -> dict:
    try:
        with httpx.Client(base_url=url, timeout=TIMEOUT) as c:
            r = c.post(path, json=payload)
            r.raise_for_status()
            return r.json()
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.TimeoutException):
        _not_running(url)
    except httpx.HTTPStatusError as e:
        click.echo(f"Error {e.response.status_code}: {e.response.text}", err=True)
        sys.exit(1)


# ── boostos-search ────────────────────────────────────────────────────────────

@click.command("boostos-search")
@click.argument("query")
@click.option("-n", "--results", default=10, help="Number of results (default 10)")
@click.option("-p", "--project", default=None, metavar="PATH", help="Restrict to path prefix")
@click.option("-s", "--min-score", default=0.3, type=float, help="Min similarity 0–1 (default 0.3)")
@click.option("--json", "as_json", is_flag=True, help="Output raw JSON")
@click.option("--url", default=DEFAULT_URL, help="Daemon URL")
def search_cmd(
    query: str,
    results: int,
    project: Optional[str],
    min_score: float,
    as_json: bool,
    url: str,
) -> None:
    """Semantic search across indexed project files."""
    payload: dict = {"query": query, "n_results": results, "min_score": min_score}
    if project:
        payload["path_prefix"] = project

    data = _post(url, "/search", payload)

    if as_json:
        click.echo(json.dumps(data, indent=2))
        return

    hits = data["results"]
    if not hits:
        click.echo("No results found.")
        return

    click.echo(f"\n{len(hits)} result(s) for {query!r}  ({data['elapsed_ms']}ms)\n")
    for hit in hits:
        bar = "█" * int(hit["score"] * 10)
        path_str = hit["file_path"]
        lines = f":{hit['start_line']}-{hit['end_line']}"
        click.echo(f"  {hit['score']:.3f} {bar:<10}  {path_str}{lines}")
        preview = hit["content"].strip()[:100].replace("\n", " ")
        click.echo(f"             {preview}")
        click.echo()


# ── boostos-rag management ────────────────────────────────────────────────────

@click.group("boostos-rag")
@click.option("--url", default=DEFAULT_URL, envvar="BOOSTOS_RAG_URL", help="Daemon URL")
@click.pass_context
def rag_cmd(ctx: click.Context, url: str) -> None:
    """Manage the BoostOS RAG daemon."""
    ctx.ensure_object(dict)
    ctx.obj["url"] = url


@rag_cmd.command("status")
@click.pass_context
def rag_status(ctx: click.Context) -> None:
    """Show daemon health and index statistics."""
    d = _get(ctx.obj["url"], "/status")
    click.echo(f"Status:          {d['status']}")
    click.echo(f"Version:         {d['version']}")
    click.echo(f"Indexed chunks:  {d['total_chunks']:,}")
    click.echo(f"Embedding model: {d['embedding_model']}")
    click.echo(f"Uptime:          {d['uptime_seconds']}s")
    click.echo(f"Watched dirs ({len(d['watched_dirs'])}):")
    for p in d["watched_dirs"]:
        click.echo(f"  {p}")


@rag_cmd.group("watch")
def rag_watch() -> None:
    """Manage watched directories."""


@rag_watch.command("list")
@click.pass_context
def watch_list(ctx: click.Context) -> None:
    """List watched directories."""
    data = _get(ctx.obj["url"], "/watched")
    for d in data["dirs"]:
        flag = "✓" if d["enabled"] else "✗"
        click.echo(f"  {flag}  {d['path']}  (recursive={d['recursive']})")


@rag_watch.command("add")
@click.argument("path")
@click.option("--no-recursive", is_flag=True)
@click.pass_context
def watch_add(ctx: click.Context, path: str, no_recursive: bool) -> None:
    """Add a directory to the watch list and trigger initial indexing."""
    d = _post(ctx.obj["url"], "/watched", {"path": path, "recursive": not no_recursive})
    if d.get("added"):
        click.echo(f"Added {path}. Indexing job: {d.get('index_job_id', '?')}")
    else:
        click.echo(d.get("message", "Already watched"))


@rag_watch.command("remove")
@click.argument("path")
@click.pass_context
def watch_remove(ctx: click.Context, path: str) -> None:
    """Remove a directory and purge its index entries."""
    try:
        with httpx.Client(base_url=ctx.obj["url"], timeout=TIMEOUT) as c:
            r = c.delete(f"/watched/{path.lstrip('/')}")
            r.raise_for_status()
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.TimeoutException):
        _not_running(ctx.obj["url"])
    click.echo(f"Removed {path}")


@rag_cmd.command("index")
@click.argument("path")
@click.option("--force", is_flag=True, help="Re-index even unchanged files")
@click.pass_context
def rag_index(ctx: click.Context, path: str, force: bool) -> None:
    """Trigger re-indexing of a path."""
    d = _post(ctx.obj["url"], "/index", {"path": path, "force": force})
    click.echo(f"Queued job {d['job_id']} for {path}")


@rag_cmd.command("chunks")
@click.argument("file_path")
@click.pass_context
def rag_chunks(ctx: click.Context, file_path: str) -> None:
    """Show how a file was chunked in the index."""
    d = _get(ctx.obj["url"], f"/chunks/{file_path.lstrip('/')}")
    click.echo(f"{d['file_path']}: {d['chunk_count']} chunk(s)")
    for ch in d["chunks"]:
        click.echo(f"  [{ch['chunk_index']}] lines {ch['start_line']}-{ch['end_line']}")
        click.echo(f"       {ch['content_preview'][:80]}")
