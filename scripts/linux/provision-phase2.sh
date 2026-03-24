#!/usr/bin/env bash
set -euo pipefail

LINUX_USER=""
API_PORT="7700"
EMBEDDING_MODEL="all-MiniLM-L6-v2"

usage() {
  cat <<'EOF'
Usage: provision-phase2.sh --user <linux-user> [--api-port <port>] [--model <model-name>]

Installs the BoostOS RAG daemon (Phase 2) inside the guest Linux environment.
Must be run as root.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)       LINUX_USER="$2"; shift 2 ;;
    --api-port)   API_PORT="$2";   shift 2 ;;
    --model)      EMBEDDING_MODEL="$2"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *)            echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$LINUX_USER" ]]; then
  echo "--user is required" >&2; exit 1
fi

if ! id -u "$LINUX_USER" >/dev/null 2>&1; then
  echo "Linux user does not exist: $LINUX_USER" >&2; exit 1
fi

export DEBIAN_FRONTEND=noninteractive

# ── System packages ───────────────────────────────────────────────────────────
echo "==> Installing system packages"
apt-get update -qq
apt-get install -y --no-install-recommends \
  python3-dev \
  libsqlite3-dev

# ── Directories ───────────────────────────────────────────────────────────────
# The daemon runs as the Linux user, so data dirs are owned by that user.
echo "==> Creating directories"
install -d -m 0755 -o "$LINUX_USER" -g "$LINUX_USER" /var/lib/boostos/rag
install -d -m 0755 -o "$LINUX_USER" -g "$LINUX_USER" /var/lib/boostos/rag/chroma
install -d -m 0755 -o "$LINUX_USER" -g "$LINUX_USER" /var/lib/boostos/rag/models
install -d -m 0755 /opt/boostos/rag

# ── Python virtualenv ─────────────────────────────────────────────────────────
VENV="/opt/boostos/rag/venv"

echo "==> Creating Python venv at $VENV"
python3 -m venv "$VENV"

echo "==> Installing PyTorch (CPU-only, avoids ~800MB CUDA wheels)"
"$VENV/bin/pip" install --quiet --no-cache-dir \
  torch --index-url https://download.pytorch.org/whl/cpu

echo "==> Installing RAG daemon dependencies"
"$VENV/bin/pip" install --quiet --no-cache-dir \
  "sentence-transformers==3.4.1" \
  "chromadb==0.6.3" \
  "watchdog==6.0.0" \
  "fastapi==0.115.0" \
  "uvicorn[standard]==0.34.0" \
  "click==8.1.8" \
  "httpx==0.28.0" \
  "mcp>=1.0.0"

# ── Install source package ────────────────────────────────────────────────────
echo "==> Installing boostos_rag package"
"$VENV/bin/pip" install --quiet --no-cache-dir -e /opt/boostos/src

# ── Pre-download embedding model ──────────────────────────────────────────────
echo "==> Downloading embedding model: $EMBEDDING_MODEL"
TRANSFORMERS_CACHE=/var/lib/boostos/rag/models \
  "$VENV/bin/python" - "$EMBEDDING_MODEL" <<'PY'
import sys
from sentence_transformers import SentenceTransformer
model_name = sys.argv[1]
print(f"  Loading {model_name}...")
SentenceTransformer(model_name)
print("  Model cached.")
PY
chown -R boostos-rag:boostos-rag /var/lib/boostos/rag/models

# ── Config files ──────────────────────────────────────────────────────────────
echo "==> Installing config files"
install -d -m 0755 /etc/boostos
install -m 0644 /opt/boostos/config/rag/rag.conf /etc/boostos/rag.conf

# Update port in config if non-default
if [[ "$API_PORT" != "7700" ]]; then
  sed -i "s/^http_port = .*/http_port = $API_PORT/" /etc/boostos/rag.conf
fi

# Update model in config if non-default
if [[ "$EMBEDDING_MODEL" != "all-MiniLM-L6-v2" ]]; then
  sed -i "s/^embedding_model = .*/embedding_model = $EMBEDDING_MODEL/" /etc/boostos/rag.conf
fi

# Write default watched-dirs on first provision only (preserve user config on re-runs)
if [[ ! -f /var/lib/boostos/rag/config.json ]]; then
  cat >/var/lib/boostos/rag/config.json <<WDEOF
{
  "version": 1,
  "dirs": [
    {
      "path": "/home/$LINUX_USER",
      "recursive": true,
      "enabled": true
    }
  ]
}
WDEOF
  chown "$LINUX_USER":"$LINUX_USER" /var/lib/boostos/rag/config.json
  chmod 0664 /var/lib/boostos/rag/config.json
fi

# ── CLI wrapper scripts ───────────────────────────────────────────────────────
# The venv console_scripts (boostos-search, boostos-rag) are created by pip install.
# Symlink them into /usr/local/bin so all users can access them.
echo "==> Installing CLI wrappers"
ln -sf "$VENV/bin/boostos-search"  /usr/local/bin/boostos-search
ln -sf "$VENV/bin/boostos-rag"     /usr/local/bin/boostos-rag
ln -sf "$VENV/bin/boostos-proxy"   /usr/local/bin/boostos-proxy
ln -sf "$VENV/bin/boostos-stats"   /usr/local/bin/boostos-stats

# ── Agent-friendly command wrappers ──────────────────────────────────────────
# Shadow ps, ss, df, free  → JSON output by default; --raw for original.
# Shadow grep              → trigram-accelerated recursive search; all else falls through.
echo "==> Installing agent-friendly command wrappers"
VENV_PY="$VENV/bin/python"
for cmd in ps ss df free; do
  cat > "/usr/local/bin/$cmd" <<WRAPPER
#!$VENV_PY
import sys; sys.argv[0] = "$cmd"
from boostos_rag.wrap import main; main()
WRAPPER
  chmod 0755 "/usr/local/bin/$cmd"
done

# grep uses its own module (trigram index, not JSON output)
cat > /usr/local/bin/grep <<GREPWRAP
#!$VENV_PY
from boostos_rag.grep_wrap import main; main()
GREPWRAP
chmod 0755 /usr/local/bin/grep

# ── Systemd services ──────────────────────────────────────────────────────────
echo "==> Registering systemd services"
for svc in boostos-rag boostos-proxy; do
  install -m 0644 "/opt/boostos/config/systemd/${svc}.service" \
    "/etc/systemd/system/${svc}.service"
  sed -i "s/BOOSTOS_LINUX_USER/$LINUX_USER/" "/etc/systemd/system/${svc}.service"
done

# ── Claude Code integration ───────────────────────────────────────────────────
echo "==> Configuring Claude Code integration"

# Global CLAUDE.md so every session knows about BoostOS tools
CLAUDE_DIR="/home/$LINUX_USER/.claude"
install -d -m 0755 -o "$LINUX_USER" -g "$LINUX_USER" "$CLAUDE_DIR"
install -m 0644 -o "$LINUX_USER" -g "$LINUX_USER" \
  /opt/boostos/config/claude/CLAUDE.md \
  "$CLAUDE_DIR/CLAUDE.md"

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  for svc in boostos-proxy boostos-rag; do
    systemctl enable "$svc"
    systemctl restart "$svc" || true
  done
else
  echo "  (systemctl not available — start manually: service boostos-proxy start && service boostos-rag start)"
fi

cat <<EOF

BoostOS Phase 2 provisioning complete.

RAG daemon:      http://127.0.0.1:$API_PORT  (systemctl status boostos-rag)
Search CLI:      boostos-search "JWT token validation"
System cmds:     ps / ss / df / free  (JSON by default; --raw for original)
Agent context:   ~/.claude/CLAUDE.md

The daemon indexes everything under /home/$LINUX_USER automatically.
EOF
