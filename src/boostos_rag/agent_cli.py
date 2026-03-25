"""
boostos_rag.agent_cli — CLI for agent registration and tool call history.

Entry point: boostos-agent

Usage:
    boostos-agent register --name "claude-code" [--workspace ~/projects/app] [--model MODEL] [--pid N]
    boostos-agent unregister <agent_id>
    boostos-agent list [--json]
    boostos-agent ping <agent_id>
    boostos-agent tool <agent_id> --tool <name> --input <text> --output <text> --latency-ms <n>
    boostos-agent history <agent_id> [--json] [--limit 50]
    boostos-agent hook-pre               # called by Claude Code PreToolUse hook (reads stdin)
    boostos-agent hook-post              # called by Claude Code PostToolUse hook (reads stdin)
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

import click
import httpx

_RAG_URL = os.environ.get("BOOSTOS_RAG_URL", "http://127.0.0.1:7700")
_AGENT_ID_FILE = Path.home() / ".boostos_agent_id"
# Temp file for pre-hook start time: /tmp/.boostos_hook_<agent_id>
_PRE_HOOK_TPL = "/tmp/.boostos_hook_{}"


def _api(path: str, method: str = "GET", **kw) -> dict:
    url = f"{_RAG_URL}{path}"
    try:
        resp = httpx.request(method, url, timeout=5, **kw)
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPStatusError as e:
        click.echo(f"Error: {e.response.status_code} {e.response.text}", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Error: cannot reach RAG daemon at {_RAG_URL}: {e}", err=True)
        sys.exit(1)


@click.group()
def agent_cmd() -> None:
    """BoostOS agent registration and tool call tracking."""


# ── register ──────────────────────────────────────────────────────────────────

@agent_cmd.command()
@click.option("--name",      required=True, help="Agent name (e.g. claude-code)")
@click.option("--workspace", default=None,  help="Working directory path")
@click.option("--model",     default=None,  help="Model identifier")
@click.option("--pid",       default=None,  type=int, help="Agent process PID (default: caller PID)")
def register(name: str, workspace: Optional[str], model: Optional[str], pid: Optional[int]) -> None:
    """Register this agent with BoostOS. Prints the agent ID."""
    payload: dict = {"name": name}
    if workspace:
        payload["workspace"] = workspace
    if model:
        payload["model"] = model
    payload["pid"] = pid or os.getppid()

    data = _api("/agents", method="POST", json=payload)
    agent_id = data["id"]
    click.echo(agent_id)

    # Write to ~/.boostos_agent_id so hooks can pick it up without re-querying
    try:
        _AGENT_ID_FILE.write_text(agent_id)
    except Exception:
        pass


# ── unregister ────────────────────────────────────────────────────────────────

@agent_cmd.command()
@click.argument("agent_id")
def unregister(agent_id: str) -> None:
    """Unregister an agent."""
    _api(f"/agents/{agent_id}", method="DELETE")
    click.echo(f"Unregistered {agent_id}")
    # Clean up local file if it matches
    try:
        if _AGENT_ID_FILE.exists() and _AGENT_ID_FILE.read_text().strip() == agent_id:
            _AGENT_ID_FILE.unlink()
    except Exception:
        pass


# ── list ──────────────────────────────────────────────────────────────────────

@agent_cmd.command("list")
@click.option("--json", "as_json", is_flag=True)
@click.option("--all",  "show_all", is_flag=True, help="Include inactive agents")
def list_agents(as_json: bool, show_all: bool) -> None:
    """List registered agents."""
    params = {}
    if show_all:
        params["include_inactive"] = "true"
    data = _api("/agents", method="GET", params=params)
    agents = data.get("agents", [])
    if as_json:
        click.echo(json.dumps(agents))
        return
    if not agents:
        click.echo("No registered agents.")
        return
    click.echo(f"{'ID':<14}  {'Name':<20}  {'Status':<8}  {'Workspace'}")
    click.echo("─" * 70)
    for a in agents:
        ws = (a.get("workspace") or "")[:35]
        click.echo(f"{a['id']:<14}  {a['name']:<20}  {a['status']:<8}  {ws}")


# ── ping ──────────────────────────────────────────────────────────────────────

@agent_cmd.command()
@click.argument("agent_id")
def ping(agent_id: str) -> None:
    """Send a heartbeat to keep the agent registration active."""
    _api(f"/agents/{agent_id}/ping", method="PUT")
    click.echo("ok")


# ── tool ──────────────────────────────────────────────────────────────────────

@agent_cmd.command()
@click.argument("agent_id")
@click.option("--tool",       required=True, help="Tool name")
@click.option("--input",      "input_text",  default="", help="Tool input (text/JSON)")
@click.option("--output",     "output_text", default="", help="Tool output (text/JSON)")
@click.option("--latency-ms", default=None, type=int, help="Latency in milliseconds")
@click.option("--status",     default="ok")
def tool(
    agent_id: str,
    tool: str,
    input_text: str,
    output_text: str,
    latency_ms: Optional[int],
    status: str,
) -> None:
    """Record a tool call for an agent."""
    payload: dict = {
        "tool_name": tool,
        "input_text": input_text,
        "output_text": output_text,
        "status": status,
    }
    if latency_ms is not None:
        payload["latency_ms"] = latency_ms
    _api(f"/agents/{agent_id}/tools", method="POST", json=payload)
    click.echo("recorded")


# ── history ───────────────────────────────────────────────────────────────────

@agent_cmd.command()
@click.argument("agent_id")
@click.option("--json", "as_json", is_flag=True)
@click.option("--limit", default=20, show_default=True)
def history(agent_id: str, as_json: bool, limit: int) -> None:
    """Show tool call history for an agent."""
    data = _api(f"/agents/{agent_id}/tools", params={"limit": limit})
    calls = data.get("calls", [])
    if as_json:
        click.echo(json.dumps(calls))
        return
    if not calls:
        click.echo("No tool calls recorded.")
        return
    click.echo(f"{'Time':<22}  {'Tool':<18}  {'Ms':>6}  {'Status':<6}  Input preview")
    click.echo("─" * 80)
    for c in calls:
        ts = time.strftime("%m-%d %H:%M:%S", time.localtime(c["ts"]))
        ms = str(c["latency_ms"]) if c["latency_ms"] is not None else "—"
        preview = (c.get("input_text") or "")[:35].replace("\n", " ")
        click.echo(f"{ts:<22}  {c['tool_name']:<18}  {ms:>6}  {c['status']:<6}  {preview}")


# ── hook-pre ──────────────────────────────────────────────────────────────────

@agent_cmd.command("hook-pre")
def hook_pre() -> None:
    """PreToolUse hook — stores start timestamp. Called by Claude Code hooks."""
    agent_id = os.environ.get("BOOSTOS_AGENT_ID", "").strip()
    if not agent_id:
        return  # not registered, silent exit

    try:
        data = json.loads(sys.stdin.read())
        tool_name = data.get("tool_name", "unknown")
        pre_file = Path(_PRE_HOOK_TPL.format(agent_id))
        pre_file.write_text(json.dumps({"ts": time.time(), "tool": tool_name}))
    except Exception:
        pass  # hooks must never block tool execution


# ── hook-post ─────────────────────────────────────────────────────────────────

@agent_cmd.command("hook-post")
def hook_post() -> None:
    """PostToolUse hook — records tool call with latency. Called by Claude Code hooks."""
    agent_id = os.environ.get("BOOSTOS_AGENT_ID", "").strip()
    if not agent_id:
        return

    try:
        raw = sys.stdin.read()
        data = json.loads(raw)
        tool_name = data.get("tool_name", "unknown")
        tool_input = data.get("tool_input", {})
        tool_response = data.get("tool_response", {})

        # Compute latency from pre-hook file
        latency_ms: Optional[int] = None
        pre_file = Path(_PRE_HOOK_TPL.format(agent_id))
        if pre_file.exists():
            try:
                pre = json.loads(pre_file.read_text())
                latency_ms = int((time.time() - pre["ts"]) * 1000)
                pre_file.unlink(missing_ok=True)
            except Exception:
                pass

        # Summarise input/output (keep first 2KB each)
        input_text = json.dumps(tool_input)[:2048] if tool_input else ""
        output_text = json.dumps(tool_response)[:2048] if tool_response else ""

        payload = {
            "tool_name": tool_name,
            "input_text": input_text,
            "output_text": output_text,
            "latency_ms": latency_ms,
            "status": "ok",
        }
        # Best-effort HTTP — don't block if daemon is busy
        httpx.post(
            f"{_RAG_URL}/agents/{agent_id}/tools",
            json=payload,
            timeout=2,
        )
    except Exception:
        pass  # hooks must never block tool execution
