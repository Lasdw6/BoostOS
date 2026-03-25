# Coding Tool Storage Research

> Findings from exploring installed tools in BoostOS WSL2 distro.
> Goal: understand what chat/session data each tool stores locally and how to extract it.

---

## Tools Found

| Tool | Version | Executable | Status |
|------|---------|------------|--------|
| Cursor | 2.6.20 | `/usr/share/cursor/cursor` → `/usr/local/bin/cursor` | Running |
| VS Code | latest | `/usr/share/code/` → `/usr/local/bin/code` | Installed |
| Claude Desktop | 2.1.81 | `~/.local/share/claude/versions/2.1.81` → `~/.local/bin/claude` | Installed |

---

## Cursor

### Directory layout

```
~/.cursor/
├── ai-tracking/
│   └── ai-code-tracking.db          ← SQLite, 76KB
├── projects/
│   └── <workspace-slug>/
│       ├── agent-transcripts/
│       │   └── <session-uuid>/
│       │       └── <session-uuid>.jsonl   ← one file per session
│       └── terminals/
│           └── <pid>.txt
└── argv.json

~/.config/Cursor/User/
├── globalStorage/
│   ├── state.vscdb                  ← SQLite, 1.2MB
│   └── storage.json
└── workspaceStorage/
    └── <workspace-hash>/
        └── state.vscdb
```

### Agent transcript format (JSONL)

Each line is one turn:

```json
{"role":"user","message":{"content":[{"type":"text","text":"can you pull the latest changes"}]}}
{"role":"assistant","message":{"content":[{"type":"text","text":"Pulling the latest changes..."}]}}
```

**New session signal:** new UUID directory appears under `agent-transcripts/`

### SQLite — `ai-code-tracking.db`

| Table | Key columns | Notes |
|-------|-------------|-------|
| `conversation_summaries` | `conversationId`, `title`, `tldr`, `model`, `mode`, `updatedAt` | Best source of session metadata |
| `tracked_file_content` | `gitPath`, `conversationId`, `model`, `fileExtension`, `createdAt` | Files touched per conversation |
| `ai_deleted_files` | `gitPath`, `composerId`, `conversationId`, `model`, `deletedAt` | Deletes attributed to a session |
| `ai_code_hashes` | `hash`, `source`, `fileExtension`, `fileName`, `requestId`, `createdAt` | AI-generated code tracking |
| `scoring_commits` | `conversationId`, `commitHash`, line metrics, `v1AiPercentage` | AI code quality scores |

**Timestamps:** milliseconds since epoch throughout.

### What we can extract
- Session ID, title, summary, model used, mode (agent/chat)
- Files read/written/deleted per session
- Workspace (from directory slug)
- Session start/end time via `updatedAt`

### What we cannot get
- Token counts (Cursor routes through their own backend, not raw Anthropic/OpenAI)
- Cost

---

## VS Code

### Directory layout

```
~/.config/Code/User/
├── globalStorage/
│   ├── emptyWindowChatSessions/
│   │   └── <session-uuid>.jsonl     ← one file per window-level chat
│   ├── state.vscdb                  ← SQLite, 172KB
│   └── storage.json
└── workspaceStorage/
    └── <workspace-hash>/
        ├── chatSessions/
        │   └── <session-uuid>.jsonl ← one file per workspace chat
        ├── chatEditingSessions/
        │   └── <session-uuid>/
        │       └── state.json       ← edit session state + timeline
        └── state.vscdb
```

### Chat session format (JSONL)

First line contains session metadata:

```json
{
  "kind": 0,
  "v": {
    "version": 3,
    "creationDate": 1774102152177,
    "sessionId": "95279111-90a5-4938-95e4-e58c64b410e0",
    "initialLocation": "panel",
    "requests": [],
    "inputState": { "mode": { "id": "agent", "kind": "agent" } }
  }
}
```

**New session signal:** new `.jsonl` file with a fresh `sessionId` UUID

### Edit session state (JSON)

Contains:
- `version`, `initialFileContents`
- `timeline` array with checkpoints
- `operations` (edits applied)
- `recentSnapshot`

### What we can extract
- Session ID, creation timestamp, workspace, mode (agent/chat/edit)
- Full message history (in `requests` array as session progresses)
- Edit operations and file diffs per session

### What we cannot get
- Token counts (GitHub Copilot routes through GitHub; VS Code Chat through Microsoft)
- Cost

---

## Claude Desktop (claude CLI)

### Directory layout

```
~/.claude/
├── .credentials.json       ← API auth
├── settings.json
├── mcp-needs-auth-cache.json
├── sessions/               ← empty (no local session persistence)
├── backups/
│   └── .claude.json.backup.<ms-timestamp>
└── cache/
    └── changelog.md

~/.claude.json              ← main state file, 12KB
```

### What's stored

- **No local chat history.** Sessions are not persisted to disk.
- `.claude.json` contains feature flags, startup count, install metadata, MCP auth cache.
- Backup files in `backups/` are snapshots of `.claude.json` state, timestamped in the filename.
- MCP auth timestamps (`mcp-needs-auth-cache.json`) show last service sync.

**Note:** This is Claude **Desktop** (the GUI app), not Claude **Code** (the CLI agent). Claude Code stores conversation history under `~/.claude/projects/<hash>/*.jsonl` — that path was empty/absent here, meaning no Claude Code sessions have been run yet in this distro.

### What we can extract
- Last active time (backup file mtimes / `.claude.json` mtime)
- MCP service connection state
- Nothing about individual conversations

---

## Detection & Polling Strategy

| Tool | New session signal | Poll target | Interval |
|------|--------------------|-------------|----------|
| Cursor | New UUID dir in `~/.cursor/projects/*/agent-transcripts/` | `ai-code-tracking.db` `conversation_summaries` | 10s |
| VS Code | New `.jsonl` in `chatSessions/` or `emptyWindowChatSessions/` | File mtime + first-line parse | 10s |
| Claude Code | New `.jsonl` in `~/.claude/projects/*/` | File mtime | 5s |
| Claude Desktop | `.claude.json` mtime | Backup file count | 30s |

---

## Token / Cost Tracking Feasibility

| Tool | API routing | Token counts available | Via proxy? |
|------|------------|----------------------|------------|
| Claude Code | Direct to `api.anthropic.com` via SDK | Yes — in API response | Yes, already working |
| Cursor | Through `api2.cursor.sh` (their backend) | No — not exposed | No (cert pinning likely) |
| VS Code Copilot | Through GitHub/Microsoft backends | No | No |
| Claude Desktop | Direct to `api.anthropic.com` via SDK | Yes — in API response | Yes, if `ANTHROPIC_BASE_URL` inherited |

---

## Summary

**Rich local data available (no proxy needed):**
- Cursor — `ai-code-tracking.db` has session metadata, model, workspace, file activity
- VS Code — JSONL chat sessions with timestamps, mode, workspace hash

**Already tracked via proxy:**
- Claude Code — full token/cost tracking via `ANTHROPIC_BASE_URL` proxy

**Nothing useful locally:**
- Claude Desktop — no conversation storage on disk
