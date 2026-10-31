import {
  loadRelationUniverse,
  type UniverseCompany,
} from "@occ/extract";
import { createDb, resolveCompanyId } from "@occ/db";

import { config } from "./config.js";
import { extractF10Relations } from "./research/f10-relations.js";
import { resolveTargets } from "./universe.js";

export interface F10RelationsCommandOptions {
  universe?: string;
  tickers?: string;
  limit?: number;
  force?: boolean;
}

export interface F10RelationsCommandResult {
  targets: number;
  resolved: number;
  shareholders: number;
  relations: number;
  unmatched: number;
  errors: Array<{ key: string; error: string }>;
}

/**
 * Re-run structured shareholder extraction against *cached* F10 page JSON.
 *
 * Ingest extracts edges for a company as it lands, but a later company can
 * introduce a shareholder that an earlier page already names (e.g. HSI order:
 * 00006 ingests before 01038 exists). This pass runs after the batch and turns
 * those already-known counterparties into edges without another LLM call.
 */
export async function runF10RelationsCommand(
  options: F10RelationsCommandOptions,
): Promise<F10RelationsCommandResult> {
  const targets = await resolveTargets({
    universe: options.universe,
    tickers: options.tickers,
    limit: options.limit,
  });
  const { db, pool } = createDb(config.databaseUrl, 4);
  try {
    const universe: UniverseCompany[] = await loadRelationUniverse(db);
    const result: F10RelationsCommandResult = {
      targets: targets.length,
      resolved: 0,
      shareholders: 0,
      relations: 0,
      unmatched: 0,
      errors: [],
    };
    for (const target of targets) {
      if (!target.market) continue;
      const companyId = await resolveCompanyId(db, target.ticker);
      if (!companyId) {
        result.errors.push({
          key: target.key,
          error: "company not ingested (no ticker/alias match)",
        });
        continue;
      }
      result.resolved += 1;
      const outcome = await extractF10Relations({
        db,
        companyId,
        ticker: target.ticker,
        code: target.code,
        market: target.market,
        universe,
        ...(options.force ? { force: true } : {}),
      });
      result.shareholders += outcome.shareholders;
      result.relations += outcome.relations;
      result.unmatched += outcome.unmatched;
      if (outcome.error) {
        result.errors.push({ key: target.key, error: outcome.error });
      }
      console.log(
        JSON.stringify({
          event: "f10_relations_company",
          key: target.key,
          page: outcome.page,
          shareholders: outcome.shareholders,
          relations: outcome.relations,
          unmatched: outcome.unmatched,
          ...(outcome.error ? { error: outcome.error } : {}),
        }),
      );
    }
    return result;
  } finally {
    await pool.end();
  }
}
