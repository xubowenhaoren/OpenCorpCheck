/**
 * Financials verification decision (P1.5 follow-up).
 *
 * A periodic report is detected from the official index, but A/HK structured
 * financials (F10) often lag the announcement. Verification is deterministic:
 * compare the newest `financial_facts.period_end` with the expected period and
 * either mark the company applied or schedule a bounded retry.
 *
 * Pure so the retry schedule can be tested without a database or worker.
 */

export type FinancialsVerificationStatus = "applied" | "pending" | "failed";

export interface FinancialsVerificationInput {
  /** `YYYY-MM-DD` from the periodic filing (adapter or deterministic title parser). */
  expectedPeriodEnd: string;
  /** `max(financial_facts.period_end)`; null when no structured facts exist. */
  maxPeriodEnd: string | null;
  attempts: number;
  firstSeenAt: Date;
  now: Date;
  /** Give up after this many days from `firstSeenAt` (default 7). */
  maxDays: number;
}

export interface FinancialsVerificationResult {
  status: FinancialsVerificationStatus;
  attempts: number;
  nextRetryAt: Date | null;
  /** True when the expected period is covered by the stored facts. */
  covered: boolean;
}

/** 1 hour, 6 hours, then daily. */
export const FINANCIALS_RETRY_BACKOFF_MS: readonly number[] = [
  3_600_000,
  21_600_000,
  86_400_000,
];

/**
 * 52/53-week fiscal years end a few days before the calendar quarter/month
 * end (Apple's 10-K ends 2026-09-26, not 2026-09-30). A week of tolerance
 * covers that without mistaking Q2 for Q3 (a full quarter apart).
 */
export const FINANCIALS_PERIOD_TOLERANCE_DAYS = 7;

const DAY_MS = 86_400_000;

function parseDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(time) ? time : null;
}

export function financialsPeriodCovered(
  expectedPeriodEnd: string,
  maxPeriodEnd: string | null,
): boolean {
  if (!maxPeriodEnd) return false;
  const expected = parseDay(expectedPeriodEnd);
  const actual = parseDay(maxPeriodEnd);
  if (expected === null || actual === null) return false;
  return actual >= expected - FINANCIALS_PERIOD_TOLERANCE_DAYS * DAY_MS;
}

export function financialsVerification(
  input: FinancialsVerificationInput,
): FinancialsVerificationResult {
  if (financialsPeriodCovered(input.expectedPeriodEnd, input.maxPeriodEnd)) {
    return { status: "applied", attempts: input.attempts, nextRetryAt: null, covered: true };
  }

  const attempts = Math.max(0, input.attempts) + 1;
  const backoff =
    FINANCIALS_RETRY_BACKOFF_MS[
      Math.min(Math.max(0, input.attempts), FINANCIALS_RETRY_BACKOFF_MS.length - 1)
    ]!;
  const nextRetryAt = new Date(input.now.getTime() + backoff);
  const deadline = new Date(
    input.firstSeenAt.getTime() + Math.max(1, input.maxDays) * DAY_MS,
  );
  if (input.now.getTime() >= deadline.getTime() || nextRetryAt.getTime() > deadline.getTime()) {
    return { status: "failed", attempts, nextRetryAt: null, covered: false };
  }
  return { status: "pending", attempts, nextRetryAt, covered: false };
}
