export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export EDITOR="${EDITOR:-code}"
export VISUAL="${VISUAL:-code}"

USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6 2>/dev/null || true)"
if [ -n "$USER_HOME" ]; then
  export HOME="$USER_HOME"
fi

if [ -n "${XRDP_SESSION:-}" ]; then
  export TERM="${TERM:-xterm-256color}"
  unset WAYLAND_DISPLAY
  unset WAYLAND_SOCKET
  unset SWAYSOCK
  export XDG_SESSION_TYPE="x11"
  export GDK_BACKEND="x11"
  export QT_QPA_PLATFORM="xcb"
fi

# BoostOS RAG daemon — agents use this to find the search API
export BOOSTOS_RAG_URL="${BOOSTOS_RAG_URL:-http://127.0.0.1:7700}"

# BoostOS API proxy — routes Anthropic/OpenAI calls through local token counter
# Agents don't need to configure anything; these vars are picked up automatically
# by the Anthropic and OpenAI SDKs. Use --raw or unset to bypass.
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-http://127.0.0.1:7701}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://127.0.0.1:7701}"

if [ -n "${HOME:-}" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # Load the default Node installation for login shells and editor terminals.
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
