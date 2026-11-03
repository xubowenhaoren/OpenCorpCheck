import { Pool, type QueryResultRow } from "pg";

export type RunKind = "research" | "f10" | "news" | "financials" | "data";

const DDL = `
CREATE TABLE IF NOT EXISTS backfill_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('research', 'f10', 'news', 'financials', 'data')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  total_jobs integer NOT NULL DEFAULT 0,
  completed_jobs integer NOT NULL DEFAULT 0,
  failed_jobs integer NOT NULL DEFAULT 0,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE backfill_runs DROP CONSTRAINT IF EXISTS backfill_runs_kind_check;
ALTER TABLE backfill_runs ADD CONSTRAINT backfill_runs_kind_check
  CHECK (kind IN ('research', 'f10', 'news', 'financials', 'data'));

CREATE TABLE IF NOT EXISTS backfill_jobs (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES backfill_runs(id) ON DELETE CASCADE,
  queue text NOT NULL,
  job_key text NOT NULL,
  company_id text NOT NULL,
  page text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'active', 'completed', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  duration_ms integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, queue, job_key)
);

CREATE INDEX IF NOT EXISTS backfill_jobs_run_status_idx
  ON backfill_jobs (run_id, status);
CREATE INDEX IF NOT EXISTS backfill_jobs_key_idx
  ON backfill_jobs (job_key);
CREATE INDEX IF NOT EXISTS backfill_jobs_company_status_idx
  ON backfill_jobs (company_id, status);

ALTER TABLE backfill_jobs ADD COLUMN IF NOT EXISTS duration_ms integer;
ALTER TABLE backfill_jobs
  ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS research_cache (
  company_id text PRIMARY KEY,
  prompt_hash text NOT NULL,
  section_sha256 text NOT NULL,
  section_path text NOT NULL,
  model text NOT NULL,
  tokens_input integer NOT NULL DEFAULT 0,
  tokens_output integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Operator-facing state machine for one company. Detailed job/checkpoint rows
-- stay in backfill_jobs; this table answers "where is this company now?".
CREATE TABLE IF NOT EXISTS company_research_state (
  company_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'reviewing', 'ready', 'failed', 'needs_review')),
  run_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  review_attempts integer NOT NULL DEFAULT 0,
  last_error text,
  review_result jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE company_research_state
  ADD COLUMN IF NOT EXISTS review_result jsonb;

CREATE INDEX IF NOT EXISTS company_research_state_status_idx
  ON company_research_state (status, updated_at);

CREATE TABLE IF NOT EXISTS f10_pages (
  market text NOT NULL,
  code text NOT NULL,
  page text NOT NULL,
  fetched_at timestamptz NOT NULL,
  http_status integer,
  text_chars integer NOT NULL DEFAULT 0,
  table_count integer NOT NULL DEFAULT 0,
  html_sha256 text,
  storage_key text,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market, code, page)
);
`;

export interface JobSpec {
  queue: string;
  jobKey: string;
  companyId: string;
  page?: string;
  payload: Record<string, unknown>;
}

export interface BackfillJobRow {
  run_id: string;
  queue: string;
  job_key: string;
  company_id: string;
  page: string | null;
  status: "queued" | "active" | "completed" | "failed" | "dead";
  attempts: number;
  last_error: string | null;
  payload: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface ResearchCacheRow {
  company_id: string;
  prompt_hash: string;
  section_sha256: string;
  section_path: string;
  model: string;
  tokens_input: number;
  tokens_output: number;
}

export type CompanyResearchStatus =
  | "queued"
  | "running"
  | "reviewing"
  | "ready"
  | "failed"
  | "needs_review";

export interface CompanyResearchStateRow {
  company_id: string;
  status: CompanyResearchStatus;
  run_id: string | null;
  attempts: number;
  review_attempts: number;
  last_error: string | null;
  review_result: unknown;
  requested_at: string;
  updated_at: string;
}

export interface RunSummary {
  run: Record<string, unknown> | null;
  counts: Record<string, number>;
  durationMs: {
    p50: number | null;
    p95: number | null;
    avg: number | null;
  };
  tokens: { input: number; output: number };
  /** Sum of per-job `meta.inserted` / `meta.skipped` (used by news sweeps). */
  news: { inserted: number; skipped: number };
  failed: Array<{
    company_id: string;
    page: string | null;
    attempts: number;
    last_error: string | null;
  }>;
}

export interface RunDetail {
  run: Record<string, unknown> | null;
  jobs: Array<{
    queue: string;
    job_key: string;
    company_id: string;
    page: string | null;
    status: string;
    attempts: number;
    last_error: string | null;
    duration_ms: number | null;
    started_at: Date | null;
    finished_at: Date | null;
    payload: Record<string, unknown>;
    meta: Record<string, unknown>;
  }>;
  summary: RunSummary;
}

/**
 * Postgres-backed run/checkpoint store shared by the API (enqueue + status)
 * and the worker (execute + checkpoint). The tables use `IF NOT EXISTS` so a
 * fresh database is usable without the worker having booted first.
 */
export class JobStore {
  readonly pool: Pool;

  constructor(
    connectionString: string,
    max = 10,
    applicationName = "occ",
  ) {
    this.pool = new Pool({
      connectionString,
      max,
      application_name: applicationName,
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(text, values);
    return result.rows;
  }

  async migrate(): Promise<void> {
    await this.pool.query(DDL);
  }

  async createRun(
    kind: RunKind,
    options: Record<string, unknown>,
    jobs: JobSpec[],
    explicitRunId?: string,
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO backfill_runs (id, kind, options, total_jobs)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3::jsonb, $4)
         RETURNING id`,
        [explicitRunId ?? null, kind, JSON.stringify(options), jobs.length],
      );
      const runId = inserted.rows[0]!.id;
      for (const job of jobs) {
        await client.query(
          `INSERT INTO backfill_jobs (run_id, queue, job_key, company_id, page, payload)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (run_id, queue, job_key) DO NOTHING`,
          [
            runId,
            job.queue,
            job.jobKey,
            job.companyId,
            job.page ?? null,
            JSON.stringify(job.payload),
          ],
        );
      }
      await client.query("COMMIT");
      return runId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getJobRow(
    runId: string,
    queue: string,
    jobKey: string,
  ): Promise<BackfillJobRow | null> {
    const rows = await this.query<BackfillJobRow>(
      `SELECT run_id, queue, job_key, company_id, page, status, attempts,
              last_error, payload, meta
       FROM backfill_jobs
       WHERE run_id = $1 AND queue = $2 AND job_key = $3`,
      [runId, queue, jobKey],
    );
    return rows[0] ?? null;
  }

  /**
   * Add a follow-up job (ingest) to an existing run. Runs are created with
   * research/news/F10 jobs only; ingest rows are appended when research finishes.
   */
  async createFollowUpJob(input: {
    runId: string;
    queue: string;
    jobKey: string;
    companyId: string;
    payload: object;
  }): Promise<void> {
    await this.query(
      `INSERT INTO backfill_jobs (run_id, queue, job_key, company_id, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (run_id, queue, job_key) DO NOTHING`,
      [
        input.runId,
        input.queue,
        input.jobKey,
        input.companyId,
        JSON.stringify(input.payload),
      ],
    );
    await this.refreshRun(input.runId);
  }

  async markJobActive(
    runId: string,
    queue: string,
    jobKey: string,
  ): Promise<void> {
    await this.query(
      `UPDATE backfill_jobs
       SET status = 'active', attempts = attempts + 1,
           started_at = now(), updated_at = now()
       WHERE run_id = $1 AND queue = $2 AND job_key = $3
         AND status <> 'completed'`,
      [runId, queue, jobKey],
    );
    await this.refreshRun(runId);
  }

  async markJobCompleted(
    runId: string,
    queue: string,
    jobKey: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await this.query(
      `UPDATE backfill_jobs
       SET status = 'completed', finished_at = now(), updated_at = now(),
           duration_ms = CASE
             WHEN started_at IS NULL THEN NULL
             ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int
           END,
           meta = COALESCE($4::jsonb, meta),
           last_error = NULL
       WHERE run_id = $1 AND queue = $2 AND job_key = $3`,
      [
        runId,
        queue,
        jobKey,
        meta === undefined ? null : JSON.stringify(meta),
      ],
    );
    await this.refreshRun(runId);
  }

  /** Reopen a completed/failed row for a bounded reviewer-driven retry. */
  async resetJobForRetry(
    runId: string,
    queue: string,
    jobKey: string,
  ): Promise<void> {
    await this.query(
      `UPDATE backfill_jobs
       SET status = 'queued', started_at = NULL, finished_at = NULL,
           last_error = NULL, updated_at = now()
       WHERE run_id = $1 AND queue = $2 AND job_key = $3`,
      [runId, queue, jobKey],
    );
    await this.refreshRun(runId);
  }

  async markJobFailed(
    runId: string,
    queue: string,
    jobKey: string,
    error: string,
  ): Promise<void> {
    await this.query(
      `UPDATE backfill_jobs
       SET status = 'failed', last_error = $4, updated_at = now(),
           duration_ms = CASE
             WHEN started_at IS NULL THEN NULL
             ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int
           END
       WHERE run_id = $1 AND queue = $2 AND job_key = $3
         AND status <> 'completed'`,
      [runId, queue, jobKey, error.slice(0, 4_000)],
    );
    await this.refreshRun(runId);
  }

  async markJobDead(
    runId: string,
    queue: string,
    jobKey: string,
  ): Promise<void> {
    await this.query(
      `UPDATE backfill_jobs
       SET status = 'dead', finished_at = now(), updated_at = now()
       WHERE run_id = $1 AND queue = $2 AND job_key = $3
         AND status <> 'completed'`,
      [runId, queue, jobKey],
    );
    await this.refreshRun(runId);
  }

  /** Dead-letter workers do not know the origin queue; a run only uses one queue. */
  async markJobDeadByKey(
    runId: string,
    jobKey: string,
    queue?: string,
  ): Promise<void> {
    await this.query(
      `UPDATE backfill_jobs
       SET status = 'dead', finished_at = now(), updated_at = now()
       WHERE run_id = $1 AND job_key = $2
         AND ($3::text IS NULL OR queue = $3)
         AND status <> 'completed'`,
      [runId, jobKey, queue ?? null],
    );
    await this.refreshRun(runId);
  }

  async refreshRun(runId: string): Promise<void> {
    await this.query(
      `UPDATE backfill_runs r
       SET completed_jobs = c.completed,
           failed_jobs = c.dead,
           total_jobs = c.total,
           status = CASE
             WHEN c.pending > 0 THEN 'running'
             WHEN c.completed = c.total AND c.dead = 0 THEN 'completed'
             WHEN c.completed = 0 AND c.dead > 0 THEN 'failed'
             ELSE 'partial'
           END,
           updated_at = now()
       FROM (
         SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(*) FILTER (WHERE status = 'dead')::int AS dead,
                count(*) FILTER (WHERE status IN ('queued', 'active', 'failed'))::int AS pending
         FROM backfill_jobs
         WHERE run_id = $1
       ) c
       WHERE r.id = $1`,
      [runId],
    );
  }

  async upsertCompanyState(input: {
    companyId: string;
    status: CompanyResearchStatus;
    runId?: string | null;
    attempts?: number;
    reviewAttempts?: number;
    lastError?: string | null;
    reviewResult?: unknown;
  }): Promise<void> {
    await this.query(
      `INSERT INTO company_research_state (
         company_id, status, run_id, attempts, review_attempts, last_error,
         review_result, requested_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now(), now())
       ON CONFLICT (company_id) DO UPDATE SET
         status = EXCLUDED.status,
         run_id = COALESCE(EXCLUDED.run_id, company_research_state.run_id),
         attempts = CASE
           WHEN EXCLUDED.status = 'queued' THEN EXCLUDED.attempts
           ELSE GREATEST(company_research_state.attempts, EXCLUDED.attempts)
         END,
         review_attempts = CASE
           WHEN EXCLUDED.status = 'queued' THEN EXCLUDED.review_attempts
           ELSE GREATEST(
             company_research_state.review_attempts, EXCLUDED.review_attempts
           )
         END,
         last_error = EXCLUDED.last_error,
         review_result = COALESCE(
           EXCLUDED.review_result, company_research_state.review_result
         ),
         requested_at = CASE
           WHEN EXCLUDED.status = 'queued' THEN now()
           ELSE company_research_state.requested_at
         END,
         updated_at = now()`,
      [
        input.companyId,
        input.status,
        input.runId ?? null,
        input.attempts ?? 0,
        input.reviewAttempts ?? 0,
        input.lastError ?? null,
        input.reviewResult === undefined
          ? null
          : JSON.stringify(input.reviewResult),
      ],
    );
  }

  async getCompanyState(companyId: string): Promise<CompanyResearchStateRow | null> {
    const rows = await this.query<CompanyResearchStateRow>(
      `SELECT company_id, status, run_id, attempts, review_attempts, last_error,
              review_result, requested_at, updated_at
       FROM company_research_state WHERE company_id = $1`,
      [companyId],
    );
    return rows[0] ?? null;
  }

  async listCompanyStates(limit = 100): Promise<CompanyResearchStateRow[]> {
    return this.query<CompanyResearchStateRow>(
      `SELECT company_id, status, run_id, attempts, review_attempts, last_error,
              review_result, requested_at, updated_at
       FROM company_research_state
       ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    );
  }

  async getResearchCache(companyId: string): Promise<ResearchCacheRow | null> {
    const rows = await this.query<ResearchCacheRow>(
      `SELECT company_id, prompt_hash, section_sha256, section_path, model,
              tokens_input, tokens_output
       FROM research_cache WHERE company_id = $1`,
      [companyId],
    );
    return rows[0] ?? null;
  }

  async upsertResearchCache(input: {
    companyId: string;
    promptHash: string;
    sectionSha256: string;
    sectionPath: string;
    model: string;
    tokensInput: number;
    tokensOutput: number;
  }): Promise<void> {
    await this.query(
      `INSERT INTO research_cache (
         company_id, prompt_hash, section_sha256, section_path, model,
         tokens_input, tokens_output, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (company_id) DO UPDATE SET
         prompt_hash = EXCLUDED.prompt_hash,
         section_sha256 = EXCLUDED.section_sha256,
         section_path = EXCLUDED.section_path,
         model = EXCLUDED.model,
         tokens_input = EXCLUDED.tokens_input,
         tokens_output = EXCLUDED.tokens_output,
         updated_at = now()`,
      [
        input.companyId,
        input.promptHash,
        input.sectionSha256,
        input.sectionPath,
        input.model,
        input.tokensInput,
        input.tokensOutput,
      ],
    );
  }

  async upsertF10Page(input: {
    market: string;
    code: string;
    page: string;
    fetchedAt: string;
    httpStatus: number | null;
    textChars: number;
    tableCount: number;
    htmlSha256: string | null;
    storageKey: string | null;
    warnings: string[];
  }): Promise<void> {
    await this.query(
      `INSERT INTO f10_pages (
         market, code, page, fetched_at, http_status, text_chars, table_count,
         html_sha256, storage_key, warnings, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now())
       ON CONFLICT (market, code, page) DO UPDATE SET
         fetched_at = EXCLUDED.fetched_at,
         http_status = EXCLUDED.http_status,
         text_chars = EXCLUDED.text_chars,
         table_count = EXCLUDED.table_count,
         html_sha256 = EXCLUDED.html_sha256,
         storage_key = EXCLUDED.storage_key,
         warnings = EXCLUDED.warnings,
         updated_at = now()`,
      [
        input.market,
        input.code,
        input.page,
        input.fetchedAt,
        input.httpStatus,
        input.textChars,
        input.tableCount,
        input.htmlSha256,
        input.storageKey,
        JSON.stringify(input.warnings),
      ],
    );
  }

  async getRunSummary(runId: string): Promise<RunSummary> {
    const runs = await this.query<Record<string, unknown>>(
      `SELECT id, kind, status, total_jobs, completed_jobs, failed_jobs,
              options, created_at, updated_at
       FROM backfill_runs WHERE id = $1`,
      [runId],
    );
    const counts = await this.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
       FROM backfill_jobs WHERE run_id = $1 GROUP BY status`,
      [runId],
    );
    const failed = await this.query<{
      company_id: string;
      page: string | null;
      attempts: number;
      last_error: string | null;
    }>(
      `SELECT company_id, page, attempts, last_error
       FROM backfill_jobs
       WHERE run_id = $1 AND status = 'dead'
       ORDER BY company_id, page
       LIMIT 50`,
      [runId],
    );
    const durations = await this.query<{
      p50: number | null;
      p95: number | null;
      avg: number | null;
    }>(
      `SELECT
         percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS p50,
         percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95,
         avg(duration_ms)::int AS avg
       FROM backfill_jobs
       WHERE run_id = $1 AND duration_ms IS NOT NULL`,
      [runId],
    );
    const tokens = await this.query<{ input: number | null; output: number | null }>(
      `SELECT sum(rc.tokens_input)::int AS input,
              sum(rc.tokens_output)::int AS output
       FROM research_cache rc
       JOIN backfill_jobs j ON j.company_id = rc.company_id
       WHERE j.run_id = $1 AND j.queue = 'research.company'`,
      [runId],
    );
    const news = await this.query<{ inserted: number | null; skipped: number | null }>(
      `SELECT coalesce(sum((meta->>'inserted')::int), 0)::int AS inserted,
              coalesce(sum((meta->>'skipped')::int), 0)::int AS skipped
       FROM backfill_jobs
       WHERE run_id = $1 AND queue = 'news.company'`,
      [runId],
    );
    return {
      run: runs[0] ?? null,
      counts: Object.fromEntries(
        counts.map((row) => [row.status, Number(row.count)]),
      ),
      durationMs: durations[0] ?? { p50: null, p95: null, avg: null },
      tokens: {
        input: Number(tokens[0]?.input ?? 0),
        output: Number(tokens[0]?.output ?? 0),
      },
      news: {
        inserted: Number(news[0]?.inserted ?? 0),
        skipped: Number(news[0]?.skipped ?? 0),
      },
      failed,
    };
  }

  async getRunDetail(runId: string): Promise<RunDetail> {
    const summary = await this.getRunSummary(runId);
    const jobs = await this.query<RunDetail["jobs"][number]>(
      `SELECT queue, job_key, company_id, page, status, attempts, last_error,
              duration_ms, started_at, finished_at, payload, meta
       FROM backfill_jobs
       WHERE run_id = $1
       ORDER BY id`,
      [runId],
    );
    return { run: summary.run, jobs, summary };
  }

  async listRuns(limit = 10): Promise<Record<string, unknown>[]> {
    return this.query<Record<string, unknown>>(
      `SELECT id, kind, status, total_jobs, completed_jobs, failed_jobs,
              created_at, updated_at
       FROM backfill_runs ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
  }

  /** Runs of one kind, newest first (P1.5 `occ-refresh status`). */
  async listRunsByKind(
    kind: RunKind,
    limit = 10,
  ): Promise<Record<string, unknown>[]> {
    return this.query<Record<string, unknown>>(
      `SELECT id, kind, status, total_jobs, completed_jobs, failed_jobs,
              options, created_at, updated_at
       FROM backfill_runs
       WHERE kind = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [kind, limit],
    );
  }

  /** Drop run history of one kind older than the retention window. */
  async pruneRuns(kind: RunKind, olderThanMs: number): Promise<number> {
    const rows = await this.query<{ count: number }>(
      `WITH gone AS (
         DELETE FROM backfill_runs
         WHERE kind = $1
           AND created_at < now() - ($2::int * interval '1 millisecond')
         RETURNING 1
       )
       SELECT count(*)::int AS count FROM gone`,
      [kind, olderThanMs],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Automatic news sweeps inside the retention window, newest first. The dock
   * reads this so a completed sweep is still visible after the operator was
   * away; manual `enqueue news` runs are included only when they carry the
   * same shape (they are still `kind='news'`).
   */
  async listNewsSweeps(
    sinceMs: number,
    limit = 20,
  ): Promise<Array<Record<string, unknown>>> {
    return this.query<Record<string, unknown>>(
      `SELECT r.id, r.kind, r.status, r.total_jobs, r.completed_jobs,
              r.failed_jobs, r.options, r.created_at, r.updated_at,
              coalesce((SELECT sum((j.meta->>'inserted')::int)
                          FROM backfill_jobs j WHERE j.run_id = r.id), 0)::int
                AS inserted,
              coalesce((SELECT sum((j.meta->>'skipped')::int)
                          FROM backfill_jobs j WHERE j.run_id = r.id), 0)::int
                AS skipped
       FROM backfill_runs r
       WHERE r.kind = 'news'
         AND r.created_at >= now() - ($1::int * interval '1 millisecond')
       ORDER BY r.created_at DESC
       LIMIT $2`,
      [sinceMs, limit],
    );
  }

  /**
   * Automatic daily data/filing runs inside the retention window, newest
   * first (shared TaskDock). `companies` counts the distinct checked
   * companies; `inserted` is the number of newly detected filings;
   * `documents` is the number of filing documents ingested; `financials`
   * counts the follow-up financials jobs (periodic reports + catch-ups).
   */
  async listDataRuns(
    sinceMs: number,
    limit = 20,
  ): Promise<Array<Record<string, unknown>>> {
    return this.query<Record<string, unknown>>(
      `SELECT r.id, r.kind, r.status, r.total_jobs, r.completed_jobs,
              r.failed_jobs, r.options, r.created_at, r.updated_at,
              (SELECT count(DISTINCT j.company_id)
                 FROM backfill_jobs j
                 WHERE j.run_id = r.id
                   AND j.queue IN ('data.source.check', 'financials.company'))::int
                AS companies,
              coalesce((SELECT sum((j.meta->>'inserted')::int)
                          FROM backfill_jobs j
                          WHERE j.run_id = r.id AND j.queue = 'data.source.check'),
                       0)::int AS inserted,
              coalesce((SELECT sum((j.meta->>'inserted')::int)
                          FROM backfill_jobs j
                          WHERE j.run_id = r.id AND j.queue = 'ingest.filing'),
                       0)::int AS documents,
              (SELECT count(*)
                 FROM backfill_jobs j
                 WHERE j.run_id = r.id AND j.queue = 'financials.company')::int
                AS financials
       FROM backfill_runs r
       WHERE r.kind = 'data'
         AND r.created_at >= now() - ($1::int * interval '1 millisecond')
       ORDER BY r.created_at DESC
       LIMIT $2`,
      [sinceMs, limit],
    );
  }

  /** The most recent news sweep, active or finished. */
  async getLatestNewsSweep(): Promise<Record<string, unknown> | null> {
    const rows = await this.query<Record<string, unknown>>(
      `SELECT r.id, r.status, r.total_jobs, r.completed_jobs, r.failed_jobs,
              r.options, r.created_at, r.updated_at
       FROM backfill_runs r
       WHERE r.kind = 'news'
       ORDER BY r.created_at DESC
       LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  /**
   * The newest news job for one company key. `company_id` in backfill_jobs is
   * the canonical key (`US:AAPL`), which is also what the worker logs.
   */
  async getNewsJobForCompany(
    key: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.query<Record<string, unknown>>(
      `SELECT r.id AS run_id, r.status AS run_status, r.total_jobs,
              r.completed_jobs, r.failed_jobs, r.created_at, r.updated_at,
              j.status AS job_status, j.last_error, j.meta, j.started_at,
              j.finished_at
       FROM backfill_jobs j
       JOIN backfill_runs r ON r.id = j.run_id
       WHERE r.kind = 'news' AND j.company_id = $1
       ORDER BY r.created_at DESC
       LIMIT 1`,
      [key],
    );
    return rows[0] ?? null;
  }

  /** Drop news run history older than the retention window (default 3 days). */
  async pruneNewsRuns(olderThanMs: number): Promise<number> {
    const rows = await this.query<{ count: number }>(
      `WITH gone AS (
         DELETE FROM backfill_runs
         WHERE kind = 'news'
           AND created_at < now() - ($1::int * interval '1 millisecond')
         RETURNING 1
       )
       SELECT count(*)::int AS count FROM gone`,
      [olderThanMs],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
