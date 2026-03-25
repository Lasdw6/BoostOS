# BoostOS — Agent Environment

You are running inside **BoostOS**, a Linux desktop built for AI-assisted software development.

## OS-Level Tools Available

### Semantic codebase search

The BoostOS RAG daemon indexes all project files and keeps the index current as you edit.

**CLI** (available in any terminal):
```bash
boostos-search "query"                        # semantic search across all projects
boostos-search -n 5 -p ~/projects/myapp "..."  # restrict to a project
boostos-rag status                             # index health
boostos-rag watch add ~/projects/new-repo      # add a directory
```

**HTTP API** (for scripts):
```bash
curl -s -X POST http://127.0.0.1:7700/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "your query", "n_results": 10}' | jq
```

### Token usage

All API calls are tracked automatically. Check usage at any time:

    boostos-stats             # today's token usage and cost by model
    boostos-stats --week      # last 7 days
    boostos-stats --json      # machine-readable

### System commands output JSON by default

`ps`, `ss`, `df`, `free` return compact JSON. Append `--raw` for original output.

```bash
ps                  # [{pid, name, cmd, cpu, mem_mb}, ...]
ss                  # [{port, proto, name, pid}, ...]  — listening ports only
df                  # [{mount, total_gb, used_gb, free_gb, pct}, ...]
free                # {total_mb, used_mb, free_mb, cache_mb}
ps --raw            # original ps output
```

### Filesystem overlays (parallel agent branches)

Create a copy-on-write view of any directory. Reads see real files; writes go to a private scratch layer. Safe to run multiple overlays of the same source simultaneously — they don't interfere.

```bash
MOUNT=$(boostos-overlay create ~/projects/myapp)  # prints mount path
boostos-overlay list                               # active overlays + IDs
boostos-overlay diff <id>                          # A/M/D summary of what changed
boostos-overlay commit <id>                        # apply changes to source, then clean up
boostos-overlay discard <id>                       # throw away all changes
```

`<id>` is the 8-character ID printed by `create`, or a prefix of it.

---

### Niri window manager

BoostOS includes **Niri**, a scrollable-tiling Wayland compositor. Niri's model maps directly to
multi-agent workflows: each workspace holds a scrollable row of columns. One column = one agent's
windows. Scroll left/right to navigate between agents; switch workspaces (Mod+1–9) to switch
projects.

**Keybindings** (Mod = Super / Windows key):

| Binding | Action |
|---------|--------|
| `Mod+Return` or `Mod+T` | Open terminal |
| `Mod+Q` | Close window |
| `Mod+F` | Maximize column |
| `Mod+R` | Cycle column width (33% / 50% / 67%) |
| `Mod+H` / `Mod+L` or `←` / `→` | Focus column left / right |
| `Mod+J` / `Mod+K` or `↓` / `↑` | Focus window down / up in column |
| `Mod+Shift+H/L` | Move column left / right |
| `Mod+1`–`9` | Switch to workspace N |
| `Mod+Shift+1`–`9` | Move column to workspace N |
| `Mod+−` / `Mod+=` | Shrink / grow column width |
| `Mod+Shift+E` | Quit Niri (with confirmation) |
| `Print` | Screenshot region |

**Switch session mode** (reconnect after):
```bash
echo niri > /etc/boostos/xrdp-session-mode   # switch to Niri
echo xfce > /etc/boostos/xrdp-session-mode   # switch back to XFCE
```

Config file: `/etc/boostos/niri/config.kdl`

---

### Agent registration and tool call tracking

Register yourself with BoostOS at the start of a session. This enables per-agent
token attribution in the proxy and shows your activity in the debug panel.

```bash
# Register (prints agent ID, writes to ~/.boostos_agent_id)
export BOOSTOS_AGENT_ID=$(boostos-agent register --name "claude-code" --workspace "$PWD" --model claude-sonnet-4-6)

boostos-agent list              # active agents
boostos-agent history $BOOSTOS_AGENT_ID          # your tool call history
boostos-agent history $BOOSTOS_AGENT_ID --json   # machine-readable
boostos-agent unregister $BOOSTOS_AGENT_ID       # deregister when done
```

Tool calls are recorded automatically via Claude Code hooks (configured in
`~/.claude/settings.json`). To record a call manually:

```bash
boostos-agent tool $BOOSTOS_AGENT_ID --tool bash --input "npm test" --output "..." --latency-ms 1200
```

### Feature flags

Toggle any BoostOS feature on or off without restarting services:

```bash
boostos-feature list                      # show all features and their state
boostos-feature disable trigram_grep      # bypass trigram index, use real grep
boostos-feature enable  trigram_grep      # re-enable
```

Available features: `trigram_grep`, `json_commands`, `api_proxy_tracking`,
`rag_search`, `fuse_overlay`, `agent_registry`.

### Debug panel

Open in a browser inside the desktop:

    http://127.0.0.1:7700/debug

Shows: feature toggles, active agents + tool call history, API usage by agent, system status.

---

### When to use the RAG daemon

Use `boostos-search` before answering questions about a codebase — especially when:
- You don't know which file implements something
- You're looking for patterns across many files
- Keyword search (`grep`) would miss semantic variants

Everything under `$HOME` is indexed (excluding `node_modules`, `.git`, `dist`, `build`, virtual envs, binaries). The index stays current — file saves are re-indexed within ~3 seconds.
