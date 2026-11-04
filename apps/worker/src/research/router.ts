/**
 * Issue → worker routing for the review loop.
 *
 * The reviewer stays read-only: it emits issues and instructions, never calls a
 * worker. This module turns those issues into a typed route plan. It is pure so
 * the routing rules are unit-testable without a queue or a database.
 *
 * One deterministic worker per cycle: when a review raises both `financials`
 * and `filings` issues with no profile rewrite, only the first deterministic
 * action runs. The follow-up review re-raises the other kind, which is routed
 * on the next bounded cycle. This keeps the loop resumable through pg-boss
 * instead of adding a cross-queue barrier.
 */

export const ISSUE_KINDS = [
  "profile",
  "financials",
  "filings",
  "entity",
  "ownership",
] as const;

export type IssueKind = (typeof ISSUE_KINDS)[number];

export type RouteTarget = "research" | "financials" | "filings" | "operator";

export interface ReviewTaskIssue {
  field: string;
  kind: IssueKind;
  reason: string;
  evidence?: string;
}

export interface ReviewAction {
  kind: IssueKind;
  route: RouteTarget;
  instruction: string;
  /** Indexes into the review's issue array, for audit. */
  issueIndexes: number[];
}

export interface ReviewRoutePlan {
  cycle: number;
  /** Every action implied by the review, including ones deferred this cycle. */
  actions: ReviewAction[];
  /** Actions to enqueue now: at most one deterministic route per cycle. */
  run: ReviewAction[];
  /** Deterministic kinds held over to the next review cycle. */
  deferred: IssueKind[];
  /** Kinds with no automated worker; an operator command is recorded. */
  operator: ReviewAction[];
  /** True when nothing can be automated for this review. */
  operatorOnly: boolean;
}

const ROUTE_BY_KIND: Record<IssueKind, RouteTarget> = {
  profile: "research",
  financials: "financials",
  filings: "filings",
  entity: "operator",
  ownership: "operator",
};

/**
 * There is no queue for entity resolution or ownership sync; both are
 * operator-run CLI batches with network and merge semantics. Record the exact
 * command instead of pretending a worker can fix them.
 */
export const OPERATOR_COMMANDS: Partial<Record<IssueKind, string>> = {
  entity:
    "node apps/cli/dist/occ.js entities enrich && node apps/cli/dist/occ.js entities resolve --apply",
  ownership:
    "node apps/cli/dist/occ.js ownership sync --market all --apply",
};

// Order matters: a shareholder issue that mentions "财务" is ownership.
const OWNERSHIP_RE =
  /股东|持股|股权|实际控制人|控股|权益披露|13F|DION|shareholder|stake|ownership/i;
const FILINGS_RE =
  /公告|披露文件|公告文件|10-K|10-Q|20-F|40-F|filing|招股|上市公告/i;
const FINANCIALS_RE =
  /财务|营收|收入|利润|净利|毛利|现金流|资产负债|EPS|ROE|毛利率|净利率|报告期|同比|环比|币种|单位|revenue|profit|cash flow|margin|balance sheet|earnings/i;
const ENTITY_RE =
  /主体|公司名称|上市地|交易所|证券代码|股票代码|ticker|更名|重组|合并|子公司|entity|listed entity/i;

export function isIssueKind(value: unknown): value is IssueKind {
  return (
    typeof value === "string" &&
    (ISSUE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Trust the reviewer's `kind` when it supplied a valid one; otherwise classify
 * from the field/reason text. Unknown kinds are treated as `profile` so a
 * review is never dropped on a schema technicality.
 */
export function classifyIssue(issue: {
  field: string;
  reason: string;
  kind?: unknown;
}): IssueKind {
  if (isIssueKind(issue.kind)) return issue.kind;
  const text = `${issue.field} ${issue.reason}`;
  if (OWNERSHIP_RE.test(text)) return "ownership";
  if (FILINGS_RE.test(text)) return "filings";
  if (FINANCIALS_RE.test(text)) return "financials";
  if (ENTITY_RE.test(text)) return "entity";
  return "profile";
}

export function planReviewRoute(input: {
  cycle: number;
  issues: ReviewTaskIssue[];
  fixInstructions: string;
}): ReviewRoutePlan {
  const groups = new Map<IssueKind, number[]>();
  input.issues.forEach((issue, index) => {
    const list = groups.get(issue.kind) ?? [];
    list.push(index);
    groups.set(issue.kind, list);
  });

  const actions: ReviewAction[] = [...groups.entries()].map(
    ([kind, issueIndexes]) => ({
      kind,
      route: ROUTE_BY_KIND[kind],
      instruction: instructionFor(kind, issueIndexes, input),
      issueIndexes,
    }),
  );

  const research = actions.filter((action) => action.route === "research");
  const deterministic = actions.filter(
    (action) => action.route === "financials" || action.route === "filings",
  );
  const operator = actions.filter((action) => action.route === "operator");

  let run: ReviewAction[];
  let deferred: IssueKind[] = [];
  if (research.length > 0) {
    // The research revision re-ingests and re-reviews, so the deterministic
    // workers can run alongside it without a second follow-up review.
    run = [...research, ...deterministic];
  } else if (deterministic.length > 0) {
    run = [deterministic[0]!];
    deferred = deterministic.slice(1).map((action) => action.kind);
  } else {
    run = [];
  }

  return {
    cycle: input.cycle,
    actions,
    run,
    deferred,
    operator,
    operatorOnly: run.length === 0,
  };
}

function instructionFor(
  kind: IssueKind,
  indexes: number[],
  input: { issues: ReviewTaskIssue[]; fixInstructions: string },
): string {
  const lines: string[] = [];
  if (input.fixInstructions.trim()) lines.push(input.fixInstructions.trim());
  lines.push(`问题类型：${kind}`);
  for (const index of indexes) {
    const issue = input.issues[index]!;
    lines.push(
      `- [${issue.field}] ${issue.reason}${issue.evidence ? `（证据：${issue.evidence}）` : ""}`,
    );
  }
  const command = OPERATOR_COMMANDS[kind];
  if (command) lines.push(`操作命令：${command}`);
  return lines.join("\n").slice(0, 6_000);
}

export type ReviewDecision =
  | { kind: "pass" }
  | {
      kind: "revise";
      issues: ReviewTaskIssue[];
      plan: ReviewRoutePlan;
      nextAttempt: number;
    }
  | {
      kind: "needs_review";
      reason: "cap" | "no_route";
      issues: ReviewTaskIssue[];
      plan: ReviewRoutePlan;
      message: string;
    };

/**
 * Turn a parsed reviewer result into the loop's next move.
 *
 * Missing sections are always a profile issue. `cap` is checked before
 * `no_route` so a company that exhausted its cycles stays `needs_review` even
 * if the last review only raised operator-only issues.
 */
export function decideReviewOutcome(input: {
  verdict: "pass" | "revise";
  issues: Array<{ field: string; reason: string; evidence?: string; kind?: unknown }>;
  missingSections: string[];
  fixInstructions: string;
  attempt: number;
  maxCycles: number;
}): ReviewDecision {
  const missing: ReviewTaskIssue[] =
    input.missingSections.length > 0
      ? [
          {
            field: "章节",
            kind: "profile",
            reason: `缺少章节：${input.missingSections.join("、")}`,
          },
        ]
      : [];
  const issues: ReviewTaskIssue[] = [
    ...missing,
    ...input.issues.map((issue) => ({
      field: issue.field,
      kind: classifyIssue(issue),
      reason: issue.reason,
      ...(issue.evidence ? { evidence: issue.evidence } : {}),
    })),
  ];

  if (input.verdict === "pass" && missing.length === 0) {
    return { kind: "pass" };
  }

  const plan = planReviewRoute({
    cycle: input.attempt,
    issues,
    fixInstructions: input.fixInstructions,
  });

  if (input.attempt >= input.maxCycles) {
    return {
      kind: "needs_review",
      reason: "cap",
      issues,
      plan,
      message: `reviewer requested revisions ${input.attempt + 1} time(s); cap reached`,
    };
  }

  if (plan.run.length === 0) {
    return {
      kind: "needs_review",
      reason: "no_route",
      issues,
      plan,
      message:
        "no automated worker for this review; operator action required" +
        (plan.operator.length > 0
          ? `: ${plan.operator.map((action) => action.kind).join(", ")}`
          : ""),
    };
  }

  return { kind: "revise", issues, plan, nextAttempt: input.attempt + 1 };
}
