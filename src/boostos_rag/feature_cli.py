"""
boostos_rag.feature_cli — CLI for toggling BoostOS feature flags.

Entry point: boostos-feature

Writes directly to /var/lib/boostos/features.json (no daemon round-trip).
Changes take effect immediately — wrappers (grep, ps, etc.) read the file
on every invocation.
"""
from __future__ import annotations

import click

from .features import all_features, set_feature, _DESCRIPTIONS


@click.group()
def feature_cmd() -> None:
    """Toggle BoostOS feature flags on or off."""


@feature_cmd.command("list")
def list_features() -> None:
    """Show all features and their current state."""
    features = all_features()
    click.echo(f"{'Feature':<22}  {'State':<8}  Description")
    click.echo("─" * 75)
    for f in features:
        state = click.style("enabled", fg="green") if f["enabled"] else click.style("disabled", fg="red")
        click.echo(f"{f['name']:<22}  {state:<8}  {f['description']}")


@feature_cmd.command()
@click.argument("name", type=click.Choice(list(_DESCRIPTIONS.keys())))
def enable(name: str) -> None:
    """Enable a feature flag."""
    set_feature(name, True)
    click.echo(f"Enabled: {name}")


@feature_cmd.command()
@click.argument("name", type=click.Choice(list(_DESCRIPTIONS.keys())))
def disable(name: str) -> None:
    """Disable a feature flag."""
    set_feature(name, False)
    click.echo(f"Disabled: {name}")
