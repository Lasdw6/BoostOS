"""
boostos_rag.proxy — Local API proxy for token counting and cost tracking.

Runs on http://127.0.0.1:7701 as a systemd service.

Configure agents by setting these env vars (done automatically by
boostos-session.sh for every terminal in BoostOS):

    ANTHROPIC_BASE_URL=http://127.0.0.1:7701
    OPENAI_BASE_URL=http://127.0.0.1:7701

All requests are forwarded to the real API over HTTPS. The proxy reads
the `usage` field that every API response already includes, so no
tokenizer is needed — the model reports its own exact token counts.

Streaming responses are passed through line-by-line with no additional
latency. Usage is extracted from the final SSE event before recording.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from typing import AsyncGenerator, Optional

import click
import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse

from . import agent_registry, proxy_db
from .proxy_db import DEFAULT_DB

# Claude Code always sends this exact set of built-in tools.
_CLAUDE_CODE_TOOLS = {"Bash", "Read", "Write", "Edit", "Glob", "Grep"}

# Cursor injects these request headers.
_CURSOR_HEADERS = {"x-cursor-checksum", "x-cursor-client-version", "x-cursor-timezone"}

logger = logging.getLogger("boostos_proxy")

# ── Upstream targets ──────────────────────────────────────────────────────────
_ANTHROPIC = "https://api.anthropic.com"
_OPENAI    = "https://api.openai.com"

# Headers that must not be forwarded (hop-by-hop)
_DROP_HEADERS = frozenset({
    "host", "content-length", "transfer-encoding",
    "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailers", "upgrade",
})

app = FastAPI(docs_url=None, redoc_url=None)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _detect_provider(path: str, headers: dict) -> str:
    """Anthropic uses /v1/messages; everything else goes to OpenAI."""
    if "messages" in path:
        return "anthropic"
    if headers.get("x-api-key"):
        return "anthropic"
    return "openai"


def _upstream(provider: str, path: str, query: str) -> str:
    base = _ANTHROPIC if provider == "anthropic" else _OPENAI
    url = f"{base}/{path}"
    if query:
        url += f"?{query}"
    return url


def _fwd_headers(request: Request) -> dict[str, str]:
    return {
        k: v for k, v in request.headers.items()
        if k.lower() not in _DROP_HEADERS
    }


def _extract_usage_non_stream(provider: str, body: dict) -> tuple[int, int]:
    usage = body.get("usage", {})
    if provider == "anthropic":
        return (
            usage.get("input_tokens", 0),
            usage.get("output_tokens", 0),
        )
    else:
        return (
            usage.get("prompt_tokens", 0),
            usage.get("completion_tokens", 0),
        )


# ── Non-streaming path ────────────────────────────────────────────────────────

async def _forward(
    provider: str,
    model: str,
    url: str,
    body: bytes,
    headers: dict,
    start: float,
    agent_id: Optional[str] = None,
) -> Response:
    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.request(
            method="POST",
            url=url,
            content=body,
            headers=headers,
        )
    duration_ms = int((time.time() - start) * 1000)

    # Extract usage from response if successful
    if resp.status_code == 200:
        try:
            data = resp.json()
            in_tok, out_tok = _extract_usage_non_stream(provider, data)
            if in_tok or out_tok:
                proxy_db.record(provider, model, in_tok, out_tok, duration_ms, agent_id)
        except Exception:
            pass

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=dict(resp.headers),
        media_type=resp.headers.get("content-type", "application/json"),
    )


# ── Streaming path ────────────────────────────────────────────────────────────

async def _stream(
    provider: str,
    model: str,
    url: str,
    body: bytes,
    headers: dict,
    start: float,
    agent_id: Optional[str] = None,
) -> AsyncGenerator[bytes, None]:
    in_tok = out_tok = 0

    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream("POST", url, content=body, headers=headers) as resp:
            async for line in resp.aiter_lines():
                yield (line + "\n").encode()
                # Parse SSE lines for usage (best-effort, never blocks yield)
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                try:
                    data = json.loads(line[6:])
                    if provider == "anthropic":
                        t = data.get("type", "")
                        if t == "message_start":
                            in_tok = data["message"]["usage"].get("input_tokens", 0)
                        elif t == "message_delta":
                            out_tok = data.get("usage", {}).get("output_tokens", 0)
                    else:
                        u = data.get("usage") or {}
                        if u:
                            in_tok  = u.get("prompt_tokens", in_tok)
                            out_tok = u.get("completion_tokens", out_tok)
                except Exception:
                    pass

    if in_tok or out_tok:
        duration_ms = int((time.time() - start) * 1000)
        proxy_db.record(provider, model, in_tok, out_tok, duration_ms, agent_id)


# ── Tool / session detection ──────────────────────────────────────────────────

def _get_system(body: dict) -> str:
    """Extract the system prompt text from a request body."""
    system = body.get("system", "")
    if isinstance(system, list):
        system = " ".join(s.get("text", "") for s in system if isinstance(s, dict))
    if not system:
        for msg in body.get("messages", []):
            if msg.get("role") == "system":
                c = msg.get("content", "")
                system = c if isinstance(c, str) else " ".join(
                    x.get("text", "") for x in c if isinstance(x, dict)
                )
                break
    return system or ""


def _detect_tool(req_headers: dict, body: dict) -> str:
    """Identify the coding tool from request headers and body."""
    # Cursor sends distinctive headers
    if any(h in req_headers for h in _CURSOR_HEADERS):
        return "cursor"
    # Claude Code always sends its full built-in tool set
    tool_names = {t.get("name", "") for t in body.get("tools", []) if isinstance(t, dict)}
    if _CLAUDE_CODE_TOOLS.issubset(tool_names):
        return "claude-code"
    # Fallback: check User-Agent
    ua = req_headers.get("user-agent", "").lower()
    if "cursor" in ua:
        return "cursor"
    if "vscode" in ua or "copilot" in ua:
        return "vscode"
    return "unknown"


def _extract_workspace(body: dict) -> Optional[str]:
    """Extract the working directory from a Claude Code system prompt."""
    system = _get_system(body)
    if not system:
        return None
    # Claude Code embeds cwd in its system prompt in several formats
    for pattern in (
        r"<cwd>(.*?)</cwd>",
        r"Current working directory:\s*(\S+)",
        r"cwd[\"']?\s*[:=]\s*[\"']?(/\S+)",
    ):
        m = re.search(pattern, system, re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return None


def _session_key(body: dict) -> str:
    """Stable 12-char hex key for this conversation, derived from system prompt."""
    system = _get_system(body)
    # Use first 500 chars — stable within a conversation, changes between sessions
    return hashlib.sha1(system[:500].encode()).hexdigest()[:12]


# ── Main route ────────────────────────────────────────────────────────────────

@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def proxy(request: Request, path: str) -> Response:
    headers  = _fwd_headers(request)
    provider = _detect_provider(path, headers)
    url      = _upstream(provider, path, request.url.query)
    body     = await request.body()
    start    = time.time()

    # Agent attribution — explicit header takes priority; otherwise auto-detect
    agent_id: Optional[str] = request.headers.get("x-agent-id") or None

    # Parse body for model name, stream flag, and auto-detection signals
    model     = "unknown"
    is_stream = False
    try:
        parsed = json.loads(body)
        model  = parsed.get("model", "unknown")
        is_stream = bool(parsed.get("stream", False))

        # Auto-detect tool and session from request if no explicit agent ID
        if not agent_id:
            req_headers_lower = {k.lower(): v for k, v in request.headers.items()}
            tool = _detect_tool(req_headers_lower, parsed)
            if tool != "unknown":
                workspace = _extract_workspace(parsed)
                skey = _session_key(parsed)
                try:
                    agent_id = agent_registry.upsert_detected(skey, tool, workspace)
                except Exception:
                    pass

        # Inject stream_options for OpenAI so it includes usage in last chunk
        if is_stream and provider == "openai":
            parsed.setdefault("stream_options", {})["include_usage"] = True
            body = json.dumps(parsed).encode()
    except Exception:
        pass

    if is_stream:
        return StreamingResponse(
            _stream(provider, model, url, body, headers, start, agent_id),
            media_type="text/event-stream",
        )

    return await _forward(provider, model, url, body, headers, start, agent_id)


# ── Entry point ───────────────────────────────────────────────────────────────

@click.command()
@click.option("--host", default="127.0.0.1", show_default=True)
@click.option("--port", default=7701, show_default=True)
@click.option("--db",   default=DEFAULT_DB, show_default=True, help="Usage DB path")
@click.option("--log-level", default="warning", show_default=True)
def main(host: str, port: int, db: str, log_level: str) -> None:
    """BoostOS API proxy — token counting and cost tracking."""
    logging.basicConfig(level=getattr(logging, log_level.upper(), logging.WARNING))
    proxy_db.init(db)
    agent_registry.init()
    logger.info("Proxy starting on %s:%d  db=%s", host, port, db)
    uvicorn.run(app, host=host, port=port, log_level=log_level, access_log=False)
