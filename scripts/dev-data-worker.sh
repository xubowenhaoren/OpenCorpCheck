#!/usr/bin/env bash
# Persistent local data/filing worker (P1.5, no Docker required).
#
#   scripts/dev-data-worker.sh start
#   scripts/dev-data-worker.sh stop
#   scripts/dev-data-worker.sh restart
#   scripts/dev-data-worker.sh status
#   scripts/dev-data-worker.sh logs
#
# Runs the deterministic daily filing/financials loop:
#   data.sweep -> data.source.check -> ingest.filing / financials.company
# 0 LLM tokens. Requires the F10/PDF/HKEXnews sidecar for PDF extraction and
# HKEXnews checks (`cd services/finance-analyst && uv run occ-f10 serve`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/.occ"
PID_FILE="$DIR/data-worker.pid"
LOG_FILE="$DIR/data-worker.log"
CLI="$ROOT/apps/worker/dist/cli.js"
QUEUES="${OCC_DATA_WORKER_QUEUES:-data,financials}"

usage() {
  echo "usage: $0 {start|stop|restart|status|logs}" >&2
  exit 2
}

running_pid() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  local pid
  pid="$(pgrep -f "cli.js work --queues $QUEUES" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$pid" ]]; then
    echo "$pid"
    return 0
  fi
  return 1
}

start() {
  local pid
  if pid="$(running_pid)"; then
    echo "data worker already running (pid $pid)"
    return 0
  fi
  if [[ ! -f "$CLI" ]]; then
    echo "missing $CLI; run: corepack pnpm --filter @occ/worker build" >&2
    exit 1
  fi
  mkdir -p "$DIR"
  echo "starting data worker --queues $QUEUES (log: $LOG_FILE)"
  nohup node "$CLI" work --queues "$QUEUES" >>"$LOG_FILE" 2>&1 &
  pid=$!
  echo "$pid" >"$PID_FILE"
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "data worker exited immediately; last log lines:" >&2
    tail -n 20 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi
  echo "data worker started (pid $pid)"
}

stop() {
  local pid
  if ! pid="$(running_pid)"; then
    echo "data worker is not running"
    rm -f "$PID_FILE"
    return 0
  fi
  echo "stopping data worker (pid $pid)…"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "stopped"
      return 0
    fi
    sleep 1
  done
  echo "did not stop within 30s; sending SIGKILL" >&2
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
}

status() {
  local pid
  if pid="$(running_pid)"; then
    echo "data worker running (pid $pid, queues: $QUEUES)"
    if [[ -f "$LOG_FILE" ]]; then
      echo "last log line: $(tail -n 1 "$LOG_FILE")"
    fi
    return 0
  fi
  echo "data worker is not running"
  return 1
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  logs) tail -n "${2:-80}" "$LOG_FILE" ;;
  *) usage ;;
esac
