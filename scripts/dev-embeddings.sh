#!/usr/bin/env bash
# Local BGE-M3 embedding/rerank sidecar for OpenCorpCheck development.
#
#   scripts/dev-embeddings.sh start
#   scripts/dev-embeddings.sh stop
#   scripts/dev-embeddings.sh status
#   scripts/dev-embeddings.sh logs
#
# The first /embed request downloads BAAI/bge-m3 (~2.3 GB).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${OCC_EMBEDDING_PORT:-8080}"
DIR="$ROOT/.embeddings"
PID_FILE="$DIR/embeddings.pid"
LOG_FILE="$DIR/embeddings.log"
SERVICE_DIR="$ROOT/services/embeddings"

health() {
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1
}

start() {
  if health; then
    echo "embeddings already running on :$PORT"
    return 0
  fi
  command -v uv >/dev/null 2>&1 || {
    echo "uv not found; install with: brew install uv" >&2
    exit 1
  }
  mkdir -p "$DIR"
  cd "$SERVICE_DIR"
  if [[ ! -d .venv ]]; then
    echo "creating Python 3.12 venv (torch + sentence-transformers)…"
    uv sync
  fi
  echo "starting embeddings sidecar on :$PORT"
  nohup uv run --no-sync uvicorn occ_embeddings.main:app \
    --app-dir src --host 127.0.0.1 --port "$PORT" \
    >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 120); do
    if health; then
      echo "embeddings ready: http://127.0.0.1:$PORT (model loads on first request)"
      return 0
    fi
    sleep 1
  done
  echo "embeddings failed to start; see $LOG_FILE" >&2
  tail -n 60 "$LOG_FILE" >&2 || true
  exit 1
}

stop() {
  if [[ -f "$PID_FILE" ]]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "embeddings stopped"
  elif health; then
    echo "embeddings is running but $PID_FILE is missing; kill it manually" >&2
    exit 1
  else
    echo "embeddings is not running"
  fi
}

status() {
  if health; then
    echo "embeddings: running on :$PORT"
    curl -s "http://127.0.0.1:$PORT/health"
    echo
  else
    echo "embeddings: stopped"
    exit 1
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  logs) tail -n 100 "$LOG_FILE" ;;
  *) echo "usage: $0 {start|stop|status|logs}" >&2; exit 2 ;;
esac
