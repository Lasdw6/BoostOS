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

# BoostOS agent registry — load agent ID from registration file so Claude Code
# hooks (hook-pre / hook-post) attribute tool calls to the correct agent.
# Agents set this by running: export BOOSTOS_AGENT_ID=$(boostos-agent register --name "...")
_AGENT_ID_FILE="${HOME}/.boostos_agent_id"
if [ -z "${BOOSTOS_AGENT_ID:-}" ] && [ -s "${_AGENT_ID_FILE}" ]; then
  export BOOSTOS_AGENT_ID="$(cat "${_AGENT_ID_FILE}")"
fi
unset _AGENT_ID_FILE

# When BOOSTOS_AGENT_ID is set, inject it into API calls via header so the
# proxy can attribute token usage to the correct agent.
if [ -n "${BOOSTOS_AGENT_ID:-}" ]; then
  export ANTHROPIC_ADDITIONAL_HEADERS="${ANTHROPIC_ADDITIONAL_HEADERS:-} X-Agent-ID: ${BOOSTOS_AGENT_ID}"
fi

if [ -n "${HOME:-}" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # Load the default Node installation for login shells and editor terminals.
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
