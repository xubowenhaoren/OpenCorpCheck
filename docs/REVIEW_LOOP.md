# Review loop — issue routing

> Status: shipped 2026-11-03 (P4). Public design record. This document
> describes the hidden quality gate only; the reviewer is not part of the
> public UI.

OpenCorpCheck research is a bounded quality loop, not a one-shot generation:

```text
research.company → ingest.company → review.company
       ↑                                  │
       │            verdict=revise        │
       └──────────── fix, then re-review ─┘
```

The loop has two jobs:

1. **Research** writes a profile section (markdown) with citations.
2. **Review** is a second, read-only agent that checks sections, numbers and
   citations and returns a typed verdict.

Before P4 every `revise` re-ran the *entire* research profile. P4 keeps the
loop but routes each issue to the worker that can actually fix it:

```text
review.company
  ├─ issue kind=profile    → research.company (bounded revision)
  ├─ issue kind=financials → financials.company (deterministic re-run)
  ├─ issue kind=filings    → data.source.check → ingest.filing
  ├─ issue kind=entity     → operator action (recorded, not executed)
  └─ issue kind=ownership  → operator action (recorded, not executed)
```

The reviewer never writes data and never calls a worker directly. It emits a
routing *suggestion*; the review job decides what to enqueue.

---

## 1. State machine

| State | Meaning |
|---|---|
| `researching` | `research.company` is running |
| `ingesting` | `ingest.company` is running |
| `reviewing` | `review.company` is running |
| `ready` | reviewer returned `pass`; the profile is publishable |
| `needs_review` | the loop stopped: cycle cap, malformed reviewer, or no automated route |
| `failed` | an infrastructure stage failed (research/ingest dead-letter) |
| `queued` | a job was enqueued and has not started |

```text
queued → researching → ingesting → reviewing ──pass──→ ready
                              ↑          │
                              │          ├─revise─→ route → (fix) → reviewing
                              │          │
                              └──────────┴─cap / no_route / parse error → needs_review
```

- `needs_review` is **the quality gate working**, not a bug. It is never
  silently flipped to `ready`.
- `abandoned` is **not implemented**; it exists only as a documented future
  terminal state for an explicit operator decision. The default terminal state
  stays `needs_review`.
- Queue retries are *infrastructure* retries and separate from quality cycles:
  a failed research/ingest/review job may retry; only a reviewer `revise`
  consumes a quality cycle.

### Queues (pg-boss)

| Queue | Role |
|---|---|
| `research.company` | writes one profile section |
| `ingest.company` | sections → documents/chunks → Qdrant, extraction |
| `review.company` | hidden reviewer; emits the typed verdict |
| `financials.company` | deterministic XBRL/F10 statement layer |
| `data.source.check` | official filing index diff for one company/source |
| `ingest.filing` | detected filing → document/chunks |
| `*.dead` | exhausted jobs; the worker marks the row dead |

Postgres is the state store and pg-boss is the transport. There is no
agent-to-agent socket or wire protocol.

---

## 2. The typed review envelope

The reviewer returns JSON:

```json
{
  "verdict": "pass",
  "issues": [
    {
      "field": "5. 财务表现",
      "kind": "financials",
      "reason": "FY2025 revenue disagrees with the annual report",
      "evidence": "https://example.com/annual-report"
    }
  ],
  "fix_instructions": "Rewrite section 5 from the structured statement"
}
```

| Field | Rule |
|---|---|
| `verdict` | `pass` or `revise` only. Synonyms (`reject`, `approved`, ...) are normalised; an unparseable review retries the reviewer, never research |
| `issues[].field` | section or field name |
| `issues[].kind` | optional routing hint: `profile`, `financials`, `filings`, `entity`, `ownership`. Invalid values are ignored |
| `issues[].reason` | what is wrong (bounded) |
| `issues[].evidence` | quote or URL the reviewer inspected |

The review job then builds a `ReviewTask`:

```ts
interface ReviewTask {
  runId: string;
  key: string;                  // A:600519, HK:00700, US:AAPL
  cycle: number;                // 0-based review cycle
  verdict: "pass" | "revise";
  issues: Array<{ field: string; kind: IssueKind; reason: string; evidence?: string }>;
  actions: Array<{ kind: IssueKind; route: RouteTarget; instruction: string }>;
  budget: { maxCycles: number };
}
```

Issues without a valid `kind` are classified deterministically from
field/reason keywords. **Order matters**: shareholder/ownership wording wins
over "financial", filings wording over financials, and anything unknown falls
back to `profile` (a full but safe revision).

Missing required sections are always a `profile` issue.

---

## 3. Issue → worker routing

| Issue kind | Route | What runs | Re-review |
|---|---|---|---|
| `profile` / narrative / citation | `research` | `research.company` with scoped feedback, `force=true` | via ingest |
| `financials` | `financials` | `financials.company` (deterministic, cache bypass) | delayed follow-up |
| `filings` | `filings` | `data.source.check` → `ingest.filing` for the company | delayed follow-up |
| `entity` | `operator` | no queue; records the exact `occ entities …` command | none |
| `ownership` | `operator` | no queue; records the exact `occ ownership sync …` command | none |

Rules:

- **At most one deterministic route per cycle** when no profile rewrite is
  needed. If a review raises both `financials` and `filings`, the first is run
  and the other is recorded as deferred; the follow-up review re-raises it and
  it is routed on the next cycle. This avoids a cross-queue barrier.
- A profile rewrite re-ingests and re-reviews on its own, so deterministic
  fixes selected alongside it do not schedule a second review.
- `entity` and `ownership` are operator-run batch commands (network calls,
  merge semantics, review-queue side effects), not worker jobs. A review that
  only raises them ends in `needs_review` with the command and issues in
  `last_error`; it does not burn another cycle.
- A routed fix schedules its follow-up review after
  `OCC_REVIEW_ROUTE_DELAY_MS` (default 120 s). The delay is intentional: the
  fix may run in another worker process (for example the daily data worker),
  so the loop cannot wait on a completion callback.
- The reviewer is read-only and runs with an explicit tool whitelist: web
  search/fetch only, no shell, no filesystem, no jobs, no sub-agent.

### Routing record

The full routing decision is persisted as JSON in
`company_research_state.review_result.routing`:

```json
{
  "cycle": 1,
  "run": [{ "kind": "financials", "route": "financials" }],
  "deferred": ["filings"],
  "operator": []
}
```

This survives worker restarts through the state row and makes
`occ-backfill states` auditable (`route=financials`).

---

## 4. Verdict semantics

| Outcome | Trigger | Effect |
|---|---|---|
| `pass` | reviewer `pass` and all required sections present | state `ready`, job completed |
| `revise` | at least one runnable action and cycle budget left | state `running`, fix enqueued, review attempt + 1 |
| `needs_review` (cap) | review attempt reached `OCC_REVIEW_MAX_CYCLES` (default 2) | state `needs_review`, review job dead-lettered, structured issues and `last_error` recorded |
| `needs_review` (no route) | only `entity`/`ownership` issues, or no handler registered | same, with the operator command |
| `needs_review` (parse) | reviewer JSON invalid after `OCC_REVIEW_PARSE_ATTEMPTS` | operator problem; research is not retried |

The cycle cap is per company. It counts reviewer revisions, not infrastructure
retries. Cost is bounded by `maxCycles + 1` reviewer turns per company.

---

## 5. Observability

Worker logs are one JSON object per line:

| Event | Fields |
|---|---|
| `review_passed` | run, key, attempt, toolCalls, input/output tokens, duration |
| `review_revise_enqueued` | attempt, `routed`, `operator`, `deferred`, issues, feedback, tokens, duration |
| `review_needs_review` | `reason` (`cap` / `no_route` / `no_handler`), routed/operator/deferred, issues, message |
| `review_route_financials` | run, key, attempt |
| `review_route_filings` | run, key, attempt, source |
| `review_job_failed` | error, retryCount |

Operator view:

```bash
node apps/worker/dist/cli.js states --limit 60
# A:688008  needs_review  attempts=1 review=2 verdict=revise issues=3 route=financials operator=ownership
```

`review_result` holds the verdict, issues, fix instructions and the routing
record. `last_error` holds the terminal reason plus the formatted feedback, so
a `needs_review` row is always actionable.

---

## 6. Why queue orchestration, not the A2A wire protocol

The loop already needs durability, bounded retries, concurrency limits and a
per-company state machine. pg-boss + Postgres provide all of that locally and
survive restarts; the workers are the same process the backfill already uses.

A2A (agent cards, task envelopes over HTTP/JSON-RPC) is useful when *external*
agents must discover and call each other. Here every worker is internal, the
transport is a transactional queue, and a wire protocol would add a second
source of truth for task state without adding a capability. This stays queue
orchestration unless external-agent interop becomes a product requirement.

Non-goals for this design:

- no direct reviewer → worker chat or socket;
- no reviewer write access;
- no full-profile rewrite when a targeted data re-run is enough;
- no unlocking the cycle cap to “fix” a stubborn profile.
