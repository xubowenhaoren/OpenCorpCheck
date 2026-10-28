#!/usr/bin/env bash
# Local Qdrant for OpenCorpCheck development (no Docker required).
#
#   scripts/dev-qdrant.sh start
#   scripts/dev-qdrant.sh stop
#   scripts/dev-qdrant.sh status
#   scripts/dev-qdrant.sh logs
#
# Supports macOS (arm64/x86_64) and Linux/WSL2 (x86_64/aarch64). Downloads the
# pinned Qdrant binary once into .qdrant/bin and stores data in .qdrant/storage
# (both gitignored).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${QDRANT_VERSION:-v1.18.0}"
HTTP_PORT="${QDRANT_HTTP_PORT:-6333}"
GRPC_PORT="${QDRANT_GRPC_PORT:-6334}"
DIR="$ROOT/.qdrant"
BIN_DIR="$DIR/bin"
DATA_DIR="$DIR/storage"
PID_FILE="$DIR/qdrant.pid"
LOG_FILE="$DIR/qdrant.log"
URL_BASE="https://github.com/qdrant/qdrant/releases/download/$VERSION"

usage() {
  echo "usage: $0 {start|stop|status|logs}" >&2
  exit 2
}

health() {
  curl -sf "http://127.0.0.1:$HTTP_PORT/readyz" >/dev/null 2>&1
}

download() {
  local os arch asset
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os:$arch" in
    Darwin:arm64)   asset="qdrant-aarch64-apple-darwin.tar.gz" ;;
    Darwin:x86_64)  asset="qdrant-x86_64-apple-darwin.tar.gz" ;;
    Linux:x86_64)   asset="qdrant-x86_64-unknown-linux-gnu.tar.gz" ;;
    Linux:aarch64|Linux:arm64) asset="qdrant-aarch64-unknown-linux-musl.tar.gz" ;;
    *)
      echo "unsupported platform: $os $arch (use macOS, Linux, or WSL2)" >&2
      exit 1
      ;;
  esac
  mkdir -p "$BIN_DIR"
  echo "downloading Qdrant $VERSION ($os $arch)…"
  local tmp
  tmp="$(mktemp -d)"
  curl -fL "$URL_BASE/$asset" -o "$tmp/qdrant.tar.gz"
  tar -xzf "$tmp/qdrant.tar.gz" -C "$BIN_DIR"
  if [[ "$os" == "Darwin" ]]; then
    xattr -d com.apple.quarantine "$BIN_DIR/qdrant" 2>/dev/null || true
  fi
  chmod +x "$BIN_DIR/qdrant"
  rm -rf "$tmp"
}

start() {
  if health; then
    echo "qdrant already running on :$HTTP_PORT"
    return 0
  fi
  if [[ ! -x "$BIN_DIR/qdrant" ]]; then
    download
  fi
  mkdir -p "$DATA_DIR"
  echo "starting qdrant on :$HTTP_PORT (data: $DATA_DIR)"
  pushd "$DIR" >/dev/null
  QDRANT__STORAGE__STORAGE_PATH="$DATA_DIR" \
  QDRANT__SERVICE__HTTP_PORT="$HTTP_PORT" \
  QDRANT__SERVICE__GRPC_PORT="$GRPC_PORT" \
  QDRANT__TELEMETRY_DISABLED=true \
    nohup "$BIN_DIR/qdrant" >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  popd >/dev/null
  for _ in $(seq 1 60); do
    if health; then
      echo "qdrant ready: http://127.0.0.1:$HTTP_PORT"
      return 0
    fi
    sleep 1
  done
  echo "qdrant failed to start; see $LOG_FILE" >&2
  tail -n 40 "$LOG_FILE" >&2 || true
  exit 1
}

stop() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    kill "$pid" 2>/dev/null || true
    # Qdrant holds WAL locks until it exits; wait before a restart.
    for _ in $(seq 1 40); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    rm -f "$PID_FILE"
    echo "qdrant stopped"
  elif health; then
    echo "qdrant is running but $PID_FILE is missing; kill it manually" >&2
    exit 1
  else
    echo "qdrant is not running"
  fi
}

status() {
  if health; then
    echo "qdrant: running on :$HTTP_PORT"
  else
    echo "qdrant: stopped"
    exit 1
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  logs) tail -n 100 "$LOG_FILE" ;;
  *) usage ;;
esac
