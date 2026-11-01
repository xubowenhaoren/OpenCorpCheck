#!/usr/bin/env bash
# Persistent local news worker (no Docker required).
#
#   scripts/dev-news-worker.sh start
#   scripts/dev-news-worker.sh stop
#   scripts/dev-news-worker.sh restart
#   scripts/dev-news-worker.sh status
#   scripts/dev-news-worker.sh logs
#
# The API schedules/observes the automatic news sweep; this process is what
# actually fetches Google News RSS and embeds new items (0 LLM tokens). Keep it
# running while you use the UI so opening http://127.0.0.1:5173 shows sweeps
# progressing and keeps the last 3 days of completed records.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/.occ"
PID_FILE="$DIR/news-worker.pid"
LOG_FILE="$DIR/news-worker.log"
CLI="$ROOT/apps/worker/dist/cli.js"
QUEUES="${OCC_NEWS_WORKER_QUEUES:-news}"

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
  # Fall back to a process match (e.g. pid file removed but worker alive).
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
    echo "news worker already running (pid $pid)"
    return 0
  fi
  if [[ ! -f "$CLI" ]]; then
    echo "missing $CLI; run: corepack pnpm --filter @occ/worker build" >&2
    exit 1
  fi
  mkdir -p "$DIR"
  echo "starting news worker --queues $QUEUES (log: $LOG_FILE)"
  nohup node "$CLI" work --queues "$QUEUES" >>"$LOG_FILE" 2>&1 &
  pid=$!
  echo "$pid" >"$PID_FILE"
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "news worker exited immediately; last log lines:" >&2
    tail -n 20 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi
  echo "news worker started (pid $pid)"
}

stop() {
  local pid
  if ! pid="$(running_pid)"; then
    echo "news worker is not running"
    rm -f "$PID_FILE"
    return 0
  fi
  echo "stopping news worker (pid $pid)…"
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
    echo "news worker running (pid $pid, queues: $QUEUES)"
    if [[ -f "$LOG_FILE" ]]; then
      echo "last log line: $(tail -n 1 "$LOG_FILE")"
    fi
    return 0
  fi
  echo "news worker is not running"
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
