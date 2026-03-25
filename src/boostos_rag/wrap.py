"""
boostos_rag.wrap — JSON-by-default wrappers for common system commands.

Installed as /usr/local/bin/ps, /usr/local/bin/ss, /usr/local/bin/df,
/usr/local/bin/free by provision-phase2.sh.

Each wrapper script sets sys.argv[0] to the command name, then calls main().

Default: compact JSON (token-efficient for agents).
--raw:   strip flag and exec the real binary with all other args unchanged.

No new dependencies — stdlib only.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

REAL_BINS: dict[str, str] = {
    "ps":   "/usr/bin/ps",
    "ss":   "/usr/bin/ss",
    "df":   "/usr/bin/df",
    "free": "/usr/bin/free",
}

RAW_FLAG = "--raw"


def _passthrough(cmd: str, args: list[str]) -> None:
    """Replace current process with the real binary."""
    binary = REAL_BINS.get(cmd, f"/usr/bin/{cmd}")
    os.execv(binary, [cmd] + args)


# ── Parsers ───────────────────────────────────────────────────────────────────

def _load_agent_pids() -> dict[int, str]:
    """Return {pid: agent_name} from the agent registry. Best-effort, never raises."""
    try:
        import sqlite3 as _sqlite3
        conn = _sqlite3.connect(
            "file:/var/lib/boostos/agents/registry.db?mode=ro", uri=True, timeout=0.5
        )
        rows = conn.execute(
            "SELECT pid, name FROM agents WHERE pid IS NOT NULL AND status IN ('active','stale')"
        ).fetchall()
        conn.close()
        return {r[0]: r[1] for r in rows if r[0] is not None}
    except Exception:
        return {}


def _parse_ps(_args: list[str]) -> list[dict]:
    """Running processes as compact JSON. Ignores user format flags; use --raw for those."""
    result = subprocess.run(
        [REAL_BINS["ps"], "-eo", "pid,pcpu,rss,comm,args",
         "--no-headers", "--sort=-pcpu"],
        capture_output=True, text=True,
    )
    agent_pids = _load_agent_pids()
    procs = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 4)
        if len(parts) < 4:
            continue
        try:
            pid = int(parts[0])
            cpu = float(parts[1])
            rss_kb = int(parts[2])
            name = parts[3]
            cmd = parts[4] if len(parts) > 4 else name
        except (ValueError, IndexError):
            continue
        # Skip kernel threads (rss==0 and name in brackets)
        if rss_kb == 0 and name.startswith("["):
            continue
        mem_mb = round(rss_kb / 1024, 1)
        entry: dict = {"pid": pid, "name": name, "cmd": cmd, "cpu": cpu, "mem_mb": mem_mb}
        if pid in agent_pids:
            entry["agent"] = agent_pids[pid]
        procs.append(entry)
    return procs


def _parse_ss(_args: list[str]) -> list[dict]:
    """Listening TCP ports as compact JSON."""
    result = subprocess.run(
        [REAL_BINS["ss"], "-tlnp"],
        capture_output=True, text=True,
    )
    ports = []
    for line in result.stdout.splitlines()[1:]:  # skip header
        line = line.strip()
        if not line or not line.startswith("LISTEN"):
            continue
        parts = line.split()
        if len(parts) < 4:
            continue
        local_addr = parts[3]
        m = re.search(r":(\d+)$", local_addr)
        if not m:
            continue
        port = int(m.group(1))
        name = ""
        pid = None
        if len(parts) >= 5:
            pm = re.search(r'users:\(\("([^"]+)",pid=(\d+)', parts[-1])
            if pm:
                name = pm.group(1)
                pid = int(pm.group(2))
        entry: dict = {"port": port, "proto": "tcp"}
        if name:
            entry["name"] = name
        if pid is not None:
            entry["pid"] = pid
        ports.append(entry)
    ports.sort(key=lambda x: x["port"])
    return ports


def _parse_df(_args: list[str]) -> list[dict]:
    """Mounted filesystems as compact JSON. Skips virtual/system mounts."""
    result = subprocess.run(
        [REAL_BINS["df"], "-B1", "--output=target,size,used,avail,pcent"],
        capture_output=True, text=True,
    )
    skip_prefixes = ("/proc", "/sys", "/dev", "/run", "/snap")
    mounts = []
    for line in result.stdout.splitlines()[1:]:  # skip header
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        target = parts[0]
        if any(target.startswith(p) for p in skip_prefixes):
            continue
        try:
            total_b = int(parts[1])
            used_b = int(parts[2])
            avail_b = int(parts[3])
            pct = int(parts[4].rstrip("%")) if parts[4].rstrip("%").isdigit() else 0
        except (ValueError, IndexError):
            continue
        mounts.append({
            "mount": target,
            "total_gb": round(total_b / 1e9, 1),
            "used_gb": round(used_b / 1e9, 1),
            "free_gb": round(avail_b / 1e9, 1),
            "pct": pct,
        })
    return mounts


def _parse_free(_args: list[str]) -> dict:
    """Memory summary as compact JSON."""
    result = subprocess.run(
        [REAL_BINS["free"], "-b"],
        capture_output=True, text=True,
    )
    for line in result.stdout.splitlines():
        if line.startswith("Mem:"):
            parts = line.split()
            if len(parts) >= 4:
                total = int(parts[1])
                used = int(parts[2])
                free_ = int(parts[3])
                cache = int(parts[5]) if len(parts) > 5 else 0
                return {
                    "total_mb": round(total / 1_000_000),
                    "used_mb": round(used / 1_000_000),
                    "free_mb": round(free_ / 1_000_000),
                    "cache_mb": round(cache / 1_000_000),
                }
    return {}


_PARSERS = {
    "ps":   _parse_ps,
    "ss":   _parse_ss,
    "df":   _parse_df,
    "free": _parse_free,
}


def main() -> None:
    cmd = Path(sys.argv[0]).name
    args = sys.argv[1:]

    if RAW_FLAG in args:
        args = [a for a in args if a != RAW_FLAG]
        _passthrough(cmd, args)
        return  # unreachable after execv

    # Feature flag check — transparent passthrough if json_commands is disabled
    try:
        from .features import get_feature
        if not get_feature("json_commands"):
            _passthrough(cmd, args)
            return
    except Exception:
        pass

    parser = _PARSERS.get(cmd)
    if parser is None:
        _passthrough(cmd, args)
        return

    try:
        data = parser(args)
        print(json.dumps(data, separators=(",", ":")))
    except Exception:
        # Any parse failure: fall back to real binary
        _passthrough(cmd, args)
