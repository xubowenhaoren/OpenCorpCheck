import fs from "node:fs";
import path from "node:path";

import type { Job } from "pg-boss";

import type { CoverageTier } from "@occ/core";

import { config, ensureDir } from "../config.js";
import {
  getJobRow,
  getResearchCache,
  markJobActive,
  markJobCompleted,
  markJobFailed,
  upsertResearchCache,
} from "../db.js";
import { QUEUES } from "../queues.js";
import { runDshResearch } from "../research/dsh.js";
import {
  promptHash,
  renderPrompt,
  sha256Text,
  skillForTarget,
  today,
} from "../research/profiler.js";
import type { CompanyTarget } from "../universe.js";
import type { IngestJobData } from "./ingest.js";

export interface ResearchJobData {
  runId: string;
  key: string;
  ticker: string;
  name: string;
  market?: "A" | "HK" | "US";
  skill?: "mag7-profile" | "company-profile";
  focus?: string;
  force?: boolean;
  mock?: boolean;
  includeF10?: boolean;
  /** Follow-up ingestion after the section is written (default: live only). */
  ingest?: boolean;
  indexCode?: string;
  indexAsOf?: string;
  coverageTier?: CoverageTier;
}

export interface ResearchJobContext {
  enqueueIngest?: (data: IngestJobData) => Promise<void>;
}

export async function handleResearchJobs(
  jobs: Job<ResearchJobData>[],
  context: ResearchJobContext = {},
): Promise<void> {
  for (const job of jobs) {
    await processResearchJob(job, context);
  }
}

async function processResearchJob(
  job: Job<ResearchJobData>,
  context: ResearchJobContext,
): Promise<void> {
  const data = job.data;
  const queue = QUEUES.RESEARCH;
  const row = await getJobRow(data.runId, queue, data.key);
  if (!row) {
    log({ event: "research_job_missing", run: data.runId, key: data.key });
    return;
  }
  if (row.status === "completed" && !data.force) {
    log({ event: "research_job_skip_completed", run: data.runId, key: data.key });
    return;
  }

  const target: CompanyTarget = {
    key: data.key,
    ticker: data.ticker,
    name: data.name,
    market: data.market,
    focus: data.focus,
    priority: 0,
    source: "explicit",
  };
  const skill = data.skill ?? skillForTarget(target);
  const prompt = renderPrompt(target, today(), skill);
  const patches = data.includeF10
    ? [config.basePatch, config.f10Patch]
    : [config.basePatch];
  const hash = promptHash(prompt, patches, skill);

  // Resume fast-path: same prompt/model/skill/patch hash and an intact section.
  if (!data.force) {
    const cached = await getResearchCache(data.key);
    if (
      cached &&
      cached.prompt_hash === hash &&
      sectionMatches(cached.section_path, cached.section_sha256)
    ) {
      await markJobCompleted(data.runId, queue, data.key);
      log({
        event: "research_job_cache_hit",
        run: data.runId,
        key: data.key,
        section: cached.section_path,
      });
      await enqueueIngest(context, data, cached.section_path);
      return;
    }
  }

  await markJobActive(data.runId, queue, data.key);
  const startedAt = Date.now();
  let sectionText = "";
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    if (data.mock) {
      sectionText = renderMockSection(target);
    } else {
      const result = await runDshResearch({
        ticker: data.ticker,
        prompt,
        includeF10: data.includeF10,
        signal: job.signal,
      });
      if (!result.ok) {
        throw new Error(result.error ?? "dsh research failed");
      }
      sectionText = `${result.finalText.trim()}\n`;
      inputTokens = result.usage.inputTokens;
      outputTokens = result.usage.outputTokens;
    }

    const sectionPath = writeSection(data.ticker, sectionText);
    const sectionSha = sha256Text(sectionText);
    await upsertResearchCache({
      companyId: data.key,
      promptHash: hash,
      sectionSha256: sectionSha,
      sectionPath,
      model: config.model,
      tokensInput: inputTokens,
      tokensOutput: outputTokens,
    });
    await markJobCompleted(data.runId, queue, data.key);
    log({
      event: "research_job_completed",
      run: data.runId,
      key: data.key,
      mock: Boolean(data.mock),
      durationMs: Date.now() - startedAt,
      sectionPath,
      chars: sectionText.length,
      inputTokens,
      outputTokens,
    });
    await enqueueIngest(context, data, sectionPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markJobFailed(data.runId, queue, data.key, message);
    log({
      event: "research_job_failed",
      run: data.runId,
      key: data.key,
      durationMs: Date.now() - startedAt,
      error: message,
      retryCount: job.retryCount,
    });
    throw error;
  }
}

function sectionMatches(filePath: string, expectedSha: string): boolean {
  try {
    return sha256Text(fs.readFileSync(filePath, "utf8")) === expectedSha;
  } catch {
    return false;
  }
}

/**
 * Queue ingestion for a finished section. `--no-ingest` disables it; mock
 * sections are skipped unless explicitly opted in (`--ingest-mock`).
 */
async function enqueueIngest(
  context: ResearchJobContext,
  data: ResearchJobData,
  sectionPath: string,
): Promise<void> {
  const shouldIngest = data.ingest ?? !data.mock;
  if (!shouldIngest || !context.enqueueIngest) return;
  await context.enqueueIngest({
    runId: data.runId,
    key: data.key,
    ticker: data.ticker,
    name: data.name,
    ...(data.market ? { market: data.market } : {}),
    sectionPath,
    ...(data.indexCode ? { indexCode: data.indexCode } : {}),
    ...(data.indexAsOf ? { indexAsOf: data.indexAsOf } : {}),
    ...(data.coverageTier ? { coverageTier: data.coverageTier } : {}),
    force: Boolean(data.force),
  });
}

function writeSection(ticker: string, text: string): string {
  ensureDir(config.sectionsDir);
  const safeTicker = ticker.replace(/[^A-Za-z0-9.-]+/g, "_");
  const filePath = path.join(config.sectionsDir, `${safeTicker}.md`);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, text, "utf8");
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

function renderMockSection(target: CompanyTarget): string {
  const fixture = fs.readFileSync(config.mockSection, "utf8");
  return fixture
    .replaceAll("{{COMPANY}}", target.name)
    .replaceAll("{{TICKER}}", target.ticker)
    .replaceAll("{{DATE}}", today());
}

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}
