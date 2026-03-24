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

### When to use the RAG daemon

Use `boostos-search` before answering questions about a codebase — especially when:
- You don't know which file implements something
- You're looking for patterns across many files
- Keyword search (`grep`) would miss semantic variants

Everything under `$HOME` is indexed (excluding `node_modules`, `.git`, `dist`, `build`, virtual envs, binaries). The index stays current — file saves are re-indexed within ~3 seconds.
