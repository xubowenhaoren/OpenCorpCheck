#!/usr/bin/env bash
# Local PostgreSQL for OpenCorpCheck development (macOS, Linux, WSL2).
#
#   scripts/dev-db.sh init     # first time only
#   scripts/dev-db.sh start    # start + create the occdb database
#   scripts/dev-db.sh stop
#   scripts/dev-db.sh status
#
# Override PGBIN / PGDATA / PGPORT / PGDATABASE if needed. On WSL2 keep the
# repo on the Linux filesystem (not /mnt/c) and use the Linux Postgres build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${PGBIN:-}" ]]; then
  if [[ -x /opt/homebrew/opt/postgresql@17/bin/pg_ctl ]]; then
    PGBIN=/opt/homebrew/opt/postgresql@17/bin
  elif command -v pg_ctl >/dev/null 2>&1; then
    PGBIN="$(cd "$(dirname "$(command -v pg_ctl)")" && pwd)"
  elif [[ -x /usr/lib/postgresql/17/bin/pg_ctl ]]; then
    PGBIN=/usr/lib/postgresql/17/bin
  else
    PGBIN=/opt/homebrew/opt/postgresql@17/bin
  fi
fi
PGDATA="${PGDATA:-$ROOT/.pgdata}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-occdb}"

# macOS Postgres refuses to start ("postmaster became multithreaded") without
# a valid locale. Linux/WSL2 may not have en_US.UTF-8; fall back to C.UTF-8.
if [[ -z "${LC_ALL:-}" ]]; then
  if locale -a 2>/dev/null | grep -qiE '^(en_US\.utf-?8)$'; then
    export LC_ALL=en_US.UTF-8
  elif locale -a 2>/dev/null | grep -qiE '^(C\.utf-?8)$'; then
    export LC_ALL=C.UTF-8
  else
    export LC_ALL=C
  fi
fi
export LANG="${LANG:-$LC_ALL}"

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
