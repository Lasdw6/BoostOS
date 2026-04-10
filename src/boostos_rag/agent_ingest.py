"""
boostos_rag.agent_ingest — File-based session ingestion for Claude Code and Codex.

Polls JSONL session files on disk and feeds tool calls, token usage, and
session metadata into the agent registry — no proxy required.

Supported tools
───────────────
  Claude Code  ~/.claude/projects/*/subagents/*.jsonl
  Codex        ~/.codex/sessions/**/*.jsonl
               /mnt/c/Users/*/codex/sessions/**/*.jsonl  (WSL Windows mount)

Each file is read incrementally using a byte-offset tracker persisted to
/var/lib/boostos/agents/ingest_state.json so daemon restarts don't re-process
historical lines.
"""
from __future__ import annotations

import asyncio
import glob
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import agent_registry

logger = logging.getLogger("boostos_rag.ingest")

_POLL_INTERVAL = 5.0          # seconds between scans
_STATE_SAVE_INTERVAL = 60.0   # seconds between state file flushes
_STATE_FILE = "/var/lib/boostos/agents/ingest_state.json"

# byte offset per file path
_offsets: dict[str, int] = {}

# file path → agent_id (cached to avoid repeated DB lookups)
_file_agents: dict[str, str] = {}

# Codex: per-file cumulative token totals so we record deltas, not totals
_codex_cum_tokens: dict[str, tuple[int, int]] = {}

# Codex: pending tool call waiting for its output event
_codex_pending_tool: dict[str, dict] = {}

_last_state_save = 0.0


# ── State persistence ─────────────────────────────────────────────────────────

def _load_state() -> None:
    try:
        data = json.loads(Path(_STATE_FILE).read_text())
        _offsets.update(data.get("offsets", {}))
        raw_cum = data.get("codex_cum_tokens", {})
        for k, v in raw_cum.items():
            _codex_cum_tokens[k] = tuple(v)  # type: ignore[assignment]
        logger.debug("Ingest state loaded: %d files tracked", len(_offsets))
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.warning("Could not load ingest state: %s", e)


def _save_state() -> None:
    global _last_state_save
    try:
        Path(_STATE_FILE).parent.mkdir(parents=True, exist_ok=True)
        Path(_STATE_FILE).write_text(json.dumps({
            "offsets": _offsets,
            "codex_cum_tokens": {k: list(v) for k, v in _codex_cum_tokens.items()},
        }, indent=2))
        _last_state_save = time.monotonic()
    except Exception as e:
        logger.debug("Could not save ingest state: %s", e)


# ── File discovery ────────────────────────────────────────────────────────────

def _iter_accessible(parent: Path):
    """Iterate subdirectories, silently skipping inaccessible ones."""
    try:
        for child in parent.iterdir():
            try:
                if child.is_dir():
                    yield child
            except PermissionError:
                pass
    except PermissionError:
        pass


def _claude_patterns() -> list[tuple[str, str]]:
    """Return (glob_pattern, tool) pairs for Claude Code."""
    results = []
    # Native Linux ~/.claude
    home = Path.home()
    native = home / ".claude" / "projects"
    if native.is_dir():
        results.append((str(native / "*" / "*" / "subagents" / "*.jsonl"), "claude-code"))
    # WSL mount: /mnt/c/Users/*/.claude/projects
    wsl_users = Path("/mnt/c/Users")
    if wsl_users.is_dir():
        for user_dir in _iter_accessible(wsl_users):
            claude_projects = user_dir / ".claude" / "projects"
            try:
                if claude_projects.is_dir():
                    results.append((
                        str(claude_projects / "*" / "*" / "subagents" / "*.jsonl"),
                        "claude-code",
                    ))
            except PermissionError:
                pass
    return results


def _codex_patterns() -> list[tuple[str, str]]:
    """Return (glob_pattern, tool) pairs for Codex on Linux and via WSL mount."""
    results = []
    home = Path.home()
    # Native Linux ~/.codex
    native = home / ".codex" / "sessions"
    if native.is_dir():
        results.append((str(native / "**" / "*.jsonl"), "codex"))
    # WSL mount: /mnt/c/Users/*/.codex/sessions
    wsl_users = Path("/mnt/c/Users")
    if wsl_users.is_dir():
        for user_dir in _iter_accessible(wsl_users):
            sessions = user_dir / ".codex" / "sessions"
            try:
                if sessions.is_dir():
                    results.append((str(sessions / "**" / "*.jsonl"), "codex"))
            except PermissionError:
                pass
    return results


def _find_all() -> list[tuple[str, str]]:
    """Return list of (file_path, tool) for all known session files."""
    pairs = []
    for pattern, tool in _claude_patterns() + _codex_patterns():
        for path in glob.glob(pattern, recursive=True):
            pairs.append((path, tool))
    return pairs


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_ts(ts_str: str) -> Optional[float]:
    if not ts_str:
        return None
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        return dt.timestamp()
    except Exception:
        return None


def _agent_id_for(path: str, tool: str, first_line: dict) -> str:
    """Look up or create the agent record for this file."""
    if path in _file_agents:
        # Refresh last_seen
        agent_registry.touch(
            _file_agents[path],
            _parse_ts(first_line.get("timestamp", "")) or time.time(),
        )
        return _file_agents[path]

    p = Path(path)
    workspace: Optional[str] = None
    model: Optional[str] = None

    if tool == "claude-code":
        # projects/<project-hash>/<session-uuid>/subagents/agent-<id>.jsonl
        session_uuid = p.parent.parent.name
        session_key = session_uuid[:12]
        workspace = first_line.get("cwd")
        model = first_line.get("message", {}).get("model")

    else:  # codex
        # sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl
        # Use last 12 chars of stem as key (session-id fragment)
        session_key = p.stem[-12:] if len(p.stem) >= 12 else p.stem
        if first_line.get("type") == "session_meta":
            payload = first_line.get("payload", {})
            workspace = payload.get("cwd")
            model = payload.get("model")

    agent_id = agent_registry.upsert_detected(session_key, tool, workspace)
    if model:
        agent_registry.update_model(agent_id, model)
    _file_agents[path] = agent_id
    return agent_id


# ── Claude Code parser ────────────────────────────────────────────────────────

def _process_claude_line(line: dict, agent_id: str) -> None:
    msg_type = line.get("type")
    if msg_type != "assistant":
        return

    message = line.get("message", {})
    ts = _parse_ts(line.get("timestamp", ""))

    # Token usage — each assistant message reports its own usage
    usage = message.get("usage", {})
    in_tok  = usage.get("input_tokens", 0)
    out_tok = usage.get("output_tokens", 0)
    cache_r = usage.get("cache_read_input_tokens", 0)
    cache_w = usage.get("cache_creation_input_tokens", 0)
    if in_tok or out_tok:
        agent_registry.record_usage(agent_id, in_tok, out_tok, cache_r, cache_w, ts=ts)

    # Tool calls
    for block in message.get("content", []):
        if not isinstance(block, dict):
            continue
        if block.get("type") == "tool_use":
            agent_registry.record_tool_call(
                agent_id=agent_id,
                tool_name=block.get("name", "unknown"),
                input_text=json.dumps(block.get("input", {}))[:4096],
                ts=ts,
            )


# ── Codex parser ──────────────────────────────────────────────────────────────

def _process_codex_line(line: dict, agent_id: str, path: str) -> None:
    event_type = line.get("type")
    payload    = line.get("payload", {})
    ts         = _parse_ts(line.get("timestamp", ""))

    if event_type == "event_msg" and payload.get("type") == "token_count":
        info = payload.get("info", {})
        last = info.get("last_token_usage", {})
        in_tok  = last.get("input_tokens", 0)
        out_tok = last.get("output_tokens", 0)
        cache_r = last.get("cached_input_tokens", 0)

        # Compute delta against last recorded cumulative for this file
        prev_in, prev_out = _codex_cum_tokens.get(path, (0, 0))
        delta_in  = max(0, in_tok  - prev_in)
        delta_out = max(0, out_tok - prev_out)
        _codex_cum_tokens[path] = (in_tok, out_tok)

        if delta_in or delta_out:
            agent_registry.record_usage(agent_id, delta_in, delta_out, cache_r, 0, ts=ts)

    elif event_type == "response_item":
        p_type = payload.get("type", "")

        # Tool call being initiated
        if "tool_call" in p_type and "output" not in p_type:
            _codex_pending_tool[path] = {
                "name": (
                    payload.get("name")
                    or payload.get("function", {}).get("name", "shell")
                ),
                "input": json.dumps(
                    payload.get("arguments", payload.get("input", {}))
                )[:4096],
                "ts": ts,
                "call_id": payload.get("call_id", ""),
            }

        # Tool call result
        elif p_type == "custom_tool_call_output":
            pending = _codex_pending_tool.pop(path, None)
            raw_out = payload.get("output", "{}")
            try:
                out_data  = json.loads(raw_out)
                meta      = out_data.get("metadata", {})
                latency   = int(meta.get("duration_seconds", 0) * 1000) or None
                out_text  = json.dumps(out_data.get("output", ""))[:4096]
                status    = "ok" if meta.get("exit_code", 0) == 0 else "error"
            except Exception:
                latency  = None
                out_text = raw_out[:4096]
                status   = "ok"

            agent_registry.record_tool_call(
                agent_id  = agent_id,
                tool_name = pending["name"] if pending else "shell",
                input_text= pending["input"] if pending else None,
                output_text=out_text,
                latency_ms = latency,
                status     = status,
                ts         = pending["ts"] if pending else ts,
            )


# ── Per-file incremental reader ───────────────────────────────────────────────

def _ingest_file(path: str, tool: str) -> None:
    try:
        size = os.path.getsize(path)
    except OSError:
        return

    offset = _offsets.get(path, 0)
    if size <= offset:
        return

    first_line: Optional[dict] = None
    agent_id: Optional[str]    = None

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            # Peek at line 1 for metadata (needed before we can get agent_id)
            fh.seek(0)
            for raw in fh:
                raw = raw.strip()
                if raw:
                    try:
                        first_line = json.loads(raw)
                    except Exception:
                        pass
                    break

            if first_line is None:
                return

            # Now process new lines from last offset
            fh.seek(offset)
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    line = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                if agent_id is None:
                    agent_id = _agent_id_for(path, tool, first_line)

                if tool == "claude-code":
                    _process_claude_line(line, agent_id)
                else:
                    _process_codex_line(line, agent_id, path)

            _offsets[path] = fh.tell()

    except Exception as e:
        logger.debug("Ingest error for %s: %s", path, e)


# ── Main loop ─────────────────────────────────────────────────────────────────

def scan_once() -> None:
    for path, tool in _find_all():
        _ingest_file(path, tool)


async def run_forever() -> None:
    _load_state()
    logger.info("Agent ingest watcher started")
    while True:
        try:
            scan_once()
        except Exception as e:
            logger.warning("Ingest scan error: %s", e)

        if time.monotonic() - _last_state_save > _STATE_SAVE_INTERVAL:
            _save_state()

        await asyncio.sleep(_POLL_INTERVAL)
