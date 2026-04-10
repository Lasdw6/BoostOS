"""
boostos_rag.agent_registry — SQLite-backed agent registry and tool call history.

DB at /var/lib/boostos/agents/registry.db (created on first init).

Agents register when they start, ping to stay active, unregister when done.
Tool calls are recorded with tool name, truncated I/O, and latency.
The `ps` JSON wrapper cross-references this DB to annotate processes with
their registered agent name.
"""
from __future__ import annotations

import sqlite3
import time
import uuid
from pathlib import Path
from typing import Optional

DEFAULT_DB = "/var/lib/boostos/agents/registry.db"

# Agent considered stale if no ping for this many seconds
_STALE_SECONDS = 300.0

# Max bytes stored per tool call input/output field
_MAX_TEXT = 4096

_db: Optional[sqlite3.Connection] = None

_SCHEMA = """
CREATE TABLE IF NOT EXISTS agents (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    pid           INTEGER,
    workspace     TEXT,
    model         TEXT,
    registered_at REAL NOT NULL,
    last_seen     REAL NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS tool_calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL,
    ts          REAL NOT NULL,
    tool_name   TEXT NOT NULL,
    input_text  TEXT,
    output_text TEXT,
    latency_ms  INTEGER,
    status      TEXT NOT NULL DEFAULT 'ok',
    FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS token_usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL,
    ts          REAL NOT NULL,
    input_tok   INTEGER NOT NULL DEFAULT 0,
    output_tok  INTEGER NOT NULL DEFAULT 0,
    cache_read  INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_agents_status  ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_pid     ON agents(pid);
CREATE INDEX IF NOT EXISTS idx_tools_agent    ON tool_calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_tools_ts       ON tool_calls(ts);
CREATE INDEX IF NOT EXISTS idx_usage_agent    ON token_usage(agent_id);
CREATE INDEX IF NOT EXISTS idx_usage_ts       ON token_usage(ts);
"""


def init(db_path: str = DEFAULT_DB) -> None:
    global _db
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    _db = sqlite3.connect(db_path, check_same_thread=False)
    _db.execute("PRAGMA journal_mode=WAL")
    _db.execute("PRAGMA synchronous=NORMAL")
    _db.executescript(_SCHEMA)
    _db.commit()


def _conn() -> sqlite3.Connection:
    if _db is None:
        init()
    return _db  # type: ignore[return-value]


# ── Agent CRUD ────────────────────────────────────────────────────────────────

def register(
    name: str,
    pid: Optional[int] = None,
    workspace: Optional[str] = None,
    model: Optional[str] = None,
) -> str:
    """Register a new agent. Returns the new agent ID (UUID)."""
    agent_id = uuid.uuid4().hex[:12]
    now = time.time()
    with _conn():
        _conn().execute(
            "INSERT INTO agents (id, name, pid, workspace, model, registered_at, last_seen, status)"
            " VALUES (?,?,?,?,?,?,?,'active')",
            (agent_id, name, pid, workspace, model, now, now),
        )
    return agent_id


def unregister(agent_id: str) -> bool:
    """Mark agent as inactive. Returns True if found."""
    with _conn():
        cur = _conn().execute(
            "UPDATE agents SET status='inactive' WHERE id=?", (agent_id,)
        )
    return cur.rowcount > 0


def ping(agent_id: str) -> bool:
    """Update last_seen for an agent. Returns True if found."""
    with _conn():
        cur = _conn().execute(
            "UPDATE agents SET last_seen=? WHERE id=?", (time.time(), agent_id)
        )
    return cur.rowcount > 0


def list_agents(include_inactive: bool = False) -> list[dict]:
    """Return registered agents, newest first. Marks stale ones automatically."""
    _mark_stale()
    where = "" if include_inactive else "WHERE status != 'inactive'"
    rows = _conn().execute(
        f"SELECT id, name, pid, workspace, model, registered_at, last_seen, status"
        f" FROM agents {where} ORDER BY registered_at DESC"
    ).fetchall()
    return [_agent_row(r) for r in rows]


def get_agent(agent_id: str) -> Optional[dict]:
    row = _conn().execute(
        "SELECT id, name, pid, workspace, model, registered_at, last_seen, status"
        " FROM agents WHERE id=?",
        (agent_id,),
    ).fetchone()
    return _agent_row(row) if row else None


def _agent_row(r: tuple) -> dict:
    return {
        "id": r[0], "name": r[1], "pid": r[2], "workspace": r[3],
        "model": r[4], "registered_at": r[5], "last_seen": r[6], "status": r[7],
    }


def _mark_stale() -> None:
    cutoff = time.time() - _STALE_SECONDS
    with _conn():
        _conn().execute(
            "UPDATE agents SET status='stale' WHERE status='active' AND last_seen < ?",
            (cutoff,),
        )


# ── Tool call recording ───────────────────────────────────────────────────────

def record_tool_call(
    agent_id: str,
    tool_name: str,
    input_text: Optional[str] = None,
    output_text: Optional[str] = None,
    latency_ms: Optional[int] = None,
    status: str = "ok",
    ts: Optional[float] = None,
) -> int:
    """Record a tool call. Returns the row id."""
    with _conn():
        cur = _conn().execute(
            "INSERT INTO tool_calls (agent_id, ts, tool_name, input_text, output_text, latency_ms, status)"
            " VALUES (?,?,?,?,?,?,?)",
            (
                agent_id,
                ts if ts is not None else time.time(),
                tool_name,
                (input_text or "")[:_MAX_TEXT],
                (output_text or "")[:_MAX_TEXT],
                latency_ms,
                status,
            ),
        )
    return cur.lastrowid  # type: ignore[return-value]


def get_tool_calls(agent_id: str, limit: int = 50) -> list[dict]:
    rows = _conn().execute(
        "SELECT id, agent_id, ts, tool_name, input_text, output_text, latency_ms, status"
        " FROM tool_calls WHERE agent_id=? ORDER BY ts DESC LIMIT ?",
        (agent_id, limit),
    ).fetchall()
    return [_tool_row(r) for r in rows]


def _tool_row(r: tuple) -> dict:
    return {
        "id": r[0], "agent_id": r[1], "ts": r[2], "tool_name": r[3],
        "input_text": r[4], "output_text": r[5], "latency_ms": r[6], "status": r[7],
    }


def pid_to_agent(pid: int) -> Optional[str]:
    """Return agent name for a PID, or None if not registered."""
    row = _conn().execute(
        "SELECT name FROM agents WHERE pid=? AND status IN ('active','stale') LIMIT 1",
        (pid,),
    ).fetchone()
    return row[0] if row else None


def upsert_detected(session_key: str, tool: str, workspace: Optional[str]) -> str:
    """Auto-register or refresh an agent detected via the proxy.

    Uses session_key as a stable ID (hash of system prompt) so the same
    conversation isn't re-registered on every API call.  Returns agent_id.
    """
    agent_id = f"auto-{session_key}"
    now = time.time()
    with _conn():
        existing = _conn().execute(
            "SELECT id FROM agents WHERE id=?", (agent_id,)
        ).fetchone()
        if existing:
            _conn().execute(
                "UPDATE agents SET last_seen=?, status='active' WHERE id=?",
                (now, agent_id),
            )
        else:
            _conn().execute(
                "INSERT INTO agents"
                " (id, name, pid, workspace, model, registered_at, last_seen, status)"
                " VALUES (?,?,NULL,?,NULL,?,?,'active')",
                (agent_id, tool, workspace, now, now),
            )
    return agent_id


def update_model(agent_id: str, model: str) -> None:
    """Set the model field on an agent record if not already set."""
    with _conn():
        _conn().execute(
            "UPDATE agents SET model=? WHERE id=? AND (model IS NULL OR model='')",
            (model, agent_id),
        )


def touch(agent_id: str, ts: float) -> None:
    """Update last_seen without changing status."""
    with _conn():
        _conn().execute(
            "UPDATE agents SET last_seen=MAX(last_seen,?) WHERE id=?",
            (ts, agent_id),
        )


def record_usage(
    agent_id: str,
    input_tok: int,
    output_tok: int,
    cache_read: int = 0,
    cache_write: int = 0,
    ts: Optional[float] = None,
) -> None:
    """Record a token usage event (one per API call or assistant turn)."""
    with _conn():
        _conn().execute(
            "INSERT INTO token_usage (agent_id, ts, input_tok, output_tok, cache_read, cache_write)"
            " VALUES (?,?,?,?,?,?)",
            (agent_id, ts if ts is not None else time.time(),
             input_tok, output_tok, cache_read, cache_write),
        )


def get_usage(agent_id: str) -> dict:
    """Return aggregate token usage for an agent."""
    row = _conn().execute(
        "SELECT SUM(input_tok), SUM(output_tok), SUM(cache_read), SUM(cache_write)"
        " FROM token_usage WHERE agent_id=?",
        (agent_id,),
    ).fetchone()
    return {
        "input_tok":   row[0] or 0,
        "output_tok":  row[1] or 0,
        "cache_read":  row[2] or 0,
        "cache_write": row[3] or 0,
    }
