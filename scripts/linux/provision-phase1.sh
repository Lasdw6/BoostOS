#!/usr/bin/env bash
set -euo pipefail

LINUX_USER=""
RDP_PORT="3390"
NODE_VERSION="20"
XRDP_SESSION_MODE="minimal"

usage() {
  cat <<'EOF'
Usage: provision-phase1.sh --user <linux-user> [--rdp-port <port>] [--xrdp-session-mode <minimal|xfce>]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      LINUX_USER="$2"
      shift 2
      ;;
    --rdp-port)
      RDP_PORT="$2"
      shift 2
      ;;
    --node-version)
      NODE_VERSION="$2"
      shift 2
      ;;
    --xrdp-session-mode)
      XRDP_SESSION_MODE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$LINUX_USER" ]]; then
  echo "--user is required" >&2
  exit 1
fi

if ! id -u "$LINUX_USER" >/dev/null 2>&1; then
  echo "Linux user does not exist: $LINUX_USER" >&2
  exit 1
fi

case "$XRDP_SESSION_MODE" in
  minimal|xfce)
    ;;
  *)
    echo "Invalid XRDP session mode: $XRDP_SESSION_MODE" >&2
    exit 1
    ;;
esac

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  dbus-x11 \
  git \
  jq \
  locales \
  rsync \
  socat \
  sudo \
  tmux \
  xfce4 \
  xfce4-goodies \
  xfce4-terminal \
  xterm \
  xorgxrdp \
  xrdp \
  zsh \
  build-essential \
  python3 \
  python3-pip \
  python3-venv \
  unzip \
  zip \
  ripgrep \
  fd-find \
  fonts-dejavu-core \
  fonts-liberation

adduser xrdp ssl-cert >/dev/null 2>&1 || true

locale-gen en_US.UTF-8
update-locale LANG=en_US.UTF-8

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not available; assuming WSL service management via service command"
fi

usermod -aG sudo "$LINUX_USER"
chsh -s /usr/bin/zsh "$LINUX_USER"

install -d -m 0755 /etc/profile.d
install -m 0644 /opt/boostos/config/profile/boostos-session.sh /etc/profile.d/boostos-session.sh

install -d -m 0755 /etc/xrdp
install -d -m 0755 /etc/boostos/xrdp
install -m 0755 /opt/boostos/config/xrdp/startwm.sh /etc/xrdp/startwm.sh
install -m 0755 /opt/boostos/config/xrdp/startwm-common.sh /etc/boostos/xrdp/startwm-common.sh
install -m 0755 /opt/boostos/config/xrdp/startwm-minimal.sh /etc/boostos/xrdp/startwm-minimal.sh
install -m 0755 /opt/boostos/config/xrdp/startwm-xfce.sh /etc/boostos/xrdp/startwm-xfce.sh
printf '%s\n' "$XRDP_SESSION_MODE" >/etc/boostos/xrdp-session-mode

python3 - "$RDP_PORT" <<'PY'
from pathlib import Path
import sys

port = sys.argv[1]
path = Path("/etc/xrdp/xrdp.ini")
lines = path.read_text().splitlines()
updated = []
in_globals = False
in_channels = False
replaced = False

for line in lines:
    stripped = line.strip()
    if stripped == "[Globals]":
        in_globals = True
        in_channels = False
        updated.append(line)
        continue
    if stripped == "[Channels]":
        in_channels = True
        in_globals = False
        updated.append(line)
        continue
    if in_globals and stripped.startswith("[") and stripped != "[Globals]":
        if not replaced:
            updated.append(f"port=tcp://:{port}")
            replaced = True
        in_globals = False
    if in_channels and stripped.startswith("[") and stripped != "[Channels]":
        in_channels = False
    if in_globals and line.startswith("port=") and not replaced:
        updated.append(f"port=tcp://:{port}")
        replaced = True
        continue
    if in_globals and stripped.startswith("security_layer="):
        updated.append("security_layer=rdp")
        continue
    if in_globals and stripped.startswith("crypt_level="):
        updated.append("crypt_level=high")
        continue
    if in_globals and stripped.startswith("allow_multimon="):
        updated.append("allow_multimon=false")
        continue
    if in_globals and stripped.startswith("max_bpp="):
        updated.append("max_bpp=24")
        continue
    if in_globals and stripped.startswith("use_fastpath="):
        updated.append("use_fastpath=none")
        continue
    if in_channels and stripped.startswith("drdynvc="):
        updated.append("drdynvc=false")
        continue
    if in_channels and stripped.startswith("rail="):
        updated.append("rail=false")
        continue
    if in_channels and stripped.startswith("xrdpvr="):
        updated.append("xrdpvr=false")
        continue
    if in_channels and stripped.startswith("tcutils="):
        updated.append("tcutils=false")
        continue
    updated.append(line)

if not replaced:
    raise SystemExit("Could not locate [Globals] port entry in /etc/xrdp/xrdp.ini")

path.write_text("\n".join(updated) + "\n")
PY

cat >/home/"$LINUX_USER"/.xsession <<'EOF'
#!/bin/sh
exec /etc/xrdp/startwm.sh
EOF
chown "$LINUX_USER":"$LINUX_USER" /home/"$LINUX_USER"/.xsession
chmod 0755 /home/"$LINUX_USER"/.xsession

cat >/home/"$LINUX_USER"/.zshrc <<'EOF'
export LANG=en_US.UTF-8
export TERM=xterm-256color
export NVM_DIR="$HOME/.nvm"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi

alias tma='tmux new-session -A -s boost'
EOF
chown "$LINUX_USER":"$LINUX_USER" /home/"$LINUX_USER"/.zshrc

sudo -u "$LINUX_USER" bash <<EOF
set -euo pipefail
if [[ ! -d "\$HOME/.nvm" ]]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash
fi
export NVM_DIR="\$HOME/.nvm"
source "\$NVM_DIR/nvm.sh"
nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
EOF

service dbus start >/dev/null 2>&1 || true
service xrdp-sesman restart
service xrdp restart

echo ""
echo "==> Provisioning Phase 2 (RAG daemon)"
bash /opt/boostos/scripts/provision-phase2.sh --user "$LINUX_USER"

cat <<EOF

BoostOS provisioning complete.

Next steps:
1. Set a Linux password for $LINUX_USER so xrdp login works.
2. Install Cursor or VS Code inside the desktop session.
3. Connect from Windows Remote Desktop to localhost:$RDP_PORT.
EOF
