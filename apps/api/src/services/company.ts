import {
  AppError,
  type CompanyCard,
  type CompanyCardQuery,
  type CompanyGraphQuery,
  type CompanyGraphView,
  type CompanyProfileView,
  type CompanySummary,
  type IndexMemberView,
  type IndexView,
  type RelationView,
} from "@occ/core";
import {
  getCompanyBundle,
  getCompanyBundles,
  getCompanyCounts,
  listEvents,
  listFacts,
  listFinancialFacts,
  listIndexCompanyIds,
  listRelations,
  listSectors,
  resolveCompanyId,
  type CompanyBundle,
  type Db,
} from "@occ/db";

const ALL_SECTIONS = ["financials", "facts", "relations", "events"] as const;

const EXCHANGE_MARKET: Record<string, string> = {
  SSE: "A",
  SZSE: "A",
  BSE: "A",
  HKEX: "HK",
  NASDAQ: "US",
  NYSE: "US",
  AMEX: "US",
  CBOE: "US",
};

function summaryOf(bundle: CompanyBundle): CompanySummary {
  return {
    id: bundle.company.id,
    slug: bundle.company.slug,
    displayName: bundle.company.displayName,
    legalName: bundle.company.legalName ?? undefined,
    tickers: bundle.securities.map((security) => ({
      ticker: security.ticker,
      exchange: security.exchange,
      currency: security.currency ?? undefined,
    })),
  };
}

function marketsOf(bundle: CompanyBundle): string[] {
  return [
    ...new Set(
      bundle.securities
        .map((security) => EXCHANGE_MARKET[security.exchange.toUpperCase()])
        .filter((market): market is string => Boolean(market)),
    ),
  ];
}

export class CompanyService {
  constructor(private readonly db: Db) {}

  async getCard(ref: string, query: CompanyCardQuery): Promise<CompanyCard> {
    const companyId = await resolveCompanyId(this.db, ref);
    if (!companyId) {
      throw new AppError("not_found", `company not found: ${ref}`);
    }
    const bundle = await getCompanyBundle(this.db, companyId);
    if (!bundle) {
      throw new AppError("not_found", `company not found: ${ref}`);
    }

    const include = new Set(query.include ?? ALL_SECTIONS);
    const counts = await getCompanyCounts(this.db, companyId);
    const [financials, facts, relations, events] = await Promise.all([
      include.has("financials")
        ? listFinancialFacts(this.db, companyId, {
            limit: query.financial_limit,
            ...(query.financial_period_kind
              ? { periodKind: query.financial_period_kind }
              : {}),
          })
        : Promise.resolve(undefined),
      include.has("facts")
        ? listFacts(this.db, companyId, { limit: query.fact_limit })
        : Promise.resolve(undefined),
      include.has("relations")
        ? listRelations(this.db, companyId, {
            direction: "both",
            limit: query.relation_limit,
            status: query.relation_status,
          })
        : Promise.resolve(undefined),
      include.has("events")
        ? listEvents(this.db, companyId, query.event_limit)
        : Promise.resolve(undefined),
    ]);

    const latestIndexMemberships = new Map<
      string,
      { code: string; weight?: number; asOf?: string }
    >();
    for (const entry of bundle.indices) {
      const asOf = String(entry.asOf).slice(0, 10);
      const previous = latestIndexMemberships.get(entry.indexCode);
      if (!previous || asOf > (previous.asOf ?? "")) {
        latestIndexMemberships.set(entry.indexCode, {
          code: entry.indexCode,
          ...(entry.weight !== null ? { weight: entry.weight } : {}),
          asOf,
        });
      }
    }

    const company: CompanyProfileView = {
      id: bundle.company.id,
      slug: bundle.company.slug,
      legalName: bundle.company.legalName,
      displayName: bundle.company.displayName,
      country: bundle.company.country ?? undefined,
      website: bundle.company.website ?? undefined,
      coverageTier: bundle.company.coverageTier,
      description: bundle.company.description ?? undefined,
      sector: bundle.company.sector ?? undefined,
      aliases: bundle.aliases.map((alias) => alias.alias),
      tickers: bundle.securities.map((security) => ({
        ticker: security.ticker,
        exchange: security.exchange,
        currency: security.currency ?? undefined,
      })),
      indices: [...new Set(bundle.indices.map((entry) => entry.indexCode))],
      indexMemberships: [...latestIndexMemberships.values()].sort((left, right) =>
        left.code.localeCompare(right.code),
      ),
    };

    return {
      company,
      counts,
      ...(financials ? { financials } : {}),
      ...(facts ? { facts } : {}),
      ...(relations
        ? {
            relations: {
              outgoing: relations.filter(
                (relation) => relation.direction === "outgoing",
              ),
              incoming: relations.filter(
                (relation) => relation.direction === "incoming",
              ),
            },
          }
        : {}),
      ...(events ? { events } : {}),
    };
  }

  /**
   * Ego-network graph. Depth 1 reads only the center's edges; depth 2 also
   * reads each neighbor's edges (capped) so the UI can show a second ring.
   * Nothing here is cached: relations are sparse and the query is cheap.
   */
  async getGraph(query: CompanyGraphQuery): Promise<CompanyGraphView> {
    const centerId = await resolveCompanyId(this.db, query.company);
    if (!centerId) {
      throw new AppError("not_found", `company not found: ${query.company}`);
    }
    const centerBundle = await getCompanyBundle(this.db, centerId);
    if (!centerBundle) {
      throw new AppError("not_found", `company not found: ${query.company}`);
    }
    const center = summaryOf(centerBundle);
    const edges = new Map<string, RelationView>();
    const firstRing = await listRelations(this.db, centerId, {
      direction: "both",
      limit: query.limit,
      status: query.status,
    });
    for (const edge of firstRing) edges.set(edge.id, edge);

    let truncated = false;
    if (query.depth >= 2) {
      const neighborIds = new Set<string>();
      for (const edge of firstRing) {
        const other = edge.src.id === centerId ? edge.dst.id : edge.src.id;
        if (other) neighborIds.add(other);
      }
      const visibleNeighbors = [...neighborIds].slice(0, 40);
      truncated = neighborIds.size > visibleNeighbors.length;
      const rings = await Promise.all(
        visibleNeighbors.map((id) =>
          listRelations(this.db, id, {
            direction: "both",
            limit: 50,
            status: query.status,
          }),
        ),
      );
      for (const ring of rings) {
        for (const edge of ring) {
          if (!edges.has(edge.id)) edges.set(edge.id, edge);
        }
      }
    }

    const allowed = query.types?.length
      ? new Set<string>(query.types)
      : null;
    const statusRank: Record<string, number> = {
      verified: 0,
      reported: 1,
      inferred: 2,
      rejected: 3,
    };
    let all = [...edges.values()].filter(
      (edge) => !allowed || allowed.has(edge.type),
    );
    all.sort(
      (a, b) =>
        (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) ||
        (b.confidence ?? 0) - (a.confidence ?? 0) ||
        (b.amount ?? 0) - (a.amount ?? 0),
    );
    if (all.length > query.limit) {
      all = all.slice(0, query.limit);
      truncated = true;
    }

    const nodes = new Map<string, CompanySummary>();
    nodes.set(center.id, center);
    for (const edge of all) {
      if (edge.src.id) nodes.set(edge.src.id, edge.src);
      if (edge.dst.id) nodes.set(edge.dst.id, edge.dst);
    }

    return {
      center,
      nodes: [...nodes.values()],
      edges: all,
      depth: query.depth,
      truncated,
    };
  }

  /** Index constituents with enough company metadata for the browse page. */
  async getIndex(code: string): Promise<IndexView> {
    const normalized = code.trim().toUpperCase();
    const rows = await listIndexCompanyIds(this.db, normalized);
    if (rows.length === 0) {
      throw new AppError("not_found", `index not found: ${code}`);
    }
    const bundles = await getCompanyBundles(
      this.db,
      rows.map((row) => row.companyId),
    );
    const members: IndexMemberView[] = [];
    for (const row of rows) {
      const bundle = bundles.get(row.companyId);
      if (!bundle) continue;
      members.push({
        id: bundle.company.id,
        slug: bundle.company.slug,
        displayName: bundle.company.displayName,
        legalName: bundle.company.legalName ?? undefined,
        country: bundle.company.country ?? undefined,
        sector: bundle.company.sector ?? undefined,
        coverageTier: bundle.company.coverageTier,
        tickers: bundle.securities.map((security) => ({
          ticker: security.ticker,
          exchange: security.exchange,
          currency: security.currency ?? undefined,
        })),
        indices: [...new Set(bundle.indices.map((entry) => entry.indexCode))],
        markets: marketsOf(bundle),
        asOf: row.asOf,
      });
    }
    members.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return {
      code: normalized,
      asOf: rows.map((row) => row.asOf).sort().at(-1),
      members,
    };
  }

  async getSectors(): Promise<string[]> {
    return listSectors(this.db);
  }
}
