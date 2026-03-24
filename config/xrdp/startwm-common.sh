#!/usr/bin/env bash
set -eo pipefail

unset DBUS_SESSION_BUS_ADDRESS
unset WAYLAND_DISPLAY
unset WAYLAND_SOCKET
unset SWAYSOCK
unset SESSION_MANAGER

export LANG="${LANG:-en_US.UTF-8}"
export XRDP_SESSION=1
export DESKTOP_SESSION=xfce
export XDG_CURRENT_DESKTOP=XFCE
export XDG_SESSION_DESKTOP=xfce
export XDG_SESSION_TYPE=x11
export GDK_BACKEND=x11
export QT_QPA_PLATFORM=xcb

USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6 2>/dev/null || true)"
if [[ -n "$USER_HOME" ]]; then
  export HOME="$USER_HOME"
fi

export XDG_RUNTIME_DIR="/run/user/$(id -u)"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

if [[ -f /etc/profile ]]; then
  # shellcheck disable=SC1091
  . /etc/profile
fi

if [[ -f "$HOME/.profile" ]]; then
  # shellcheck disable=SC1090
  . "$HOME/.profile"
fi

echo "starting xrdp session mode ${BOOSTOS_XRDP_SESSION_MODE:-unknown} for $(id -un)" >>"$HOME/.xsession-errors"

pkill -u "$(id -u)" -x xfce4-panel 2>/dev/null || true
pkill -u "$(id -u)" -x xfdesktop 2>/dev/null || true
pkill -u "$(id -u)" -x xfsettingsd 2>/dev/null || true
pkill -u "$(id -u)" -x xfwm4 2>/dev/null || true
pkill -u "$(id -u)" -x Thunar 2>/dev/null || true
sleep 1
