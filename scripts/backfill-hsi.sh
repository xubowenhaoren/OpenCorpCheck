#!/usr/bin/env bash
# Run the full Hang Seng Index research + reviewer batch.
#
# Prerequisites: Postgres/Qdrant/embeddings are up, the F10 sidecar is on
# :8090, NVIDIA_API_KEY.txt and DEEPSEEK_API_KEY.txt exist, and the repo is
# built (`corepack pnpm -r build`).
#
# Usage:
#   scripts/backfill-hsi.sh
#   EXCLUDE=00700,00001 scripts/backfill-hsi.sh
#
# The reviewer can end companies in `needs_review`; that is a real outcome, not
# a failure. Inspect with `node apps/worker/dist/cli.js states`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CLI=(node apps/worker/dist/cli.js)
EXCLUDE="${EXCLUDE:-00700}"

"${CLI[@]}" migrate
"${CLI[@]}" enqueue research --universe hsi --exclude "$EXCLUDE"
"${CLI[@]}" work --queues research,ingest,review,f10,financials --drain

# Second pass: later companies may name an earlier company as a shareholder;
# re-resolve cached F10 pages now that the whole HSI universe exists.
"${CLI[@]}" relations f10 --universe hsi
"${CLI[@]}" states
