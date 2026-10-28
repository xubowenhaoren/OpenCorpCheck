# occ-embeddings

Local development sidecar for **BGE-M3 dense embeddings** and optional
**bge-reranker-v2-m3** reranking. It is a stand-in for HuggingFace TEI when you
do not run Docker; the HTTP contract is the same, so `packages/retrieval` uses
one client for both.

```bash
cd services/embeddings
uv sync
uv run uvicorn occ_embeddings.main:app --app-dir src --host 127.0.0.1 --port 8080
```

Or use the repo script:

```bash
scripts/dev-embeddings.sh start
scripts/dev-embeddings.sh status
scripts/dev-embeddings.sh stop
```

The first request downloads `BAAI/bge-m3` (~2.3 GB) and loads it on CPU. The
reranker is downloaded only if `/rerank` is called.

| Env | Default |
|---|---|
| `OCC_EMBED_MODEL` | `BAAI/bge-m3` |
| `OCC_RERANK_MODEL` | `BAAI/bge-reranker-v2-m3` |
| `OCC_EMBED_DEVICE` | `cpu` |
| `OCC_EMBED_BATCH_SIZE` | `8` |

Production uses TEI (`ghcr.io/huggingface/text-embeddings-inference`) with the
same model; see `docs/ARCHITECTURE.md` §7.
