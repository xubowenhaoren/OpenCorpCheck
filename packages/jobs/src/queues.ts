import { PgBoss } from "pg-boss";

export const QUEUES = {
  RESEARCH: "research.company",
  INGEST: "ingest.company",
  REVIEW: "review.company",
  NEWS: "news.company",
  F10: "f10.page",
  RESEARCH_DEAD: "research.company.dead",
  INGEST_DEAD: "ingest.company.dead",
  REVIEW_DEAD: "review.company.dead",
  NEWS_DEAD: "news.company.dead",
  F10_DEAD: "f10.page.dead",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface BossOptions {
  connectionString: string;
  applicationName?: string;
}

export function createBoss(options: BossOptions): PgBoss {
  return new PgBoss({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? "occ-worker",
  });
}

async function ensureQueue(
  boss: PgBoss,
  name: string,
  options: Parameters<PgBoss["createQueue"]>[1],
): Promise<void> {
  const existing = await boss.getQueue(name);
  if (existing) return;
  try {
    await boss.createQueue(name, options);
  } catch (error) {
    // Two workers starting at once can race here; the queue exists now.
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists|duplicate/i.test(message)) throw error;
  }
}

/**
 * Queue policies:
 *  - research: 2 retries with exponential backoff (30s base, 10m cap), 40m expiry.
 *  - ingest: 3 retries (15s base, 5m cap), 10m expiry; fast once embeddings are up.
 *  - news: 2 retries (30s base, 5m cap); one polite RSS fetch per company.
 *  - f10: 3 retries (15s base, 5m cap), 5m expiry.
 *  - dead queues receive exhausted jobs; a worker marks them dead in our tables.
 */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const name of [
    QUEUES.RESEARCH_DEAD,
    QUEUES.INGEST_DEAD,
    QUEUES.REVIEW_DEAD,
    QUEUES.NEWS_DEAD,
    QUEUES.F10_DEAD,
  ]) {
    await ensureQueue(boss, name, {
      retryLimit: 0,
      expireInSeconds: 300,
      deleteAfterSeconds: 604_800,
    });
  }
  await ensureQueue(boss, QUEUES.RESEARCH, {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 600,
    expireInSeconds: 2_400,
    deadLetter: QUEUES.RESEARCH_DEAD,
    deleteAfterSeconds: 604_800,
  });
  await ensureQueue(boss, QUEUES.INGEST, {
    retryLimit: 3,
    retryDelay: 15,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 600,
    deadLetter: QUEUES.INGEST_DEAD,
    deleteAfterSeconds: 604_800,
  });
  await ensureQueue(boss, QUEUES.REVIEW, {
    retryLimit: 1,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 900,
    deadLetter: QUEUES.REVIEW_DEAD,
    deleteAfterSeconds: 604_800,
  });
  await ensureQueue(boss, QUEUES.NEWS, {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 180,
    deadLetter: QUEUES.NEWS_DEAD,
    deleteAfterSeconds: 604_800,
  });
  await ensureQueue(boss, QUEUES.F10, {
    retryLimit: 3,
    retryDelay: 15,
    retryBackoff: true,
    retryDelayMax: 300,
    expireInSeconds: 300,
    deadLetter: QUEUES.F10_DEAD,
    deleteAfterSeconds: 604_800,
  });
}

export async function startBoss(options: BossOptions | string): Promise<PgBoss> {
  const boss = createBoss(
    typeof options === "string" ? { connectionString: options } : options,
  );
  await boss.start();
  await ensureQueues(boss);
  return boss;
}

export async function sendJob(
  boss: PgBoss,
  queue: string,
  data: object,
  options: { key: string; priority: number },
): Promise<string | null> {
  return boss.send(queue, data, {
    singletonKey: options.key,
    priority: options.priority,
  });
}

export interface QueueCounts {
  name: string;
  created: number;
  retry: number;
  active: number;
  failed: number;
  completed: number;
  total: number;
}

/**
 * Live counts straight from pg-boss's job table.
 *
 * `boss.getQueue()` reads a cache refreshed every ~60s, which can make a
 * drain loop exit early or a status report stale. These numbers are exact.
 */
export async function queueCounts(
  boss: PgBoss,
  names: string[] = Object.values(QUEUES),
): Promise<QueueCounts[]> {
  const { rows } = await boss.getDb().executeSql(
    `SELECT name, state, count(*)::int AS count
     FROM pgboss.job
     WHERE name = ANY($1::text[])
     GROUP BY name, state`,
    [names],
  );
  const byName = new Map<string, QueueCounts>(
    names.map((name) => [
      name,
      { name, created: 0, retry: 0, active: 0, failed: 0, completed: 0, total: 0 },
    ]),
  );
  for (const row of rows) {
    const entry = byName.get(String(row.name));
    if (!entry) continue;
    const count = Number(row.count);
    entry.total += count;
    if (row.state === "created") entry.created += count;
    else if (row.state === "retry") entry.retry += count;
    else if (row.state === "active") entry.active += count;
    else if (row.state === "failed") entry.failed += count;
    else if (row.state === "completed") entry.completed += count;
  }
  return [...byName.values()];
}

export function pendingJobs(counts: QueueCounts[]): number {
  return counts.reduce(
    (sum, count) => sum + count.created + count.retry + count.active,
    0,
  );
}
