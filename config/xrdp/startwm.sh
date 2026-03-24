#!/usr/bin/env bash
set -eo pipefail

MODE="${BOOSTOS_XRDP_SESSION_MODE:-}"
MODE_FILE="/etc/boostos/xrdp-session-mode"

if [[ -z "$MODE" && -f "$MODE_FILE" ]]; then
  MODE="$(tr -d '[:space:]' <"$MODE_FILE")"
fi

case "$MODE" in
  xfce)
    TARGET="/etc/boostos/xrdp/startwm-xfce.sh"
    ;;
  minimal|"")
    TARGET="/etc/boostos/xrdp/startwm-minimal.sh"
    ;;
  *)
    echo "unknown BoostOS XRDP session mode: $MODE" >&2
    TARGET="/etc/boostos/xrdp/startwm-minimal.sh"
    ;;
esac

exec "$TARGET"
