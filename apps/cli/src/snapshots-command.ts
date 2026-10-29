import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { companies, createDb, documents } from "@occ/db";
import {
  createSnapshotStoreFromEnv,
  sectionSnapshotKey,
  type SnapshotStore,
} from "@occ/storage";
import { and, eq, sql } from "drizzle-orm";

import { config } from "./config.js";

const USAGE_OPTIONS = `
Snapshots options:
  --sections <dir>       Section markdown directory (default phase0/out/sections)
  --tickers A,B          Only these tickers
  --limit N              Cap documents
  --force                Re-upload even when the object already exists
  --dry-run              Report what would upload; write nothing
  --json                 Machine-readable summary
`;

export interface SnapshotUploadResult {
  store: { endpoint: string; bucket: string } | null;
  documents: number;
  uploaded: number;
  existing: number;
  updatedKeys: number;
  missingFiles: string[];
  hashMismatches: Array<{ slug: string; documentId: string }>;
  failures: Array<{ slug: string; documentId: string; error: string }>;
  dryRun: boolean;
}

interface DocumentRow {
  documentId: string;
  slug: string;
  storageKey: string | null;
  sha256: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Copy every real `company_profile` section into the S3-compatible snapshot
 * store, content-addressed as `sections/<slug>/<sha256>.md`, and record the
 * object key on the document row.
 *
 * The section file is located through `documents.metadata.sectionPath` (falling
 * back to `<ticker>.md`). A file whose hash no longer matches `documents.sha256`
 * is reported instead of silently uploading different content; re-ingest first.
 */
export async function uploadSnapshots(
  options: {
    sectionsDir?: string;
    tickers?: string;
    limit?: number;
    force?: boolean;
    dryRun?: boolean;
  } = {},
): Promise<SnapshotUploadResult> {
  const sectionsDir = path.resolve(options.sectionsDir ?? config.sectionsDir);
  const store = createSnapshotStoreFromEnv();
  const result: SnapshotUploadResult = {
    store: store ? { endpoint: store.endpoint, bucket: store.bucket } : null,
    documents: 0,
    uploaded: 0,
    existing: 0,
    updatedKeys: 0,
    missingFiles: [],
    hashMismatches: [],
    failures: [],
    dryRun: Boolean(options.dryRun),
  };
  if (!store) {
    throw new Error(
      "snapshot store is not configured; set OCC_S3_ENDPOINT, OCC_S3_BUCKET, OCC_S3_ACCESS_KEY and OCC_S3_SECRET_KEY",
    );
  }

  const { db, pool } = createDb(config.databaseUrl);
  try {
    const wanted = options.tickers
      ?.split(",")
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean);
    const rows = (await db
      .select({
        documentId: documents.id,
        slug: companies.slug,
        storageKey: documents.storageKey,
        sha256: documents.sha256,
        metadata: documents.metadata,
      })
      .from(documents)
      .innerJoin(companies, eq(documents.companyId, companies.id))
      .where(
        and(
          eq(documents.docType, "company_profile"),
          eq(documents.isFixture, false),
        ),
      )) as DocumentRow[];

    const selected = rows
      .filter((row) => {
        if (!wanted?.length) return true;
        const ticker = stringField(row.metadata, "ticker");
        return Boolean(ticker && wanted.includes(ticker.toUpperCase()));
      })
      .slice(0, options.limit ?? rows.length);

    for (const row of selected) {
      result.documents += 1;
      const file = sectionFile(sectionsDir, row);
      if (!file) {
        result.missingFiles.push(row.slug);
        continue;
      }
      const markdown = fs.readFileSync(file, "utf8");
      const sha256 = sha256Text(markdown);
      if (row.sha256 && row.sha256 !== sha256) {
        result.hashMismatches.push({ slug: row.slug, documentId: row.documentId });
        continue;
      }
      const key = sectionSnapshotKey(row.slug, sha256);

      try {
        if (!options.dryRun) {
          const head = options.force ? null : await store.head(key);
          if (head) {
            result.existing += 1;
          } else {
            await store.put(key, markdown, "text/markdown; charset=utf-8");
            result.uploaded += 1;
          }
          if (row.storageKey !== store.uri(key)) {
            await db
              .update(documents)
              .set({
                storageKey: store.uri(key),
                metadata: sqlMergeSnapshot(store, key, sha256, markdown),
              })
              .where(eq(documents.id, row.documentId));
            result.updatedKeys += 1;
          }
        } else if (options.force || !(await store.head(key))) {
          result.uploaded += 1;
        } else {
          result.existing += 1;
        }
      } catch (error) {
        result.failures.push({
          slug: row.slug,
          documentId: row.documentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  } finally {
    await pool.end();
  }
}

export async function snapshotsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") {
    const { values } = parseArgs({
      args: rest,
      options: {
        prefix: { type: "string", default: "sections/" },
        limit: { type: "string", default: "100" },
        json: { type: "boolean" },
      },
    });
    const store = requireStore();
    const keys = await store.list(values.prefix!, Number(values.limit) || 100);
    if (values.json) {
      console.log(JSON.stringify({ bucket: store.bucket, prefix: values.prefix, keys }, null, 2));
      return;
    }
    console.log(`${keys.length} object(s) in ${store.bucket}`);
    for (const key of keys) console.log(`  ${key}`);
    return;
  }

  if (subcommand !== "upload" && subcommand !== "check") {
    throw new Error("usage: occ snapshots upload|check|list [options]");
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      sections: { type: "string" },
      tickers: { type: "string" },
      limit: { type: "string" },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const result = await uploadSnapshots({
    sectionsDir: values.sections,
    tickers: values.tickers,
    limit: values.limit ? Number(values.limit) : undefined,
    force: Boolean(values.force),
    dryRun: subcommand === "check" || Boolean(values["dry-run"]),
  });
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `snapshots ${result.dryRun ? "check" : "upload"} · ${result.documents} document(s) · ` +
      `uploaded=${result.uploaded} existing=${result.existing} updatedKeys=${result.updatedKeys}` +
      (result.missingFiles.length ? ` · missingFiles=${result.missingFiles.length}` : "") +
      (result.hashMismatches.length ? ` · hashMismatches=${result.hashMismatches.length}` : "") +
      (result.failures.length ? ` · failures=${result.failures.length}` : ""),
  );
  for (const slug of result.missingFiles) console.error(`  MISSING FILE ${slug}`);
  for (const item of result.hashMismatches) {
    console.error(`  HASH MISMATCH ${item.slug} (re-ingest before uploading)`);
  }
  for (const failure of result.failures) {
    console.error(`  FAIL ${failure.slug}: ${failure.error}`);
  }
  if (result.failures.length > 0) process.exitCode = 1;
}

export { USAGE_OPTIONS };

function requireStore(): SnapshotStore {
  const store = createSnapshotStoreFromEnv();
  if (!store) {
    throw new Error(
      "snapshot store is not configured; set OCC_S3_ENDPOINT, OCC_S3_BUCKET, OCC_S3_ACCESS_KEY and OCC_S3_SECRET_KEY",
    );
  }
  return store;
}

function sectionFile(sectionsDir: string, row: DocumentRow): string | null {
  const sectionPath = stringField(row.metadata, "sectionPath");
  const candidates = [
    sectionPath ? path.join(sectionsDir, path.basename(sectionPath)) : null,
    stringField(row.metadata, "ticker")
      ? path.join(sectionsDir, `${stringField(row.metadata, "ticker")}.md`)
      : null,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function stringField(
  metadata: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sqlMergeSnapshot(
  store: SnapshotStore,
  key: string,
  sha256: string,
  markdown: string,
) {
  const snapshot = {
    store: "s3",
    bucket: store.bucket,
    key,
    uri: store.uri(key),
    sha256,
    bytes: Buffer.byteLength(markdown, "utf8"),
    uploadedAt: new Date().toISOString(),
  };
  return sql`${documents.metadata} || ${JSON.stringify({ snapshot })}::jsonb`;
}
