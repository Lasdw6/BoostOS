"""
boostos_rag.proxy_db — Usage storage for the API proxy.

Records every API call (provider, model, tokens, cost) to SQLite.
Read by boostos-stats; written by the proxy server.
"""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Optional

DEFAULT_DB = "/var/lib/boostos/rag/usage.db"

_db: Optional[sqlite3.Connection] = None

_SCHEMA = """
CREATE TABLE IF NOT EXISTS api_calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          REAL    NOT NULL,
    provider    TEXT    NOT NULL,
    model       TEXT    NOT NULL,
    input_tok   INTEGER NOT NULL DEFAULT 0,
    output_tok  INTEGER NOT NULL DEFAULT 0,
    cost_usd    REAL    NOT NULL DEFAULT 0.0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    agent_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_ts       ON api_calls(ts);
CREATE INDEX IF NOT EXISTS idx_model    ON api_calls(model);
CREATE INDEX IF NOT EXISTS idx_agent_id ON api_calls(agent_id);
"""

_MIGRATION = """
ALTER TABLE api_calls ADD COLUMN agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_id ON api_calls(agent_id);
"""

# Cost per million tokens — update when provider pricing changes
_COSTS: dict[str, dict[str, float]] = {
    "claude-opus-4":      {"in": 15.00, "out": 75.00},
    "claude-sonnet-4":    {"in":  3.00, "out": 15.00},
    "claude-haiku-4":     {"in":  0.80, "out":  4.00},
    "gpt-4o-mini":        {"in":  0.15, "out":  0.60},
    "gpt-4o":             {"in":  2.50, "out": 10.00},
    "gpt-4-turbo":        {"in": 10.00, "out": 30.00},
    "gpt-4":              {"in": 30.00, "out": 60.00},
    "gpt-3.5-turbo":      {"in":  0.50, "out":  1.50},
    "o1-mini":            {"in":  3.00, "out": 12.00},
    "o1":                 {"in": 15.00, "out": 60.00},
    "gemini-1.5-flash":   {"in":  0.075,"out":  0.30},
    "gemini-1.5-pro":     {"in":  1.25, "out":  5.00},
}


def _calc_cost(model: str, input_tok: int, output_tok: int) -> float:
    m = model.lower()
    for key, p in _COSTS.items():
        if key in m:
            return input_tok / 1_000_000 * p["in"] + output_tok / 1_000_000 * p["out"]
    return 0.0


def init(db_path: str = DEFAULT_DB) -> None:
    global _db
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    _db = sqlite3.connect(db_path, check_same_thread=False)
    _db.execute("PRAGMA journal_mode=WAL")
    _db.execute("PRAGMA synchronous=NORMAL")
    _db.executescript(_SCHEMA)
    # Migrate older DBs that lack agent_id column
    cols = {r[1] for r in _db.execute("PRAGMA table_info(api_calls)").fetchall()}
    if "agent_id" not in cols:
        try:
            _db.executescript(_MIGRATION)
        except Exception:
            pass
    _db.commit()


def record(
    provider: str,
    model: str,
    input_tok: int,
    output_tok: int,
    duration_ms: int = 0,
    agent_id: Optional[str] = None,
) -> None:
    if _db is None:
        return
    cost = _calc_cost(model, input_tok, output_tok)
    try:
        with _db:
            _db.execute(
                "INSERT INTO api_calls"
                "(ts, provider, model, input_tok, output_tok, cost_usd, duration_ms, agent_id)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (time.time(), provider, model, input_tok, output_tok, cost, duration_ms, agent_id),
            )
    except Exception:
        pass


def query_summary(since_ts: float) -> list[dict]:
    """Return per-model aggregates since since_ts."""
    if _db is None:
        return []
    rows = _db.execute(
        "SELECT provider, model, COUNT(*), SUM(input_tok), SUM(output_tok), SUM(cost_usd)"
        " FROM api_calls WHERE ts >= ? GROUP BY provider, model ORDER BY SUM(cost_usd) DESC",
        (since_ts,),
    ).fetchall()
    return [
        {
            "provider": r[0], "model": r[1], "calls": r[2],
            "input_tok": r[3], "output_tok": r[4], "cost_usd": r[5],
        }
        for r in rows
    ]


def query_totals(since_ts: float) -> dict:
    if _db is None:
        return {}
    row = _db.execute(
        "SELECT COUNT(*), SUM(input_tok), SUM(output_tok), SUM(cost_usd)"
        " FROM api_calls WHERE ts >= ?",
        (since_ts,),
    ).fetchone()
    return {
        "calls": row[0] or 0,
        "input_tok": row[1] or 0,
        "output_tok": row[2] or 0,
        "cost_usd": row[3] or 0.0,
    }


def query_summary_with_agents(since_ts: float) -> list[dict]:
    """Per-(provider, model, agent) aggregates since since_ts. Used by debug panel."""
    if _db is None:
        return []
    rows = _db.execute(
        "SELECT provider, model, agent_id, COUNT(*), SUM(input_tok), SUM(output_tok), SUM(cost_usd)"
        " FROM api_calls WHERE ts >= ?"
        " GROUP BY provider, model, agent_id ORDER BY SUM(cost_usd) DESC",
        (since_ts,),
    ).fetchall()
    return [
        {
            "provider": r[0], "model": r[1], "agent_id": r[2],
            "calls": r[3], "input_tok": r[4], "output_tok": r[5], "cost_usd": r[6],
        }
        for r in rows
    ]
