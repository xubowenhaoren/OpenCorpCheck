#!/usr/bin/env bash
# Run the full ChiNext 50 (创业板50, 399673 / internal CYB50) research +
# reviewer batch.
#
# Prerequisites: Postgres/Qdrant/embeddings are up, the F10 sidecar is on
# :8090, DEEPSEEK_API_KEY.txt exists, and the repo is built
# (`corepack pnpm -r build`).
#
# Usage:
#   scripts/backfill-cyb50.sh
#   EXCLUDE=300014,300015,300017 scripts/backfill-cyb50.sh
#
# The reviewer can end companies in `needs_review`; that is a real outcome, not
# a failure. Inspect with `node apps/worker/dist/cli.js states`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CLI=(node apps/worker/dist/cli.js)
# The three pilot names from `enqueue research --universe cyb50 --limit 3`.
# Override EXCLUDE to change the set (empty string enqueues all 50).
EXCLUDE="${EXCLUDE-300014,300015,300017}"

"${CLI[@]}" migrate
if [[ -n "$EXCLUDE" ]]; then
  "${CLI[@]}" enqueue research --universe cyb50 --exclude "$EXCLUDE"
else
  "${CLI[@]}" enqueue research --universe cyb50
fi
OCC_LLM_PROVIDER=deepseek "${CLI[@]}" work --queues research,ingest,review,f10,financials --drain

# Second pass: later companies may name an earlier company as a shareholder;
# re-resolve cached F10 pages now that the whole ChiNext 50 universe exists.
"${CLI[@]}" relations f10 --universe cyb50
"${CLI[@]}" states
