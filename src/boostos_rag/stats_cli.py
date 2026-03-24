"""
boostos_rag.stats_cli — boostos-stats command.

Shows API token usage and cost aggregated across all agents.
Data comes from the proxy server (boostos-proxy service).
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import click

from .proxy_db import DEFAULT_DB, init, query_summary, query_totals


def _fmt_tok(n: int) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.0f}K"
    return str(n)


def _since(days: int) -> float:
    return time.time() - days * 86_400


def _period_label(days: int) -> str:
    if days == 1:
        now = datetime.now(timezone.utc)
        return f"Today ({now.strftime('%a %b %-d')})"
    return f"Last {days} days"


@click.command("stats")
@click.option("--week",  "days", flag_value=7,  help="Last 7 days")
@click.option("--month", "days", flag_value=30, help="Last 30 days")
@click.option("--days",  "days", default=1, type=int, metavar="N", help="Last N days (default: today)")
@click.option("--json",  "as_json", is_flag=True, help="Machine-readable JSON output")
@click.option("--db",    default=DEFAULT_DB, hidden=True)
def main(days: int, as_json: bool, db: str) -> None:
    """Show API token usage and cost across all agents."""
    try:
        init(db)
    except Exception:
        if as_json:
            click.echo(json.dumps({"error": "proxy database not found", "db": db}))
        else:
            click.echo(f"No usage data yet — is boostos-proxy running?  (db: {db})")
        raise SystemExit(1)

    since = _since(days)
    totals = query_totals(since)
    rows   = query_summary(since)

    if as_json:
        click.echo(json.dumps({"period_days": days, "totals": totals, "by_model": rows}, indent=2))
        return

    label = _period_label(days)
    total_tok = totals["input_tok"] + totals["output_tok"]

    click.echo()
    click.echo(f" BoostOS Usage — {label}")
    click.echo(" " + "─" * 52)

    if not rows:
        click.echo(" No calls recorded in this period.")
        click.echo()
        return

    click.echo(
        f" {_fmt_tok(total_tok)} tokens  ·  "
        f"{totals['calls']} calls  ·  "
        f"${totals['cost_usd']:.2f}"
    )
    click.echo()

    # Table
    col = "{:<12}  {:<24}  {:>5}  {:>8}  {:>8}  {:>7}"
    click.echo(" " + col.format("Provider", "Model", "Calls", "Input", "Output", "Cost"))
    click.echo(" " + "─" * 72)
    for r in rows:
        model = r["model"][:24]
        click.echo(
            " " + col.format(
                r["provider"][:12],
                model,
                r["calls"],
                _fmt_tok(r["input_tok"]),
                _fmt_tok(r["output_tok"]),
                f"${r['cost_usd']:.2f}",
            )
        )
    click.echo()
