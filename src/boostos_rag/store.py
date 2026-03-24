from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Optional

_client = None
_collection = None

COLLECTION_NAME = "boostos_code"


def init(chroma_path: str) -> None:
    global _client, _collection
    import chromadb

    Path(chroma_path).mkdir(parents=True, exist_ok=True)
    _client = chromadb.PersistentClient(path=chroma_path)
    _collection = _client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )


def _chunk_id(file_path: str, chunk_index: int) -> str:
    prefix = hashlib.sha256(file_path.encode()).hexdigest()[:16]
    return f"{prefix}:{chunk_index}"


def upsert(
    file_path: str,
    chunk_index: int,
    embedding: list[float],
    content: str,
    start_line: int,
    end_line: int,
    language: str,
) -> None:
    if _collection is None:
        raise RuntimeError("Store not initialized — call init() first")
    _collection.upsert(
        ids=[_chunk_id(file_path, chunk_index)],
        embeddings=[embedding],
        documents=[content],
        metadatas=[{
            "file_path": file_path,
            "chunk_index": chunk_index,
            "start_line": start_line,
            "end_line": end_line,
            "language": language,
        }],
    )


def delete_file(file_path: str) -> int:
    if _collection is None:
        raise RuntimeError("Store not initialized")
    results = _collection.get(where={"file_path": {"$eq": file_path}}, include=[])
    ids = results["ids"]
    if ids:
        _collection.delete(ids=ids)
    return len(ids)


def query(
    embedding: list[float],
    n_results: int = 10,
    path_prefix: Optional[str] = None,
    min_score: float = 0.0,
) -> list[dict[str, Any]]:
    if _collection is None:
        raise RuntimeError("Store not initialized")

    total = _collection.count()
    if total == 0:
        return []

    # Over-fetch when path_prefix filtering is needed, since we filter post-query
    fetch = min(n_results * 4 if path_prefix else n_results, total)

    results = _collection.query(
        query_embeddings=[embedding],
        n_results=fetch,
        include=["documents", "metadatas", "distances"],
    )

    output: list[dict[str, Any]] = []
    for doc, meta, dist in zip(
        results["documents"][0],
        results["metadatas"][0],
        results["distances"][0],
    ):
        # ChromaDB cosine distance: 0 = identical → score = 1.0 - dist/2
        score = round(1.0 - dist / 2.0, 4)
        if score < min_score:
            continue
        if path_prefix and not meta["file_path"].startswith(path_prefix):
            continue
        output.append({
            "file_path": meta["file_path"],
            "chunk_index": int(meta["chunk_index"]),
            "start_line": int(meta["start_line"]),
            "end_line": int(meta["end_line"]),
            "language": meta["language"],
            "score": score,
            "content": doc,
        })

    output.sort(key=lambda x: x["score"], reverse=True)
    return output[:n_results]


def total_chunks() -> int:
    return _collection.count() if _collection else 0


def file_chunk_count(file_path: str) -> int:
    if _collection is None:
        return 0
    results = _collection.get(where={"file_path": {"$eq": file_path}}, include=[])
    return len(results["ids"])


def get_file_chunks(file_path: str) -> list[dict[str, Any]]:
    if _collection is None:
        return []
    results = _collection.get(
        where={"file_path": {"$eq": file_path}},
        include=["documents", "metadatas"],
    )
    chunks = []
    for doc, meta in zip(results["documents"], results["metadatas"]):
        chunks.append({
            "chunk_index": int(meta["chunk_index"]),
            "start_line": int(meta["start_line"]),
            "end_line": int(meta["end_line"]),
            "content_preview": doc[:200] + ("…" if len(doc) > 200 else ""),
        })
    chunks.sort(key=lambda x: x["chunk_index"])
    return chunks
