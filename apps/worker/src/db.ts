import { Pool, type QueryResultRow } from "pg";

import { config } from "./config.js";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  application_name: "occ-worker",
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, values);
  return result.rows;
}

const DDL = `
CREATE TABLE IF NOT EXISTS backfill_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('research', 'f10')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  total_jobs integer NOT NULL DEFAULT 0,
  completed_jobs integer NOT NULL DEFAULT 0,
  failed_jobs integer NOT NULL DEFAULT 0,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

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

ALTER TABLE backfill_jobs ADD COLUMN IF NOT EXISTS duration_ms integer;

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

export async function migrate(): Promise<void> {
  await pool.query(DDL);
}

export interface JobSpec {
  queue: string;
  jobKey: string;
  companyId: string;
  page?: string;
  payload: Record<string, unknown>;
}

export async function createRun(
  kind: "research" | "f10",
  options: Record<string, unknown>,
  jobs: JobSpec[],
  explicitRunId?: string,
): Promise<string> {
  const client = await pool.connect();
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
}

export async function getJobRow(
  runId: string,
  queue: string,
  jobKey: string,
): Promise<BackfillJobRow | null> {
  const rows = await query<BackfillJobRow>(
    `SELECT run_id, queue, job_key, company_id, page, status, attempts,
            last_error, payload
     FROM backfill_jobs
     WHERE run_id = $1 AND queue = $2 AND job_key = $3`,
    [runId, queue, jobKey],
  );
  return rows[0] ?? null;
}

/**
 * Add a follow-up job (currently ingest) to an existing run. Runs are created
 * with research/F10 jobs only; ingest rows are appended when research finishes.
 */
export async function createFollowUpJob(input: {
  runId: string;
  queue: string;
  jobKey: string;
  companyId: string;
  payload: object;
}): Promise<void> {
  await query(
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
  await refreshRun(input.runId);
}

export async function markJobActive(
  runId: string,
  queue: string,
  jobKey: string,
): Promise<void> {
  await query(
    `UPDATE backfill_jobs
     SET status = 'active', attempts = attempts + 1,
         started_at = now(), updated_at = now()
     WHERE run_id = $1 AND queue = $2 AND job_key = $3
       AND status <> 'completed'`,
    [runId, queue, jobKey],
  );
}

export async function markJobCompleted(
  runId: string,
  queue: string,
  jobKey: string,
): Promise<void> {
  await query(
    `UPDATE backfill_jobs
     SET status = 'completed', finished_at = now(), updated_at = now(),
         duration_ms = CASE
           WHEN started_at IS NULL THEN NULL
           ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int
         END,
         last_error = NULL
     WHERE run_id = $1 AND queue = $2 AND job_key = $3`,
    [runId, queue, jobKey],
  );
  await refreshRun(runId);
}

export async function markJobFailed(
  runId: string,
  queue: string,
  jobKey: string,
  error: string,
): Promise<void> {
  await query(
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
  await refreshRun(runId);
}

export async function markJobDead(
  runId: string,
  queue: string,
  jobKey: string,
): Promise<void> {
  await query(
    `UPDATE backfill_jobs
     SET status = 'dead', finished_at = now(), updated_at = now()
     WHERE run_id = $1 AND queue = $2 AND job_key = $3
       AND status <> 'completed'`,
    [runId, queue, jobKey],
  );
  await refreshRun(runId);
}

/** Dead-letter workers do not know the origin queue; a run only uses one queue. */
export async function markJobDeadByKey(
  runId: string,
  jobKey: string,
): Promise<void> {
  await query(
    `UPDATE backfill_jobs
     SET status = 'dead', finished_at = now(), updated_at = now()
     WHERE run_id = $1 AND job_key = $2
       AND status <> 'completed'`,
    [runId, jobKey],
  );
  await refreshRun(runId);
}

export async function refreshRun(runId: string): Promise<void> {
  await query(
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

export interface ResearchCacheRow {
  company_id: string;
  prompt_hash: string;
  section_sha256: string;
  section_path: string;
  model: string;
  tokens_input: number;
  tokens_output: number;
}

export async function getResearchCache(
  companyId: string,
): Promise<ResearchCacheRow | null> {
  const rows = await query<ResearchCacheRow>(
    `SELECT company_id, prompt_hash, section_sha256, section_path, model,
            tokens_input, tokens_output
     FROM research_cache WHERE company_id = $1`,
    [companyId],
  );
  return rows[0] ?? null;
}

export async function upsertResearchCache(input: {
  companyId: string;
  promptHash: string;
  sectionSha256: string;
  sectionPath: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
}): Promise<void> {
  await query(
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

export async function upsertF10Page(input: {
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
  await query(
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

export interface RunSummary {
  run: Record<string, unknown> | null;
  counts: Record<string, number>;
  durationMs: {
    p50: number | null;
    p95: number | null;
    avg: number | null;
  };
  tokens: { input: number; output: number };
  failed: Array<{
    company_id: string;
    page: string | null;
    attempts: number;
    last_error: string | null;
  }>;
}

export async function getRunSummary(runId: string): Promise<RunSummary> {
  const runs = await query<Record<string, unknown>>(
    `SELECT id, kind, status, total_jobs, completed_jobs, failed_jobs,
            options, created_at, updated_at
     FROM backfill_runs WHERE id = $1`,
    [runId],
  );
  const counts = await query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count
     FROM backfill_jobs WHERE run_id = $1 GROUP BY status`,
    [runId],
  );
  const failed = await query<{
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
  const durations = await query<{
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
  const tokens = await query<{ input: number | null; output: number | null }>(
    `SELECT sum(rc.tokens_input)::int AS input,
            sum(rc.tokens_output)::int AS output
     FROM research_cache rc
     JOIN backfill_jobs j ON j.company_id = rc.company_id
     WHERE j.run_id = $1 AND j.queue = 'research.company'`,
    [runId],
  );
  return {
    run: runs[0] ?? null,
    counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])),
    durationMs: durations[0] ?? { p50: null, p95: null, avg: null },
    tokens: {
      input: Number(tokens[0]?.input ?? 0),
      output: Number(tokens[0]?.output ?? 0),
    },
    failed,
  };
}

export async function listRuns(limit = 10): Promise<Record<string, unknown>[]> {
  return query<Record<string, unknown>>(
    `SELECT id, kind, status, total_jobs, completed_jobs, failed_jobs,
            created_at, updated_at
     FROM backfill_runs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
}

export async function closePool(): Promise<void> {
  await pool.end();
}
