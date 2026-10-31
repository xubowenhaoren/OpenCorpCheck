import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Market } from "@occ/core";
import {
  buildF10Relations,
  loadRelationUniverse,
  type F10Page,
  type F10RelationDraft,
  type UniverseCompany,
} from "@occ/extract";
import {
  relationId,
  upsertExtractionCache,
  upsertReportedRelations,
  type Db,
} from "@occ/db";
import { FinanceAnalystClient } from "@occ/sources-eastmoney-f10";

import { config, ensureDir } from "../config.js";

const PAGE_BY_MARKET: Record<Market, string> = {
  A: "gdyj",
  HK: "MajorShareholder",
  US: "gbgd",
};

export interface F10RelationOptions {
  db: Db;
  companyId: string;
  ticker: string;
  code?: string;
  market: Market;
  force?: boolean;
  signal?: AbortSignal;
  universe?: UniverseCompany[];
}

export interface F10RelationOutcome {
  page: string;
  fetched: boolean;
  shareholders: number;
  relations: number;
  unmatched: number;
  dropped: number;
  snapshotPath: string;
  error?: string;
}

/**
 * Scrape and persist the ownership page for one company, then turn in-universe
 * shareholders into reported edges. This is additive and never removes LLM or
 * human-reviewed relations.
 */
export async function extractF10Relations(
  options: F10RelationOptions,
): Promise<F10RelationOutcome> {
  if (config.f10Relations === "none") {
    return emptyOutcome(PAGE_BY_MARKET[options.market], false);
  }
  const page = PAGE_BY_MARKET[options.market];
  const code = options.code ?? options.ticker;
  const snapshotPath = path.join(
    config.f10Dir,
    options.market,
    code,
    `${page}.json`,
  );

  try {
    let snapshot = readSnapshot(snapshotPath);
    let fetched = false;
    if (options.force || !snapshot) {
      const client = new FinanceAnalystClient({ baseUrl: config.financeAnalystUrl });
      const response = await client.scrape(
        {
          market: options.market,
          code,
          pages: [page],
          capture_xhr: false,
        },
        {
          timeoutMs: 180_000,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      const pageResult = response.pages[0];
      if (!pageResult || pageResult.error) {
        throw new Error(pageResult?.error ?? "F10 sidecar returned no page");
      }
      snapshot = {
        meta: response.meta,
        page: pageResult,
      };
      saveSnapshot(snapshotPath, snapshot);
      fetched = true;
    }

    const f10Page = toF10Page(snapshot);
    const universe =
      options.universe ?? (await loadRelationUniverse(options.db));
    const result = buildF10Relations({
      page: f10Page,
      market: options.market,
      selfCompanyId: options.companyId,
      universe,
    });
    const rows = result.relations.map((draft) => toReportInput(draft, f10Page));
    const written = await upsertReportedRelations(options.db, rows, {
      dstCompanyId: options.companyId,
    });

    await upsertExtractionCache(options.db, {
      companyId: options.companyId,
      stage: "f10_relations",
      inputSha256: sha256(JSON.stringify(snapshot)),
      status: "ok",
      stats: {
        page,
        shareholders: result.shareholders.length,
        relations: written.relations,
        unmatched: result.unmatched.length,
        dropped: result.dropped,
      },
    });

    return {
      page,
      fetched,
      shareholders: result.shareholders.length,
      relations: written.relations,
      unmatched: result.unmatched.length,
      dropped: result.dropped,
      snapshotPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...emptyOutcome(page, false),
      snapshotPath,
      error: message,
    };
  }
}

function toReportInput(draft: F10RelationDraft, page: F10Page) {
  return {
    id: relationId({
      srcCompanyId: draft.srcCompanyId,
      dstCompanyId: draft.dstCompanyId,
      type: draft.type,
      quote: draft.quote,
    }),
    srcCompanyId: draft.srcCompanyId,
    dstCompanyId: draft.dstCompanyId,
    type: draft.type,
    quote: draft.quote,
    sourceUrl: draft.sourceUrl,
    sourceTitle: `东方财富 F10 ${page.label ?? page.page ?? ""}`.trim(),
    confidence: draft.confidence,
    ...(draft.validFrom ? { validFrom: draft.validFrom } : {}),
  };
}

interface SnapshotFile {
  meta?: { fetched_at?: string };
  page: {
    page?: string;
    label?: string;
    url: string;
    text?: string;
    tables?: Array<{ caption?: string; headers: string[]; rows: string[][] }>;
  };
}

function readSnapshot(file: string): SnapshotFile | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SnapshotFile;
  } catch {
    return null;
  }
}

function saveSnapshot(file: string, snapshot: SnapshotFile): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

function toF10Page(snapshot: SnapshotFile): F10Page {
  return {
    ...(snapshot.page.page ? { page: snapshot.page.page } : {}),
    ...(snapshot.page.label ? { label: snapshot.page.label } : {}),
    url: snapshot.page.url,
    ...(snapshot.page.text ? { text: snapshot.page.text } : {}),
    tables: snapshot.page.tables ?? [],
    ...(snapshot.meta ? { meta: snapshot.meta } : {}),
  };
}

function emptyOutcome(page: string, fetched: boolean): F10RelationOutcome {
  return {
    page,
    fetched,
    shareholders: 0,
    relations: 0,
    unmatched: 0,
    dropped: 0,
    snapshotPath: "",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
