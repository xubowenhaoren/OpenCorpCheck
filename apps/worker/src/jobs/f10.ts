import type { Job } from "pg-boss";

import {
  FinanceAnalystClient,
  type Market,
} from "@occ/sources-eastmoney-f10";

import { config } from "../config.js";
import {
  getJobRow,
  markJobActive,
  markJobCompleted,
  markJobFailed,
  upsertF10Page,
} from "../db.js";
import { QUEUES } from "../queues.js";

export interface F10JobData {
  runId: string;
  key: string;
  market: Market;
  code: string;
  page: string;
  force?: boolean;
}

export async function handleF10Jobs(jobs: Job<F10JobData>[]): Promise<void> {
  const client = new FinanceAnalystClient({ baseUrl: config.financeAnalystUrl });
  for (const job of jobs) {
    await processF10Job(client, job);
  }
}

async function processF10Job(
  client: FinanceAnalystClient,
  job: Job<F10JobData>,
): Promise<void> {
  const data = job.data;
  const queue = QUEUES.F10;
  const row = await getJobRow(data.runId, queue, data.key);
  if (!row) {
    log({ event: "f10_job_missing", run: data.runId, key: data.key });
    return;
  }
  if (row.status === "completed" && !data.force) {
    log({ event: "f10_job_skip_completed", run: data.runId, key: data.key });
    return;
  }

  await markJobActive(data.runId, queue, data.key);
  const startedAt = Date.now();
  try {
    const response = await client.scrape(
      {
        market: data.market,
        code: data.code,
        pages: [data.page],
        capture_xhr: false,
        force: data.force,
      },
      { timeoutMs: 120_000 },
    );
    const page = response.pages[0];
    if (!page) {
      throw new Error("sidecar returned no page");
    }
    if (page.error) {
      throw new Error(page.error);
    }
    if (page.http_status !== 200) {
      throw new Error(`F10 page returned HTTP ${page.http_status}`);
    }

    await upsertF10Page({
      market: data.market,
      code: data.code,
      page: data.page,
      fetchedAt: response.meta.fetched_at,
      httpStatus: page.http_status ?? null,
      textChars: page.text_chars,
      tableCount: page.table_count,
      htmlSha256: page.html_sha256 ?? null,
      storageKey: page.storage_key ?? null,
      warnings: page.warnings,
    });
    await markJobCompleted(data.runId, queue, data.key);
    log({
      event: "f10_job_completed",
      run: data.runId,
      key: data.key,
      market: data.market,
      code: data.code,
      page: data.page,
      durationMs: Date.now() - startedAt,
      textChars: page.text_chars,
      tableCount: page.table_count,
      htmlSha256: page.html_sha256,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markJobFailed(data.runId, queue, data.key, message);
    log({
      event: "f10_job_failed",
      run: data.runId,
      key: data.key,
      page: data.page,
      durationMs: Date.now() - startedAt,
      error: message,
      retryCount: job.retryCount,
    });
    throw error;
  }
}

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}
