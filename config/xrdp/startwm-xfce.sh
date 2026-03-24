#!/usr/bin/env bash
set -eo pipefail

export BOOSTOS_XRDP_SESSION_MODE="xfce"
. /etc/boostos/xrdp/startwm-common.sh

if command -v xfwm4 >/dev/null 2>&1 && command -v xfce4-panel >/dev/null 2>&1 && command -v xfdesktop >/dev/null 2>&1; then
  exec dbus-launch --exit-with-session bash -lc '
    set -eo pipefail
    export DISPLAY="${DISPLAY:-:10.0}"
    export XRDP_SESSION=1
    export XDG_CURRENT_DESKTOP=XFCE
    export XDG_SESSION_DESKTOP=xfce
    export XDG_SESSION_TYPE=x11
    export GDK_BACKEND=x11
    export QT_QPA_PLATFORM=xcb

    echo "launching xfsettingsd" >>"$HOME/.xsession-errors"
    xfsettingsd >>"$HOME/.xsession-errors" 2>&1 &

    echo "launching xfce4-panel" >>"$HOME/.xsession-errors"
    xfce4-panel >>"$HOME/.xsession-errors" 2>&1 &

    echo "launching xfdesktop" >>"$HOME/.xsession-errors"
    xfdesktop >>"$HOME/.xsession-errors" 2>&1 &

    sleep 1

    echo "launching xfwm4 (session anchor)" >>"$HOME/.xsession-errors"
    exec xfwm4 --compositor=off >>"$HOME/.xsession-errors" 2>&1
  ' >>"$HOME/.xsession-errors" 2>&1
fi

exec dbus-launch --exit-with-session xterm -fa Monospace -fs 11 >>"$HOME/.xsession-errors" 2>&1
