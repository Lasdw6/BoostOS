# BoostOS Phase 2: RAG Daemon

## Goal

Give AI agents running inside BoostOS better codebase awareness than agents running outside it, by providing a background semantic search service over project files.

**Milestone:** `boostos-search "JWT token validation"` returns the exact file and line range where a concept lives, including results that keyword search would miss.

---

## Architecture

The RAG daemon is a single Python process managed by systemd:

```
[File System]
     │  inotify events (watchdog)
     ▼
[Change Queue (asyncio)] → [Indexer Worker]
                                 │
                          chunk → embed → upsert
                                 │
                           [ChromaDB (disk)]
                                 │
                     ┌───────────┴───────────┐
              [FastAPI HTTP :7700]      [CLI tools]
                     │                  boostos-search
              POST /search              boostos-rag
              GET  /status
              POST /watched  ...
```

**Startup sequence:**
1. Load embedding model into memory (~300ms for MiniLM-L6-v2)
2. Full scan of all watched directories → chunk → embed → store
3. Start watchdog inotify observer (background thread)
4. Start indexer worker (asyncio background task, drains change queue)
5. Start FastAPI/uvicorn HTTP server
6. Signal systemd `READY=1`

File edits are re-indexed within ~3 seconds of saving.

---

## Stack

| Component | Library | Notes |
|-----------|---------|-------|
| Embeddings | `sentence-transformers` + `all-MiniLM-L6-v2` | 22MB model, CPU-only, fully offline |
| Vector store | `chromadb` embedded | SQLite + HNSW, persists to `/var/lib/boostos/rag/chroma/` |
| File watching | `watchdog` | Uses Linux inotify natively in WSL2 |
| HTTP API | `fastapi` + `uvicorn` | Auto OpenAPI docs at `/docs` |
| CLI | `click` + `httpx` | Talks to HTTP API |

---

## Installation

### Fresh install with Phase 1 + Phase 2

```powershell
# From an elevated PowerShell on Windows:
.\scripts\windows\install-boostos.ps1 -Phase2
```

### Add Phase 2 to an existing Phase 1 install

```powershell
# Copy updated assets into the distro then run Phase 2 provisioning
.\scripts\windows\connect-boostos.ps1   # ensure distro is running
wsl -d BoostOS -u root -- bash -lc "sudo /opt/boostos/scripts/provision-phase2.sh --user boost"
```

---

## Configuration

### `/etc/boostos/rag.conf`

```ini
[daemon]
http_host = 127.0.0.1
http_port = 7700
chroma_path = /var/lib/boostos/rag/chroma
models_path = /var/lib/boostos/rag/models
watch_config_path = /var/lib/boostos/rag/config.json
embedding_model = all-MiniLM-L6-v2
log_level = INFO
```

### `/var/lib/boostos/rag/config.json`

Watched directories. Managed by `boostos-rag watch add/remove` — editing manually requires a daemon restart.

```json
{
  "version": 1,
  "dirs": [
    { "path": "/home/boost/projects", "recursive": true, "enabled": true }
  ]
}
```

---

## HTTP API

Base URL: `http://127.0.0.1:7700`

Interactive docs: `http://127.0.0.1:7700/docs`

### `GET /status`

```json
{
  "status": "ready",
  "version": "0.2.0",
  "total_chunks": 18432,
  "watched_dirs": ["/home/boost/projects"],
  "embedding_model": "all-MiniLM-L6-v2",
  "uptime_seconds": 3612
}
```

`status` is `"starting"` during initial scan, `"ready"` once serving.

### `POST /search`

```json
// Request
{
  "query": "JWT token expiry validation",
  "n_results": 10,
  "path_prefix": "/home/boost/projects/myapp",
  "min_score": 0.3
}

// Response
{
  "results": [
    {
      "file_path": "/home/boost/projects/myapp/src/auth.py",
      "chunk_index": 2,
      "start_line": 45,
      "end_line": 87,
      "language": "python",
      "score": 0.891,
      "content": "def validate_token(token: str) -> dict:\n    ..."
    }
  ],
  "query": "JWT token expiry validation",
  "elapsed_ms": 23
}
```

### `POST /index`

Trigger manual re-index of a path. Returns a `job_id` immediately; indexing runs in the background.

```json
// Request:  { "path": "/home/boost/projects/myapp", "force": false }
// Response: { "job_id": "idx-20260322-143512-abc123", "status": "queued", "path": "..." }
```

Check progress: `GET /index/status/{job_id}`

### `GET /watched` / `POST /watched` / `DELETE /watched/{path}`

List, add, or remove watched directories. Adding a directory triggers immediate indexing.

### `GET /chunks/{file_path}`

Inspect how a specific file was chunked:

```json
{
  "file_path": "/home/boost/projects/myapp/src/auth.py",
  "chunk_count": 5,
  "chunks": [
    { "chunk_index": 0, "start_line": 1, "end_line": 44, "content_preview": "import jwt\n..." }
  ]
}
```

---

## CLI Reference

### `boostos-search`

```
boostos-search [OPTIONS] QUERY

  Semantic search across indexed project files.

Options:
  -n, --results INTEGER     Number of results (default: 10)
  -p, --project PATH        Restrict to a path prefix
  -s, --min-score FLOAT     Min similarity 0.0–1.0 (default: 0.3)
  --json                    Raw JSON output
  --url TEXT                Daemon URL (default: $BOOSTOS_RAG_URL or http://127.0.0.1:7700)
```

Examples:

```bash
boostos-search "database connection pool"
boostos-search -n 5 -p ~/projects/api "rate limiting middleware"
boostos-search --json "error handler" | jq '.results[0].content'
```

### `boostos-rag`

```bash
boostos-rag status                        # health + chunk count
boostos-rag watch list                    # list watched dirs
boostos-rag watch add ~/projects/myapp    # add dir + trigger index
boostos-rag watch remove ~/projects/myapp # remove dir + purge index
boostos-rag index ~/projects/myapp/src    # manual re-index
boostos-rag chunks src/auth.py            # inspect chunks for a file
```

---

## Indexing Rules

### What gets indexed

All valid UTF-8 text files under 512KB that are not in excluded directories or extensions.

Prioritized file types: `.py`, `.ts`, `.js`, `.tsx`, `.jsx`, `.go`, `.rs`, `.java`, `.kt`, `.c`, `.cpp`, `.sh`, `.md`, `.json`, `.yaml`, `.toml`, `.sql`, `.html`, `.css`

### What gets skipped

**Directories:** `.git`, `node_modules`, `__pycache__`, `.venv`, `venv`, `dist`, `build`, `target`, `vendor`, `.next`, `.cache`, `tmp`, `.mypy_cache`, `.ruff_cache`, `coverage`, `htmlcov`

**Extensions:** binaries, images, audio/video, compiled objects, `.lock` files, `.min.js`, `.min.css`

**Files:** `package-lock.json`, `yarn.lock`, `Cargo.lock`, `poetry.lock`, and similar lockfiles

### Chunking strategy

| File type | Strategy |
|-----------|----------|
| Code (`.py`, `.ts`, `.go`, ...) | Split on top-level `def`/`class`/`func`/`function` boundaries; fallback to 40-line windows |
| Prose (`.md`, `.rst`, `.txt`) | Split on paragraph breaks, max 300 words per chunk |
| Config (`.json`, `.yaml`, ...) | Single chunk if <200 lines, else 50-line windows |

---

## Environment Variables

```bash
BOOSTOS_RAG_URL=http://127.0.0.1:7700   # Set automatically in every BoostOS terminal session
```

This is exported by `/etc/profile.d/boostos-session.sh` so Claude Code and other agents running inside BoostOS can discover the daemon without any configuration.

---

## Demo: Showing the Advantage

### Setup

```bash
# Clone a real project inside BoostOS
mkdir -p ~/projects && cd ~/projects
git clone https://github.com/fastapi/fastapi.git
# Wait for the daemon to auto-index it (~30s for a medium repo)
boostos-rag status    # confirm chunk count > 0
```

### Comparison

**Keyword search (available anywhere):**
```bash
rg "token expiry" ~/projects/fastapi
# Returns only files with that exact phrase
```

**Semantic search (BoostOS only):**
```bash
boostos-search "JWT token expiry validation"
# Returns semantically related chunks: validate_token(), decode_jwt(),
# even files mentioning "expire", "exp claim", "token lifetime" — no exact phrase needed
```

### Agent integration

Inside BoostOS, Claude Code (or any agent) can call the search directly:

```bash
# From a terminal inside the BoostOS desktop:
boostos-search --json "database connection pooling" | \
  jq -r '.results[] | "\(.score) \(.file_path):\(.start_line)-\(.end_line)"'
```

The `BOOSTOS_RAG_URL` env var is already set, so the agent can also hit the HTTP API directly:

```bash
curl -s -X POST http://127.0.0.1:7700/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "authentication middleware", "n_results": 5}' | jq
```

---

## Storage Layout

```
/opt/boostos/
  src/boostos_rag/    # Python package source
  rag/
    venv/             # Python virtualenv (~1.8GB, dominated by PyTorch CPU)
  config/
    rag/              # rag.conf and watched-dirs.json templates
    systemd/          # boostos-rag.service

/var/lib/boostos/rag/
  chroma/             # ChromaDB vector store (SQLite + HNSW index)
  models/             # Cached sentence-transformer model weights (~22MB)
  config.json         # Active watched directories

/etc/boostos/
  rag.conf            # Active runtime configuration

/usr/local/bin/
  boostos-search      # CLI wrapper
  boostos-rag         # CLI wrapper
```

---

## Service Management

```bash
# Inside BoostOS:
systemctl status boostos-rag
systemctl restart boostos-rag
journalctl -u boostos-rag -f      # live logs

# Reload watched dirs without restart:
kill -HUP $(systemctl show -p MainPID boostos-rag | cut -d= -f2)
```

---

## Deliverables in This Repo

- [`src/boostos_rag/`](/C:/Desktop/Boost/BoostOS/src/boostos_rag/) — Python daemon source
- [`src/pyproject.toml`](/C:/Desktop/Boost/BoostOS/src/pyproject.toml) — Package metadata
- [`config/rag/rag.conf`](/C:/Desktop/Boost/BoostOS/config/rag/rag.conf) — Default config template
- [`config/rag/watched-dirs.json`](/C:/Desktop/Boost/BoostOS/config/rag/watched-dirs.json) — Default watched dirs
- [`config/systemd/boostos-rag.service`](/C:/Desktop/Boost/BoostOS/config/systemd/boostos-rag.service) — systemd unit
- [`scripts/linux/provision-phase2.sh`](/C:/Desktop/Boost/BoostOS/scripts/linux/provision-phase2.sh) — Guest provisioning
- [`scripts/windows/install-boostos.ps1`](/C:/Desktop/Boost/BoostOS/scripts/windows/install-boostos.ps1) — Updated with `-Phase2` flag
