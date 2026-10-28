"""Local embedding / rerank sidecar.

Development substitute for HuggingFace TEI. It exposes the same `POST /embed`
shape used by `packages/retrieval`, so the API and worker do not care whether
vectors come from this process or a TEI container.

Default model: BAAI/bge-m3 (1024-d, multilingual). The reranker is loaded
lazily and only when `/rerank` is called, so a basic E2E run does not download
the second model.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("occ-embeddings")

EMBED_MODEL = os.getenv("OCC_EMBED_MODEL", "BAAI/bge-m3")
RERANK_MODEL = os.getenv("OCC_RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
DEVICE = os.getenv("OCC_EMBED_DEVICE", "cpu")
BATCH_SIZE = int(os.getenv("OCC_EMBED_BATCH_SIZE", "8"))

app = FastAPI(title="OpenCorpCheck embeddings", version="0.1.0")

_embedder: Any = None
_reranker: Any = None
_embedder_lock = threading.Lock()
_reranker_lock = threading.Lock()


class EmbedRequest(BaseModel):
    inputs: list[str] = Field(default_factory=list)
    model: str | None = None


class RerankRequest(BaseModel):
    query: str
    documents: list[str] = Field(default_factory=list)
    top_n: int | None = None
    model: str | None = None


def get_embedder() -> Any:
    global _embedder
    if _embedder is None:
        with _embedder_lock:
            if _embedder is None:
                from sentence_transformers import SentenceTransformer

                logger.info("loading embedding model %s on %s", EMBED_MODEL, DEVICE)
                _embedder = SentenceTransformer(EMBED_MODEL, device=DEVICE)
                logger.info("embedding model ready")
    return _embedder


def get_reranker() -> Any:
    global _reranker
    if _reranker is None:
        with _reranker_lock:
            if _reranker is None:
                from sentence_transformers import CrossEncoder

                logger.info("loading rerank model %s on %s", RERANK_MODEL, DEVICE)
                _reranker = CrossEncoder(RERANK_MODEL, device=DEVICE)
                logger.info("rerank model ready")
    return _reranker


@app.get("/health")
def health() -> dict[str, Any]:
    dim = None
    if _embedder is not None:
        try:
            dim = int(_embedder.get_sentence_embedding_dimension())
        except Exception:  # pragma: no cover - defensive
            dim = None
    return {
        "ok": True,
        "service": "occ-embeddings",
        "model": EMBED_MODEL,
        "rerank_model": RERANK_MODEL,
        "loaded": _embedder is not None,
        "dim": dim,
    }


@app.post("/embed")
def embed(request: EmbedRequest) -> dict[str, Any]:
    if not request.inputs:
        return {"embeddings": [], "model": EMBED_MODEL, "dim": None}
    if request.model and request.model != EMBED_MODEL:
        raise HTTPException(
            status_code=400,
            detail=f"only model {EMBED_MODEL!r} is loaded, got {request.model!r}",
        )
    model = get_embedder()
    vectors = model.encode(
        request.inputs,
        normalize_embeddings=True,
        batch_size=BATCH_SIZE,
        show_progress_bar=False,
    )
    return {
        "embeddings": vectors.tolist(),
        "model": EMBED_MODEL,
        "dim": int(vectors.shape[1]),
    }


@app.post("/rerank")
def rerank(request: RerankRequest) -> dict[str, Any]:
    if not request.documents:
        return {"results": []}
    if request.model and request.model != RERANK_MODEL:
        raise HTTPException(
            status_code=400,
            detail=f"only model {RERANK_MODEL!r} is loaded, got {request.model!r}",
        )
    model = get_reranker()
    scores = model.predict([(request.query, doc) for doc in request.documents])
    order = sorted(range(len(scores)), key=lambda index: scores[index], reverse=True)
    if request.top_n is not None:
        order = order[: request.top_n]
    return {
        "results": [
            {"index": index, "score": float(scores[index])} for index in order
        ],
        "model": RERANK_MODEL,
    }
