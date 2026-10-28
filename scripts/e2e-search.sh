#!/usr/bin/env bash
# End-to-end hybrid-search check.
#
# Starts Postgres, Qdrant and the local BGE-M3 sidecar, builds, seeds the
# synthetic corpus, then drives the real search API.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! "$ROOT/scripts/dev-db.sh" status >/dev/null 2>&1; then
  "$ROOT/scripts/dev-db.sh" start >/dev/null
fi
"$ROOT/scripts/dev-qdrant.sh" start
"$ROOT/scripts/dev-embeddings.sh" start

echo "== building =="
corepack pnpm -r build

echo "== migrating =="
node apps/cli/dist/occ.js migrate

echo "== seeding synthetic corpus =="
node apps/cli/dist/occ.js seed --reset

echo "== running E2E =="
node scripts/e2e-search.mjs
