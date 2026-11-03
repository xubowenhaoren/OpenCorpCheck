#!/usr/bin/env node
import { parseArgs } from "node:util";

import { closePool, migrate } from "./db.js";
import { dataSweepStatus, runDataSweep } from "./data-sweep.js";
import { closeIngestRuntime } from "./ingest-runtime.js";
import { startBoss } from "./queues.js";

/**
 * `occ-refresh` — operator surface for the P1.5 daily data/filing refresh.
 *
 * The automatic path is a worker schedule (`occ-backfill work --queues data`).
 * This CLI observes the cursors and can force one sweep; it never fetches a
 * filing itself and is still advisory-locked, so it cannot double-run with the
 * cron.
 */

const USAGE = `occ-refresh — daily company-data / filing refresh (P1.5)

Usage:
  occ-refresh status [--json]
  occ-refresh sweep --now [--limit N] [--company REF] [--source LIST] [--json]

Options:
  --now                 Required for sweep (operator-forced)
  --limit N             Max (company, source) checks in this sweep
  --company REF         Only one company (ticker / slug / name)
  --source LIST         edgar,cninfo,hkexnews,f10
  --json                Machine-readable output

Environment:
  DATABASE_URL              default postgres://occ@127.0.0.1:5432/occdb
  OCC_DATA_SWEEP            on default; none disables the automatic sweep
  OCC_DATA_SWEEP_CRON       default "0 8 * * *"
  OCC_DATA_TTL_MS           default 82,800,000 (23 h)
  OCC_DATA_CONCURRENCY      default 4
  OCC_FILINGS_CONCURRENCY   default 2
  OCC_EDGAR_USER_AGENT      SEC requires a contact
  OCC_FINANCE_ANALYST_URL   sidecar for HKEXnews/PDF (default :8090)
`;

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      now: { type: "boolean" },
      json: { type: "boolean" },
      limit: { type: "string" },
      company: { type: "string" },
      source: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (!sub || values.help || sub === "help" || sub === "-h") {
    console.log(USAGE);
    return;
  }
  await migrate();

  if (sub === "status") {
    console.log(JSON.stringify(await dataSweepStatus(), null, 2));
    return;
  }

  if (sub === "sweep") {
    if (!values.now) {
      throw new Error("occ-refresh sweep requires --now");
    }
    const boss = await startBoss();
    try {
      const result = await runDataSweep({
        boss,
        source: "cli",
        ...(values.limit ? { limit: parsePositive(values.limit) } : {}),
        ...(values.company ? { companyRefs: [values.company] } : {}),
        ...(values.source
          ? {
              sources: values.source
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            }
          : {}),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    } finally {
      await boss.stop({ graceful: false });
    }
  }

  throw new Error(`unknown command: ${sub}\n\n${USAGE}`);
}

function parsePositive(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return parsed;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeIngestRuntime().catch(() => {});
    await closePool().catch(() => {});
  });
