"""
boostos_rag.trigram — Trigram index backed by SQLite (WAL mode).

Written by the indexer daemon; read by the grep wrapper.
SQLite WAL mode allows concurrent reads from the grep wrapper
while the daemon is writing, with no locking needed on the reader side.

Trigram search works by:
  1. Extracting every 3-character sequence from each file's text.
  2. Storing (trigram, file_id) pairs in a fast-lookup table.
  3. At query time: find files containing ALL required trigrams
     (intersection), then let real grep verify actual matches.

The index can only *prune* candidates — real grep is always the
final arbiter, so the index can never produce false negatives as
long as every file in the watched directories has been indexed.
"""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Optional

_db: Optional[sqlite3.Connection] = None

_SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    path  TEXT    NOT NULL UNIQUE,
    mtime REAL    NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS trigrams (
    trigram TEXT    NOT NULL,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    PRIMARY KEY (trigram, file_id)
);
CREATE INDEX IF NOT EXISTS idx_trigrams ON trigrams(trigram);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def init(db_path: str) -> None:
    """Open (or create) the trigram database. Called once by the daemon."""
    global _db
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    _db = sqlite3.connect(db_path, check_same_thread=False)
    _db.execute("PRAGMA journal_mode=WAL")
    _db.execute("PRAGMA synchronous=NORMAL")
    _db.execute("PRAGMA foreign_keys=ON")
    _db.executescript(_SCHEMA)
    _db.commit()


def _conn() -> sqlite3.Connection:
    if _db is None:
        raise RuntimeError("trigram store not initialised — call init() first")
    return _db


def extract_trigrams(text: str) -> set[str]:
    """Return every lowercase 3-character sequence in text."""
    t = text.lower()
    return {t[i: i + 3] for i in range(len(t) - 2)} if len(t) >= 3 else set()


def index_file(path: str, text: str) -> None:
    """Store trigrams for a file, replacing any previous entry. Silent no-op on any error."""
    if _db is None:
        return
    try:
        _index_file_inner(path, text)
    except Exception:
        pass


def _index_file_inner(path: str, text: str) -> None:
    db = _conn()
    tris = extract_trigrams(text)
    try:
        mtime = Path(path).stat().st_mtime
    except OSError:
        mtime = 0.0

    with db:
        db.execute(
            "INSERT INTO files(path, mtime) VALUES(?,?) "
            "ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime",
            (path, mtime),
        )
        file_id = db.execute(
            "SELECT id FROM files WHERE path=?", (path,)
        ).fetchone()[0]
        db.execute("DELETE FROM trigrams WHERE file_id=?", (file_id,))
        if tris:
            db.executemany(
                "INSERT OR IGNORE INTO trigrams(trigram, file_id) VALUES(?,?)",
                [(t, file_id) for t in tris],
            )
        db.execute(
            "INSERT INTO meta(key,value) VALUES('last_indexed',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(time.time()),),
        )


def delete_file(path: str) -> None:
    """Remove a file and its trigrams from the index. No-op if not initialised."""
    if _db is None:
        return
    db = _conn()
    with db:
        # ON DELETE CASCADE removes trigram rows automatically
        db.execute("DELETE FROM files WHERE path=?", (path,))


def mark_scan_complete(directory: str) -> None:
    """Record that a full scan of *directory* has completed. No-op if not initialised."""
    if _db is None:
        return
    db = _conn()
    key = f"scan_complete:{directory}"
    with db:
        db.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(time.time())),
        )
