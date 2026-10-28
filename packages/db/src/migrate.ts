import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Minimal, dependency-free migration runner.
 *
 * The SQL files are the source of truth; Drizzle is used for queries. Every
 * migration runs once inside a transaction, under an advisory lock so that
 * several API/worker processes can boot simultaneously.
 */
export async function migrate(connectionString: string): Promise<string[]> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext('opencorpcheck_schema_migrations'))",
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const done = new Set(
      (
        await client.query<{ version: string }>(
          "SELECT version FROM schema_migrations",
        )
      ).rows.map((row) => row.version),
    );
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${String(error)}`);
      }
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext('opencorpcheck_schema_migrations'))")
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
  return applied;
}
