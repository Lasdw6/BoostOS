#!/usr/bin/env bash
# Inner session script for niri XRDP sessions.
# Invoked as: bash -l /etc/boostos/xrdp/niri-session.sh
# bash -l sources /etc/profile before running this file (same as bash -lc was doing).
set -eo pipefail

_log() { echo "==> niri: $*" >>"$HOME/.xsession-errors"; }
_log "session started display=${DISPLAY:-unset}"
trap '_log "EXIT code=$?"' EXIT

export DISPLAY="${DISPLAY:-:10.0}"
export XRDP_SESSION=1
export XDG_CURRENT_DESKTOP=niri
export XDG_SESSION_DESKTOP=niri
export XDG_SESSION_TYPE=x11
export GDK_BACKEND=x11
export QT_QPA_PLATFORM=xcb

# Hide the outer X11 cursor so it does not overlap niri's Wayland cursor.
printf '#define c_width 1\n#define c_height 1\nstatic char c[]={0};\n' >/tmp/.ncur 2>/dev/null || true
printf '#define m_width 1\n#define m_height 1\nstatic char m[]={0};\n' >/tmp/.nmsk 2>/dev/null || true
xsetroot -cursor /tmp/.ncur /tmp/.nmsk 2>/dev/null || true

# After niri creates its X11 window: resize it to fill the XRDP display, then
# hide the hardware cursor so only niri's own cursor is visible (no double cursor).
(
  set +e +o pipefail
  for i in $(seq 1 40); do
    WIN=$(xdotool search --name niri 2>/dev/null | head -1)
    [ -n "$WIN" ] && break
    sleep 0.25
  done
  if [ -n "$WIN" ]; then
    SIZE=$(xrandr 2>/dev/null | sed -n 's/.*current \([0-9]*\) x \([0-9]*\).*/\1 \2/p' | head -1)
    W=${SIZE% *}
    H=${SIZE#* }
    xdotool windowmove "$WIN" 0 0 2>/dev/null
    xdotool windowsize "$WIN" "$W" "$H" 2>/dev/null
    echo "==> niri: window resized to ${W}x${H}" >>"$HOME/.xsession-errors"
    python3 /etc/boostos/xrdp/niri-cursor-hide.py "$WIN" 2>/dev/null &
  fi
) &

_log "launching niri"
exec niri --config /etc/boostos/niri/config.kdl >>"$HOME/.xsession-errors" 2>&1
