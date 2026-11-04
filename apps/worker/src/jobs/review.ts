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
import { decideReviewOutcome } from "../research/router.js";
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
  /** Deterministic re-run of the structured statement layer. */
  enqueueFinancialsRerun?: (
    data: ReviewJobData,
    nextAttempt: number,
  ) => Promise<void>;
  /** Re-discover and ingest official filings for the company. */
  enqueueFilingsRefresh?: (
    data: ReviewJobData,
    nextAttempt: number,
  ) => Promise<void>;
  /**
   * Schedule the next review after a deterministic fix. The fix runs in
   * another process (e.g. the data worker), so this is time-delayed rather
   * than a completion callback.
   */
  enqueueReviewFollowUp?: (
    data: ReviewJobData,
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
    const decision = decideReviewOutcome({
      verdict: result.verdict,
      issues: result.issues,
      missingSections: missing,
      fixInstructions: result.fix_instructions,
      attempt,
      maxCycles: config.reviewMaxCycles,
    });

    if (decision.kind === "pass") {
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

    const feedback = formatFeedback(result.fix_instructions, decision.issues);
    // Persist the normalised issues (including synthesized missing-section
    // ones), not only the raw reviewer payload, so every needs_review row is
    // auditable from `company_research_state.review_result`.
    const reviewResult = {
      ...result,
      issues: decision.issues,
      routing: decision.plan,
    };

    // A selected route without a registered handler would loop forever, so it
    // is reported as an operator problem, exactly like the old single-handler
    // path. `operator` routes are recorded but never executed here.
    const missingHandlers = decision.plan.run.filter((action) => {
      if (action.route === "research") return !context.enqueueResearchRevision;
      if (action.route === "financials") return !context.enqueueFinancialsRerun;
      if (action.route === "filings") return !context.enqueueFilingsRefresh;
      return true;
    });
    const needsFollowUp =
      decision.kind === "revise" &&
      decision.plan.run.every((action) => action.route !== "research") &&
      decision.plan.run.length > 0 &&
      !context.enqueueReviewFollowUp;

    if (
      decision.kind === "needs_review" ||
      missingHandlers.length > 0 ||
      needsFollowUp
    ) {
      const message =
        decision.kind === "needs_review"
          ? decision.message
          : missingHandlers.length > 0
            ? `no handler registered for routed issue kind(s): ${missingHandlers.map((a) => a.kind).join(", ")}`
            : "routed fix needs a review follow-up handler, but none is registered";
      await markJobDead(data.runId, queue, data.key);
      await upsertCompanyState({
        companyId: data.key,
        status: "needs_review",
        runId: data.runId,
        reviewAttempts: attempt,
        lastError: `${message}\n${feedback}`.slice(0, 4_000),
        reviewResult,
      });
      log({
        event: "review_needs_review",
        run: data.runId,
        key: data.key,
        attempt,
        reason:
          decision.kind === "needs_review" ? decision.reason : "no_handler",
        message,
        issues: decision.issues.length,
        routed: decision.plan.run.map((action) => action.kind),
        operator: decision.plan.operator.map((action) => action.kind),
        deferred: decision.plan.deferred,
        inputTokens,
        outputTokens,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (decision.kind !== "revise") {
      // The needs_review path returned above; this keeps the type narrow.
      throw new Error("unexpected review decision");
    }
    const nextAttempt = decision.nextAttempt;
    await markJobCompleted(data.runId, queue, data.key);
    await upsertCompanyState({
      companyId: data.key,
      status: "running",
      runId: data.runId,
      reviewAttempts: nextAttempt,
      reviewResult,
    });

    const deterministic = decision.plan.run.filter(
      (action) => action.route === "financials" || action.route === "filings",
    );
    for (const action of deterministic) {
      if (action.route === "financials") {
        await context.enqueueFinancialsRerun!(data, nextAttempt);
      } else {
        await context.enqueueFilingsRefresh!(data, nextAttempt);
      }
    }
    for (const action of decision.plan.run) {
      if (action.route !== "research") continue;
      await context.enqueueResearchRevision!(data, feedback, nextAttempt);
    }
    if (deterministic.length > 0 && decision.plan.run.every((a) => a.route !== "research")) {
      await context.enqueueReviewFollowUp!(data, nextAttempt);
    }

    log({
      event: "review_revise_enqueued",
      run: data.runId,
      key: data.key,
      attempt: nextAttempt,
      issues: decision.issues.length,
      routed: decision.plan.run.map((action) => action.kind),
      operator: decision.plan.operator.map((action) => action.kind),
      deferred: decision.plan.deferred,
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
