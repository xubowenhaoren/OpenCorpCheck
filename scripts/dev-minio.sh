#!/usr/bin/env bash
# Local MinIO for OpenCorpCheck development (no Docker required).
#
#   scripts/dev-minio.sh start
#   scripts/dev-minio.sh stop
#   scripts/dev-minio.sh status
#   scripts/dev-minio.sh logs
#
# Supports macOS (arm64/x86_64) and Linux/WSL2 (x86_64/aarch64). Uses `minio`
# from PATH (e.g. `brew install minio`) or MINIO_BIN; if neither exists it tries
# the legacy dl.min.io download and explains the fallback if that is unavailable.
# Data lives in .minio/data (gitignored). Defaults are the conventional
# local-only credentials; set MINIO_ROOT_USER / MINIO_ROOT_PASSWORD to override.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/.minio"
BIN="$DIR/bin/minio"
DATA_DIR="$DIR/data"
PID_FILE="$DIR/minio.pid"
LOG_FILE="$DIR/minio.log"
ADDRESS="${MINIO_ADDRESS:-127.0.0.1:9000}"
CONSOLE_ADDRESS="${MINIO_CONSOLE_ADDRESS:-127.0.0.1:9001}"
ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"

usage() {
  echo "usage: $0 {start|stop|status|logs}" >&2
  exit 2
}

health() {
  curl -sf "http://${ADDRESS}/minio/health/live" >/dev/null 2>&1
}

download() {
  local os arch url
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os:$arch" in
    Darwin:arm64)   url="https://dl.min.io/server/minio/release/darwin-arm64/minio" ;;
    Darwin:x86_64)  url="https://dl.min.io/server/minio/release/darwin-amd64/minio" ;;
    Linux:x86_64)   url="https://dl.min.io/server/minio/release/linux-amd64/minio" ;;
    Linux:aarch64|Linux:arm64) url="https://dl.min.io/server/minio/release/linux-arm64/minio" ;;
    *)
      echo "unsupported platform: $os $arch (use macOS, Linux, or WSL2)" >&2
      return 1
      ;;
  esac
  mkdir -p "$DIR/bin"
  echo "downloading MinIO ($os $arch)…"
  if ! curl -fL "$url" -o "$BIN"; then
    rm -f "$BIN"
    echo "MinIO's public binary endpoint is unavailable (HTTP 410 as of 2026-10)." >&2
    echo "Install it instead: brew install minio   # macOS" >&2
    echo "or set MINIO_BIN=/path/to/minio (any S3-compatible store works)." >&2
    return 1
  fi
  if [[ "$os" == "Darwin" ]]; then
    xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true
  fi
  chmod +x "$BIN"
}

resolve_bin() {
  if [[ -n "${MINIO_BIN:-}" ]]; then
    if [[ ! -x "$MINIO_BIN" ]]; then
      echo "MINIO_BIN is not executable: $MINIO_BIN" >&2
      exit 1
    fi
    echo "$MINIO_BIN"
    return 0
  fi
  if command -v minio >/dev/null 2>&1; then
    command -v minio
    return 0
  fi
  if [[ -x "$BIN" ]]; then
    echo "$BIN"
    return 0
  fi
  download || exit 1
  echo "$BIN"
}

start() {
  if health; then
    echo "minio already running on :${ADDRESS#*:}"
    return 0
  fi
  local minio_bin
  minio_bin="$(resolve_bin)"
  mkdir -p "$DATA_DIR"
  echo "starting minio on :${ADDRESS#*:} (data: $DATA_DIR)"
  MINIO_ROOT_USER="$ROOT_USER" \
  MINIO_ROOT_PASSWORD="$ROOT_PASSWORD" \
  MINIO_BROWSER_REDIRECT_URL="http://$CONSOLE_ADDRESS" \
    nohup "$minio_bin" server "$DATA_DIR" --address "$ADDRESS" --console-address "$CONSOLE_ADDRESS" \
    >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 60); do
    if health; then
      echo "minio ready: http://$ADDRESS (console http://$CONSOLE_ADDRESS)"
      echo "credentials: $ROOT_USER / $ROOT_PASSWORD"
      return 0
    fi
    sleep 1
  done
  echo "minio failed to start; see $LOG_FILE" >&2
  tail -n 40 "$LOG_FILE" >&2 || true
  exit 1
}

stop() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    rm -f "$PID_FILE"
    echo "minio stopped"
  elif health; then
    echo "minio is running but $PID_FILE is missing; kill it manually" >&2
    exit 1
  else
    echo "minio is not running"
  fi
}

status() {
  if health; then
    echo "minio: running on :${ADDRESS#*:} (console :${CONSOLE_ADDRESS#*:})"
  else
    echo "minio: stopped"
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
