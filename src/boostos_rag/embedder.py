from __future__ import annotations

from typing import Optional

_model = None
_model_name: Optional[str] = None

BATCH_SIZE = 32


def load_model(model_name: str, cache_folder: Optional[str] = None) -> None:
    global _model, _model_name
    from sentence_transformers import SentenceTransformer

    kwargs: dict = {}
    if cache_folder:
        kwargs["cache_folder"] = cache_folder

    _model = SentenceTransformer(model_name, **kwargs)
    _model_name = model_name


def embed(texts: list[str]) -> list[list[float]]:
    if _model is None:
        raise RuntimeError("Embedder not initialized — call load_model() first")

    results: list[list[float]] = []
    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i : i + BATCH_SIZE]
        vecs = _model.encode(batch, convert_to_numpy=True, show_progress_bar=False)
        results.extend(v.tolist() for v in vecs)
    return results


def embed_one(text: str) -> list[float]:
    return embed([text])[0]
