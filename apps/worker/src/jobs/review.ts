import fs from "node:fs";

import type { Job } from "pg-boss";

import { config } from "../config.js";
import {
  getJobRow,
  markJobActive,
  markJobCompleted,
  markJobDead,
  markJobFailed,
  upsertCompanyState,
} from "../db.js";
import { QUEUES } from "../queues.js";
import { runDshReview } from "../research/dsh.js";
import {
  buildReviewPrompt,
  missingSections,
  parseReviewOutput,
  REVIEW_PROMPT_VERSION,
} from "../research/reviewer.js";
import type { Market } from "@occ/core";
import type { ResearchJobData } from "./research.js";

export interface ReviewJobData {
  runId: string;
  key: string;
  ticker: string;
  name: string;
  market?: Market;
  sectionPath: string;
  /** 0-based cycle number; max is OCC_REVIEW_MAX_CYCLES (default 2). */
  reviewAttempt?: number;
  /** Original research job data, used to enqueue a bounded revision. */
  researchPayload?: ResearchJobData;
}

export interface ReviewJobContext {
  /** Enqueue one bounded research retry with the reviewer's instructions. */
  enqueueResearchRevision?: (
    data: ReviewJobData,
    feedback: string,
    nextAttempt: number,
  ) => Promise<void>;
}

export async function handleReviewJobs(
  jobs: Job<ReviewJobData>[],
  context: ReviewJobContext = {},
): Promise<void> {
  for (const job of jobs) {
    await processReviewJob(job, context);
  }
}

async function processReviewJob(
  job: Job<ReviewJobData>,
  context: ReviewJobContext,
): Promise<void> {
  const data = job.data;
  const queue = QUEUES.REVIEW;
  const row = await getJobRow(data.runId, queue, data.key);
  if (!row) {
    log({ event: "review_job_missing", run: data.runId, key: data.key });
    return;
  }
  if (row.status === "completed") {
    log({ event: "review_job_skip_completed", run: data.runId, key: data.key });
    return;
  }

  const attempt = Math.max(0, data.reviewAttempt ?? 0);
  await markJobActive(data.runId, queue, data.key);
  await upsertCompanyState({
    companyId: data.key,
    status: "reviewing",
    runId: data.runId,
    reviewAttempts: attempt,
  });

  const startedAt = Date.now();
  try {
    const markdown = fs.readFileSync(data.sectionPath, "utf8");
    const missing = missingSections(markdown);
    const prompt = buildReviewPrompt({
      company: data.name,
      ticker: data.ticker,
      market: data.market,
      markdown,
    });
    let parsed: ReturnType<typeof parseReviewOutput> | undefined;
    let parseError = "unknown";
    let toolCallCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (
      let reviewRun = 1;
      reviewRun <= config.reviewParseAttempts;
      reviewRun += 1
    ) {
      const run = await runDshReview({
        ticker: data.ticker,
        prompt,
        signal: job.signal,
      });
      if (!run.ok) {
        throw new Error(run.error ?? "reviewer dsh run failed");
      }
      toolCallCount = Object.values(run.toolCounts).reduce((a, b) => a + b, 0);
      inputTokens += run.usage.inputTokens;
      outputTokens += run.usage.outputTokens;
      parsed = parseReviewOutput(run.finalText);
      if (parsed.ok) break;
      parseError = parsed.error;
      log({
        event: "review_output_invalid",
        run: data.runId,
        key: data.key,
        reviewRun,
        willRetry: reviewRun < config.reviewParseAttempts,
        error: parsed.error,
        rawTail: parsed.raw.slice(-800),
        durationMs: Date.now() - startedAt,
      });
    }
    if (!parsed || !parsed.ok) {
      // A malformed reviewer is an operator problem, not a research problem.
      // Retry the reviewer a bounded number of times, never the research job.
      const message = `reviewer output invalid (${REVIEW_PROMPT_VERSION}) after ${config.reviewParseAttempts} run(s): ${parseError}`;
      await markJobDead(data.runId, queue, data.key);
      await upsertCompanyState({
        companyId: data.key,
        status: "needs_review",
        runId: data.runId,
        reviewAttempts: attempt,
        lastError: message,
      });
      return;
    }

    const result = parsed.result;
    const issues = [
      ...(missing.length > 0
        ? [
            {
              field: "章节",
              reason: `缺少章节：${missing.join("、")}`,
              evidence: undefined,
            },
          ]
        : []),
      ...result.issues,
    ];
    const verdict =
      result.verdict === "pass" && missing.length === 0 ? "pass" : "revise";

    if (verdict === "pass") {
      await markJobCompleted(data.runId, queue, data.key);
      await upsertCompanyState({
        companyId: data.key,
        status: "ready",
        runId: data.runId,
        reviewAttempts: attempt,
        lastError: null,
        reviewResult: result,
      });
      log({
        event: "review_passed",
        run: data.runId,
        key: data.key,
        attempt,
        toolCalls: toolCallCount,
        inputTokens,
        outputTokens,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const feedback = formatFeedback(result.fix_instructions, issues);
    if (attempt >= config.reviewMaxCycles || !context.enqueueResearchRevision) {
      const message =
        attempt >= config.reviewMaxCycles
          ? `reviewer requested revisions ${attempt + 1} time(s); cap reached`
          : "reviewer requested revisions but no research-revision handler is registered";
      await markJobDead(data.runId, queue, data.key);
      await upsertCompanyState({
        companyId: data.key,
        status: "needs_review",
        runId: data.runId,
        reviewAttempts: attempt,
        lastError: `${message}\n${feedback}`.slice(0, 4_000),
        reviewResult: result,
      });
      log({
        event: "review_needs_review",
        run: data.runId,
        key: data.key,
        attempt,
        message,
        issues: issues.length,
        inputTokens,
        outputTokens,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    await markJobCompleted(data.runId, queue, data.key);
    await upsertCompanyState({
      companyId: data.key,
      status: "running",
      runId: data.runId,
      reviewAttempts: attempt + 1,
      reviewResult: result,
    });
    await context.enqueueResearchRevision(data, feedback, attempt + 1);
    log({
      event: "review_revise_enqueued",
      run: data.runId,
      key: data.key,
      attempt: attempt + 1,
      issues: issues.length,
      feedback: feedback.slice(0, 1_500),
      inputTokens,
      outputTokens,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markJobFailed(data.runId, queue, data.key, message);
    await upsertCompanyState({
      companyId: data.key,
      status: "needs_review",
      runId: data.runId,
      reviewAttempts: attempt,
      lastError: message.slice(0, 4_000),
    });
    log({
      event: "review_job_failed",
      run: data.runId,
      key: data.key,
      durationMs: Date.now() - startedAt,
      error: message,
      retryCount: job.retryCount,
    });
    throw error;
  }
}

function formatFeedback(
  instructions: string,
  issues: Array<{ field: string; reason: string; evidence?: string }>,
): string {
  const lines: string[] = [];
  if (instructions.trim()) lines.push(instructions.trim());
  if (issues.length > 0) {
    lines.push("具体问题：");
    for (const issue of issues) {
      lines.push(
        `- [${issue.field}] ${issue.reason}${issue.evidence ? `（证据：${issue.evidence}）` : ""}`,
      );
    }
  }
  return lines.join("\n").slice(0, 6_000);
}

export function formatRevisionPrompt(feedback: string): string {
  return [
    "",
    "## 评审反馈（必须修正）",
    "",
    "上一版 profile 未通过审核。请针对下列问题重新检索并修正；保留所有仍然正确的章节与引用，不要删章。",
    "",
    feedback,
    "",
    "修正后仍然只返回完整的 markdown profile。",
  ].join("\n");
}

/** Kept for tests: the revision payload shape is stable. */
export type ResearchRevisionData = ResearchJobData;

function log(payload: Record<string, unknown>): void {
  console.error(JSON.stringify(payload));
}
