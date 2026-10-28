import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(connectionString: string, max = 10) {
  const pool = new pg.Pool({ connectionString, max });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export async function withDb<T>(
  connectionString: string,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const { db, pool } = createDb(connectionString);
  try {
    return await fn(db);
  } finally {
    await pool.end();
  }
}
