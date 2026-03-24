#!/usr/bin/env bash
set -eo pipefail

export BOOSTOS_XRDP_SESSION_MODE="minimal"
. /etc/boostos/xrdp/startwm-common.sh

exec xterm -fa Monospace -fs 11 >>"$HOME/.xsession-errors" 2>&1
