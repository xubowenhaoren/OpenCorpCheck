import {
  AppError,
  type CompanyCard,
  type CompanyCardQuery,
  type CompanyProfileView,
} from "@occ/core";
import {
  getCompanyBundle,
  getCompanyCounts,
  listEvents,
  listFacts,
  listFinancialFacts,
  listRelations,
  resolveCompanyId,
  type Db,
} from "@occ/db";

const ALL_SECTIONS = ["financials", "facts", "relations", "events"] as const;

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
        ? listFinancialFacts(this.db, companyId, { limit: query.financial_limit })
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
}
