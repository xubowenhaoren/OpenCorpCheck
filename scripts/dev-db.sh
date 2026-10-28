#!/usr/bin/env bash
# Local PostgreSQL for OpenCorpCheck development.
#
#   scripts/dev-db.sh init     # first time only
#   scripts/dev-db.sh start    # start + create the occdb database
#   scripts/dev-db.sh stop
#   scripts/dev-db.sh status
#
# Override PGBIN / PGDATA / PGPORT / PGDATABASE if needed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PGDATA="${PGDATA:-$ROOT/.pgdata}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-occdb}"

# macOS Postgres refuses to start ("postmaster became multithreaded") without
# a valid locale.
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export LANG="${LANG:-en_US.UTF-8}"

if [[ ! -x "$PGBIN/pg_ctl" ]]; then
  echo "PostgreSQL binaries not found at $PGBIN" >&2
  echo "Install with: brew install postgresql@17" >&2
  echo "Or set PGBIN=/path/to/postgresql/bin" >&2
  exit 1
fi

command="${1:-start}"
case "$command" in
  init)
    if [[ -d "$PGDATA" ]]; then
      echo "$PGDATA already exists" >&2
      exit 1
    fi
    "$PGBIN/initdb" -D "$PGDATA" -U occ --auth=trust --no-locale --encoding=UTF8
    ;;
  start)
    "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT -k /tmp" -l "$PGDATA/server.log" start
    "$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U occ "$PGDATABASE" 2>/dev/null || true
    echo "DATABASE_URL=postgres://occ@127.0.0.1:$PGPORT/$PGDATABASE"
    ;;
  stop)
    "$PGBIN/pg_ctl" -D "$PGDATA" stop
    ;;
  status)
    "$PGBIN/pg_ctl" -D "$PGDATA" status
    ;;
  *)
    echo "usage: $0 {init|start|stop|status}" >&2
    exit 2
    ;;
esac
