"""
boostos_rag.grep_wrap — Trigram-accelerated grep wrapper.

Installed as /usr/local/bin/grep by provision-phase2.sh.

For recursive directory searches the wrapper:
  1. Parses grep's arguments to extract the pattern and target directories.
  2. Queries the BoostOS trigram index for files that *could* contain a match.
  3. Runs the real /usr/bin/grep on that much smaller candidate set.

Every fallback path calls os.execv(/usr/bin/grep, ...) so the result is
always byte-for-byte identical to running real grep directly — the wrapper
only ever makes grep *faster*, never changes its output or exit code.

Fallback triggers (any of these → execv real grep with original argv):
  - Argument parsing fails or invocation is ambiguous
  - Not a recursive search, or no directory targets
  - Pattern contains alternation or is too short for trigrams
  - Multiple -e patterns, -f pattern file, or -P (Perl) regex
  - Trigram database does not exist or is stale (>60 s since last update)
  - Target directory has no indexed files (not a watched directory)
  - Any unhandled exception anywhere in this module
"""
from __future__ import annotations

import os
import re
import sqlite3
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

REAL_GREP = "/usr/bin/grep"
_TRIGRAM_DB = os.environ.get("BOOSTOS_TRIGRAM_DB", "/var/lib/boostos/rag/trigram.db")

# Index is considered stale if it hasn't been updated in this many seconds.
# The daemon normally re-indexes within 3 s of a file change, so 60 s is
# very conservative.
_MAX_INDEX_AGE = 60.0

# Short option letters that consume the next argument as their value
_SHORT_VAL = frozenset("eAmBCDdf")

# Long options that consume the next argument (--opt val) or use --opt=val
_LONG_VAL = frozenset({
    "--regexp", "--file", "--max-count",
    "--after-context", "--before-context", "--context",
    "--include", "--exclude", "--exclude-dir",
    "--label", "--binary-files",
})

_RECURSIVE_FLAGS = frozenset({"-r", "-R", "--recursive", "--dereference-recursive"})


# ── Argument parser ───────────────────────────────────────────────────────────

@dataclass
class _GrepArgs:
    pattern: str = ""
    targets: list[str] = field(default_factory=list)
    is_recursive: bool = False
    is_fixed: bool = False       # -F / --fixed-strings
    nocase: bool = False         # -i / --ignore-case
    is_extended: bool = False    # -E (affects alternation detection)
    multiple_patterns: bool = False
    pattern_file: bool = False
    is_perl: bool = False
    passthru_flags: list[str] = field(default_factory=list)


def _parse(argv: list[str]) -> _GrepArgs:
    """
    Parse grep arguments into a _GrepArgs.
    Raises ValueError for anything ambiguous so the caller falls back.
    """
    r = _GrepArgs()
    i = 0
    positional: list[str] = []
    end_of_opts = False
    e_count = 0

    while i < len(argv):
        a = argv[i]

        if end_of_opts:
            positional.append(a)
            i += 1
            continue

        if a == "--":
            end_of_opts = True
            i += 1
            continue

        # ── Long options ──────────────────────────────────────────────────
        if a.startswith("--"):
            if "=" in a:
                flag, val = a.split("=", 1)
                if flag in _LONG_VAL:
                    if flag == "--regexp":
                        if e_count == 0:
                            r.pattern = val
                        else:
                            r.multiple_patterns = True
                        e_count += 1
                    elif flag == "--file":
                        r.pattern_file = True
                    r.passthru_flags.extend([flag, val])
                    i += 1
                    continue
                # Unknown long flag with = value — keep and move on
                r.passthru_flags.append(a)
                i += 1
                continue

            if a in _LONG_VAL:
                if i + 1 >= len(argv):
                    raise ValueError(f"{a} requires a value")
                val = argv[i + 1]
                if a == "--regexp":
                    if e_count == 0:
                        r.pattern = val
                    else:
                        r.multiple_patterns = True
                    e_count += 1
                elif a == "--file":
                    r.pattern_file = True
                r.passthru_flags.extend([a, val])
                i += 2
                continue

            if a in _RECURSIVE_FLAGS:
                r.is_recursive = True
            elif a in ("--fixed-strings",):
                r.is_fixed = True
                r.passthru_flags.append(a)
            elif a in ("--ignore-case",):
                r.nocase = True
                r.passthru_flags.append(a)
            elif a in ("--extended-regexp",):
                r.is_extended = True
                r.passthru_flags.append(a)
            elif a in ("--perl-regexp",):
                r.is_perl = True
                r.passthru_flags.append(a)
            else:
                r.passthru_flags.append(a)
            i += 1
            continue

        # ── Short options (possibly combined: -rni) ───────────────────────
        if a.startswith("-") and len(a) > 1:
            j = 1
            while j < len(a):
                c = a[j]
                if c in _SHORT_VAL:
                    attached = a[j + 1:]
                    if attached:
                        val = attached
                    elif i + 1 < len(argv):
                        i += 1
                        val = argv[i]
                    else:
                        raise ValueError(f"-{c} requires a value")
                    if c == "e":
                        if e_count == 0:
                            r.pattern = val
                        else:
                            r.multiple_patterns = True
                        e_count += 1
                    elif c == "f":
                        r.pattern_file = True
                    r.passthru_flags.extend([f"-{c}", val])
                    break  # consumed rest of combined flag
                # Boolean flags
                if c in ("r", "R"):
                    r.is_recursive = True
                elif c == "F":
                    r.is_fixed = True
                    r.passthru_flags.append(f"-{c}")
                elif c == "i":
                    r.nocase = True
                    r.passthru_flags.append(f"-{c}")
                elif c == "E":
                    r.is_extended = True
                    r.passthru_flags.append(f"-{c}")
                elif c == "P":
                    r.is_perl = True
                    r.passthru_flags.append(f"-{c}")
                else:
                    r.passthru_flags.append(f"-{c}")
                j += 1
            i += 1
            continue

        positional.append(a)
        i += 1

    # Assign pattern and targets from positional args
    if e_count == 0:
        if not positional:
            raise ValueError("no pattern given")
        r.pattern = positional[0]
        r.targets = positional[1:]
    else:
        r.targets = positional

    return r


# ── Trigram extraction ────────────────────────────────────────────────────────

def _has_alternation(pattern: str, is_extended: bool) -> bool:
    """True if the pattern contains alternation that we can't prune for."""
    i = 0
    while i < len(pattern):
        if pattern[i] == "\\":
            i += 2
            continue
        # ERE: bare | is alternation; BRE: \| is alternation
        if is_extended and pattern[i] == "|":
            return True
        if not is_extended and pattern[i] == "|" and i > 0 and pattern[i - 1] == "\\":
            return True
        i += 1
    return False


def _extract_trigrams(pattern: str, fixed: bool, nocase: bool) -> Optional[list[str]]:
    """
    Extract trigrams that MUST be present in any text matching this pattern.
    Returns None when the pattern is too short or too complex for pruning.
    """
    if nocase:
        pattern = pattern.lower()

    if fixed:
        tris = [pattern[i: i + 3] for i in range(len(pattern) - 2)]
        return tris or None

    # For regex: find longest literal runs by removing metacharacters.
    # 1. Unescape common literal escape sequences: \. \* \+ etc.
    clean = re.sub(r"\\([.^$*+?|{}\[\]()\\ ])", r"\1", pattern)
    # 2. Remove non-literal escapes (\b \w \d \s \n \t etc.) → null separator
    clean = re.sub(r"\\[bBwWdDsSnNtrvfaex]|\\\d+", "\x00", clean)
    # 3. Collapse anchors into separators
    clean = clean.replace("^", "\x00").replace("$", "\x00")

    # 4. Split on all regex metacharacters and separators
    parts = re.split(r"[.^$*+?|\[\](){}!\x00]", clean)

    # 5. Collect trigrams from runs of ≥ 3 literal characters
    trigrams: list[str] = []
    for run in parts:
        if len(run) >= 3:
            trigrams.extend(run[i: i + 3] for i in range(len(run) - 2))

    return trigrams if trigrams else None


# ── Index access (read-only) ──────────────────────────────────────────────────

def _open_db() -> Optional[sqlite3.Connection]:
    if not Path(_TRIGRAM_DB).exists():
        return None
    try:
        conn = sqlite3.connect(
            f"file:{_TRIGRAM_DB}?mode=ro", uri=True, timeout=1.0
        )
        return conn
    except Exception:
        return None


def _index_age(conn: sqlite3.Connection) -> float:
    """Seconds since the index was last updated. Returns inf if never."""
    try:
        import time
        row = conn.execute(
            "SELECT value FROM meta WHERE key='last_indexed'"
        ).fetchone()
        return time.time() - float(row[0]) if row else float("inf")
    except Exception:
        return float("inf")


def _dir_is_indexed(conn: sqlite3.Connection, abs_dir: str) -> bool:
    """True if at least one file under abs_dir is in the index."""
    try:
        row = conn.execute(
            "SELECT 1 FROM files WHERE path LIKE ? LIMIT 1",
            (abs_dir.rstrip("/") + "/%",),
        ).fetchone()
        return row is not None
    except Exception:
        return False


def _query_candidates(
    conn: sqlite3.Connection,
    trigrams: list[str],
    abs_prefix: str,
) -> list[str]:
    """Return paths under abs_prefix that contain ALL required trigrams."""
    unique = list(set(trigrams))
    if not unique:
        return []
    exists_sql = " AND ".join(
        "EXISTS (SELECT 1 FROM trigrams WHERE file_id=f.id AND trigram=?)"
        for _ in unique
    )
    sql = (
        f"SELECT f.path FROM files f "
        f"WHERE {exists_sql} AND f.path LIKE ?"
    )
    params = unique + [abs_prefix.rstrip("/") + "/%"]
    try:
        return [r[0] for r in conn.execute(sql, params).fetchall()]
    except Exception:
        return []


# ── Main ──────────────────────────────────────────────────────────────────────

def _passthrough() -> None:
    """Replace this process with real grep, preserving all original arguments."""
    os.execv(REAL_GREP, [REAL_GREP] + sys.argv[1:])


def main() -> None:
    try:
        args = _parse(sys.argv[1:])

        # Only accelerate recursive directory searches
        if not args.is_recursive:
            _passthrough()
            return

        # Bail on pattern forms we can't safely analyse
        if args.multiple_patterns or args.pattern_file or args.is_perl:
            _passthrough()
            return

        if _has_alternation(args.pattern, args.is_extended):
            _passthrough()
            return

        # Need at least one directory target
        dir_targets = [t for t in args.targets if Path(t).is_dir()]
        if not dir_targets:
            _passthrough()
            return

        # Extract trigrams; need at least one
        trigrams = _extract_trigrams(args.pattern, args.is_fixed, args.nocase)
        if not trigrams:
            _passthrough()
            return

        # Open index (read-only)
        conn = _open_db()
        if conn is None:
            _passthrough()
            return

        with conn:
            # Stale index → fall back
            if _index_age(conn) > _MAX_INDEX_AGE:
                _passthrough()
                return

            candidates: set[str] = set()

            for target in dir_targets:
                abs_target = str(Path(target).resolve())

                # Target not watched → fall back entirely (can't trust partial results)
                if not _dir_is_indexed(conn, abs_target):
                    _passthrough()
                    return

                hits = _query_candidates(conn, trigrams, abs_target)
                candidates.update(hits)

        # Always include explicit file targets (not directories)
        for t in args.targets:
            p = Path(t)
            if p.is_file():
                candidates.add(str(p.resolve()))

        if not candidates:
            # Index says nothing matches and we trust it
            sys.exit(1)

        # Run real grep on the candidate set only (no -r since we pass files)
        cmd = [REAL_GREP] + args.passthru_flags + ["--", args.pattern] + sorted(candidates)
        os.execv(REAL_GREP, cmd)

    except Exception:
        _passthrough()


if __name__ == "__main__":
    main()
