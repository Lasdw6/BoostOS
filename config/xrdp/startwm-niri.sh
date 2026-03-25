#!/usr/bin/env bash
set -eo pipefail

export BOOSTOS_XRDP_SESSION_MODE="niri"
. /etc/boostos/xrdp/startwm-common.sh

# Override the XFCE desktop vars set by startwm-common.sh
export DESKTOP_SESSION=niri
export XDG_CURRENT_DESKTOP=niri
export XDG_SESSION_DESKTOP=niri

if ! command -v niri >/dev/null 2>&1; then
  echo "niri not found; falling back to xterm" >>"$HOME/.xsession-errors"
  exec dbus-launch --exit-with-session xterm -fa Monospace -fs 11 >>"$HOME/.xsession-errors" 2>&1
fi

echo "==> startwm-niri: display=${DISPLAY:-unset} niri=$(command -v niri)" >>"$HOME/.xsession-errors"

exec dbus-launch --exit-with-session \
  bash -l /etc/boostos/xrdp/niri-session.sh \
  >>"$HOME/.xsession-errors" 2>&1
