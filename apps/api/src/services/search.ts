import type {
  BranchExplain,
  Citation,
  CompanyHit,
  DocumentHit,
  Market,
  MatchType,
  SearchCompaniesQuery,
  SearchDocumentsQuery,
  SearchExplain,
} from "@occ/core";
import {
  findExactCompanyMatches,
  getChunksWithSources,
  getCompanyBundle,
  getCompanyBundles,
  getFinancialFacts,
  type ChunkWithSource,
  type CompanyBundle,
  type Db,
} from "@occ/db";
import {
  SearchEngine,
  normalizeText,
  type EngineExplain,
  type QdrantCondition,
  type QdrantHit,
  type RerankClient,
} from "@occ/retrieval";

const EXCHANGE_MARKET: Record<string, Market> = {
  SSE: "A",
  SZSE: "A",
  BSE: "A",
  HKEX: "HK",
  NASDAQ: "US",
  NYSE: "US",
  AMEX: "US",
};

interface NeutralHit {
  id: string;
  matchType: MatchType;
  score: number;
  explain?: BranchExplain;
}

export interface ServiceResult<T> {
  hits: T[];
  explain?: SearchExplain;
  citations: Citation[];
  normalizedQuery: string;
  rerank: boolean;
}

export interface SearchServiceDeps {
  db: Db;
  engine: SearchEngine;
  reranker?: RerankClient;
}

export class SearchService {
  constructor(private readonly deps: SearchServiceDeps) {}

  async searchCompanies(
    query: SearchCompaniesQuery,
  ): Promise<ServiceResult<CompanyHit>> {
    const started = performance.now();
    const markets = parseList(query.market).map((market) =>
      market.toUpperCase(),
    ) as Market[];
    const indices = parseList(query.index).map((index) => index.toUpperCase());

    const [exact, retrieval] = await Promise.all([
      findExactCompanyMatches(this.deps.db, query.q),
      this.deps.engine.searchCompanies({
        q: query.q,
        mode: query.mode,
        limit: Math.max(query.limit * 3, 20),
        filter: buildCompanyFilter(query, markets, indices),
        explain: query.explain,
      }),
    ]);

    const candidates = new Map<string, NeutralHit>();
    for (const match of exact) {
      candidates.set(match.companyId, {
        id: match.companyId,
        matchType: match.matchType,
        score: match.score,
      });
    }
    for (const hit of retrieval.hits) {
      const companyId = String(hit.payload.company_id ?? "");
      if (!companyId) continue;
      const existing = candidates.get(companyId);
      if (existing && existing.matchType !== "hybrid") continue;
      candidates.set(companyId, {
        id: companyId,
        matchType: query.mode,
        score: hit.score,
      });
    }

    const ids = [...candidates.keys()];
    const bundles = await getCompanyBundles(this.deps.db, ids);
    const explainContext = buildExplainContext(retrieval.explain, "company_id");

    /**
     * Planner intent: an exact identifier or alias match is a user telling us
     * which company they mean. Raw BM25 scores are unbounded (a keyword hit can
     * score 9.8 while an exact alias scores 1), so exact matches must sort
     * ahead of retrieval hits in every mode, including keyword-only.
     */
    const exactWeight = (matchType: MatchType): number =>
      matchType === "identifier"
        ? 3
        : matchType === "alias"
          ? 2
          : matchType === "fuzzy"
            ? 1
            : 0;

    type OrderedCompany = {
      bundle: CompanyBundle;
      candidate: NeutralHit;
      rankScore: number;
      rerankScore?: number;
    };
    let ordered: OrderedCompany[] = ids
      .map((id) => ({ bundle: bundles.get(id), candidate: candidates.get(id)! }))
      .filter(
        (entry): entry is { bundle: CompanyBundle; candidate: NeutralHit } =>
          Boolean(entry.bundle) &&
          matchesCompanyFilters(entry.bundle!, markets, indices, query.coverage),
      )
      .map(({ bundle, candidate }) => ({
        bundle,
        candidate,
        rankScore:
          candidate.score +
          (bundle.company.coverageTier === "index_member" ? 0.003 : 0) +
          (bundle.company.coverageTier === "ai_watchlist" ? 0.001 : 0),
      }))
      .sort(
        (a, b) =>
          exactWeight(b.candidate.matchType) - exactWeight(a.candidate.matchType) ||
          b.rankScore - a.rankScore,
      );

    let rerankUsed = false;
    let rerankMs = 0;
    if (
      shouldRerank(query.rerank, this.deps.reranker) &&
      ordered.length > 1
    ) {
      const rerankStarted = performance.now();
      const docTexts = ordered.map(
        ({ bundle }) =>
          `${bundle.company.displayName}\n${bundle.company.description ?? ""}`,
      );
      const results = await this.deps.reranker!.rerank(
        query.q,
        docTexts,
        Math.min(query.limit, docTexts.length),
      );
      if (results.length > 0) {
        const byIndex = new Map(results.map((result) => [result.index, result.score]));
        ordered = ordered
          .map((entry, index) => ({
            ...entry,
            rankScore: byIndex.get(index) ?? -1,
            rerankScore: byIndex.get(index),
          }))
          .sort(
            (a, b) =>
              exactWeight(b.candidate.matchType) -
                exactWeight(a.candidate.matchType) ||
              b.rankScore - a.rankScore,
          );
        rerankUsed = true;
      }
      rerankMs = Math.round(performance.now() - rerankStarted);
    }

    ordered = ordered.slice(0, query.limit);

    const hits: CompanyHit[] = ordered.map(({ bundle, candidate, rerankScore }) => {
      const pointIds = explainContext.pointIdsByEntity.get(candidate.id) ?? [];
      const branch =
        candidate.explain ??
        branchExplain(explainContext, pointIds[0], candidate.score);
      return toCompanyHit(
        bundle,
        candidate.matchType,
        candidate.score,
        query.explain
          ? {
              ...branch,
              fusedScore: candidate.score,
              ...(rerankScore !== undefined ? { rerankScore } : {}),
            }
          : undefined,
      );
    });

    const citations: Citation[] = [];
    const explain = query.explain
      ? toSearchExplain(
          retrieval.explain,
          explainContext,
          Math.round(performance.now() - started),
          rerankMs,
        )
      : undefined;

    return {
      hits,
      explain,
      citations,
      normalizedQuery: normalizeText(query.q),
      rerank: rerankUsed,
    };
  }

  async searchDocuments(
    query: SearchDocumentsQuery,
  ): Promise<ServiceResult<DocumentHit>> {
    const started = performance.now();
    const retrieval = await this.deps.engine.searchDocuments({
      q: query.q,
      mode: query.mode,
      limit: Math.max(query.limit * 3, 20),
      filter: buildDocumentFilter(query),
      explain: query.explain,
    });

    const chunkIds = retrieval.hits
      .map((hit) => String(hit.payload.chunk_id ?? ""))
      .filter(Boolean);
    const hydrated = await getChunksWithSources(this.deps.db, chunkIds);
    const explainContext = buildExplainContext(retrieval.explain, "chunk_id");

    type HydratedHit = {
      hit: QdrantHit;
      chunkId: string;
      row: ChunkWithSource;
      score: number;
      rerankScore?: number;
    };
    let ordered: HydratedHit[] = retrieval.hits
      .map((hit) => {
        const chunkId = String(hit.payload.chunk_id ?? hit.id);
        return {
          hit,
          chunkId,
          row: hydrated.get(chunkId),
          score: hit.score,
        };
      })
      .filter((entry): entry is HydratedHit => Boolean(entry.row));

    let rerankUsed = false;
    let rerankMs = 0;
    if (shouldRerank(query.rerank, this.deps.reranker) && ordered.length > 1) {
      const rerankStarted = performance.now();
      const results = await this.deps.reranker!.rerank(
        query.q,
        ordered.map((entry) => String(entry.hit.payload.text ?? entry.row.text)),
        Math.min(query.limit, ordered.length),
      );
      if (results.length > 0) {
        const byIndex = new Map(results.map((result) => [result.index, result.score]));
        ordered = ordered
          .map((entry, index) => ({
            ...entry,
            score: byIndex.get(index) ?? -1,
            rerankScore: byIndex.get(index),
          }))
          .sort((a, b) => b.score - a.score);
        rerankUsed = true;
      }
      rerankMs = Math.round(performance.now() - rerankStarted);
    }

    ordered = ordered.slice(0, query.limit);

    const hits: DocumentHit[] = ordered.map((entry) => {
      const pointIds = explainContext.pointIdsByEntity.get(entry.chunkId) ?? [];
      const branch =
        branchExplain(explainContext, pointIds[0], entry.hit.score) ?? {
          fusedScore: entry.hit.score,
        };
      const source: Citation | undefined = entry.row.sourceUrl
        ? {
            url: entry.row.sourceUrl,
            title: entry.row.sourceTitle ?? undefined,
            retrievedAt: entry.row.fetchedAt?.toISOString(),
            source: entry.row.sourceTitle ?? undefined,
          }
        : undefined;
      return {
        chunkId: entry.chunkId,
        documentId: entry.row.documentId,
        companyId: entry.row.companyId ?? "",
        companyDisplayName: entry.row.companyDisplayName ?? undefined,
        text: entry.row.text,
        title: entry.row.title ?? undefined,
        docType: entry.row.docType ?? undefined,
        lang: entry.row.lang ?? undefined,
        page: entry.row.page ?? undefined,
        section: entry.row.section ?? undefined,
        source,
        matchType: query.mode,
        score: entry.score,
        ...(query.explain
          ? {
              explain: {
                ...branch,
                fusedScore: entry.score,
                ...(entry.rerankScore !== undefined
                  ? { rerankScore: entry.rerankScore }
                  : {}),
              },
            }
          : {}),
      };
    });

    const citations = uniqueCitations(
      hits.map((hit) => hit.source).filter((value): value is Citation => Boolean(value)),
    );
    const explain = query.explain
      ? toSearchExplain(
          retrieval.explain,
          explainContext,
          Math.round(performance.now() - started),
          rerankMs,
        )
      : undefined;

    return {
      hits,
      explain,
      citations,
      normalizedQuery: normalizeText(query.q),
      rerank: rerankUsed,
    };
  }

  async getCompany(idOrSlug: string) {
    const bundle = await getCompanyBundle(this.deps.db, idOrSlug);
    if (!bundle) return null;
    const financials = await getFinancialFacts(this.deps.db, bundle.company.id);
    return { ...bundle, financials };
  }
}

function parseList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildCompanyFilter(
  query: SearchCompaniesQuery,
  markets: Market[],
  indices: string[],
) {
  const must: QdrantCondition[] = [];
  if (markets.length > 0) {
    must.push({ key: "markets", match: { any: markets } });
  }
  if (indices.length > 0) {
    must.push({ key: "indices", match: { any: indices } });
  }
  if (query.coverage) {
    must.push({ key: "coverage_tier", match: { value: query.coverage } });
  }
  return must.length > 0 ? { must } : undefined;
}

function buildDocumentFilter(query: SearchDocumentsQuery) {
  const must: QdrantCondition[] = [];
  if (query.company_id) {
    must.push({ key: "company_id", match: { value: query.company_id } });
  }
  if (query.doc_type) {
    must.push({ key: "doc_type", match: { value: query.doc_type } });
  }
  if (query.lang) {
    must.push({ key: "lang", match: { value: query.lang } });
  }
  return must.length > 0 ? { must } : undefined;
}

function matchesCompanyFilters(
  bundle: CompanyBundle,
  markets: Market[],
  indices: string[],
  coverage?: string,
): boolean {
  if (coverage && bundle.company.coverageTier !== coverage) return false;
  if (indices.length > 0) {
    const own = bundle.indices.map((entry) => entry.indexCode);
    if (!indices.some((index) => own.includes(index))) return false;
  }
  if (markets.length > 0) {
    const own = bundle.securities
      .map((security) => EXCHANGE_MARKET[security.exchange.toUpperCase()])
      .filter((market): market is Market => Boolean(market));
    if (!markets.some((market) => own.includes(market))) return false;
  }
  return true;
}

function toCompanyHit(
  bundle: CompanyBundle,
  matchType: MatchType,
  score: number,
  explain?: BranchExplain,
): CompanyHit {
  const { company } = bundle;
  const markets = [
    ...new Set(
      bundle.securities
        .map((security) => EXCHANGE_MARKET[security.exchange.toUpperCase()])
        .filter((market): market is Market => Boolean(market)),
    ),
  ];
  return {
    id: company.id,
    slug: company.slug,
    legalName: company.legalName,
    displayName: company.displayName,
    country: company.country ?? undefined,
    website: company.website ?? undefined,
    coverageTier: company.coverageTier as CompanyHit["coverageTier"],
    description: company.description ?? undefined,
    sector: company.sector ?? undefined,
    marketCapBucket: company.marketCapBucket ?? undefined,
    aliases: bundle.aliases.map((alias) => alias.alias),
    tickers: bundle.securities.map((security) => ({
      ticker: security.ticker,
      exchange: security.exchange,
      currency: security.currency ?? undefined,
    })),
    indices: bundle.indices.map((entry) => entry.indexCode),
    markets,
    matchType,
    score: Number(score.toFixed(6)),
    ...(explain ? { explain } : {}),
  };
}

interface ExplainContext {
  pointIdsByEntity: Map<string, string[]>;
  entityByPointId: Map<string, string>;
  bm25Ranks: Map<string, { rank: number; score: number }>;
  denseRanks: Map<string, { rank: number; score: number }>;
  fused: Array<{ id: string; score: number; method: "rrf" | "dbsf" }>;
  normalizedQuery?: string;
  tokens: string[];
  qdrantMs: number;
}

function buildExplainContext(
  explain: EngineExplain | undefined,
  idField: string,
): ExplainContext {
  const context: ExplainContext = {
    pointIdsByEntity: new Map(),
    entityByPointId: new Map(),
    bm25Ranks: new Map(),
    denseRanks: new Map(),
    fused: [],
    tokens: explain?.tokens ?? [],
    qdrantMs: explain?.timings.qdrantMs ?? 0,
  };
  if (!explain) return context;

  const register = (hit: QdrantHit) => {
    const entityId = String(hit.payload[idField] ?? "");
    if (!entityId) return;
    const pointIds = context.pointIdsByEntity.get(entityId) ?? [];
    pointIds.push(hit.id);
    context.pointIdsByEntity.set(entityId, pointIds);
    context.entityByPointId.set(hit.id, entityId);
  };
  explain.bm25.forEach((hit, index) => {
    register(hit);
    const entityId = String(hit.payload[idField] ?? "");
    if (entityId) context.bm25Ranks.set(entityId, { rank: index + 1, score: hit.score });
  });
  explain.dense.forEach((hit, index) => {
    register(hit);
    const entityId = String(hit.payload[idField] ?? "");
    if (entityId) context.denseRanks.set(entityId, { rank: index + 1, score: hit.score });
  });
  context.fused = explain.fused.map((item) => ({
    id: context.entityByPointId.get(item.id) ?? item.id,
    score: item.score,
    method: explain.fusionMethod,
  }));
  return context;
}

function branchExplain(
  context: ExplainContext,
  pointId: string | undefined,
  fusedScore: number,
): BranchExplain {
  const entityId = pointId
    ? (context.entityByPointId.get(pointId) ?? pointId)
    : undefined;
  const sparse = entityId ? context.bm25Ranks.get(entityId) : undefined;
  const dense = entityId ? context.denseRanks.get(entityId) : undefined;
  return {
    ...(sparse ? { sparseRank: sparse.rank, sparseScore: sparse.score } : {}),
    ...(dense ? { denseRank: dense.rank, denseScore: dense.score } : {}),
    fusedScore,
    ...(context.tokens.length > 0 ? { matchedTerms: context.tokens } : {}),
  };
}

function toSearchExplain(
  explain: EngineExplain | undefined,
  context: ExplainContext,
  plannerMs: number,
  rerankMs: number,
): SearchExplain | undefined {
  if (!explain) return undefined;
  return {
    normalizedQuery: explain.normalizedQuery,
    tokens: explain.tokens,
    branches: {
      bm25: explain.bm25.map((hit, index) => ({
        id: String(hit.payload.company_id ?? hit.payload.chunk_id ?? hit.id),
        rank: index + 1,
        score: hit.score,
      })),
      dense: explain.dense.map((hit, index) => ({
        id: String(hit.payload.company_id ?? hit.payload.chunk_id ?? hit.id),
        rank: index + 1,
        score: hit.score,
      })),
    },
    fusion: context.fused.map((item) => ({
      id: item.id,
      score: item.score,
      method: item.method,
    })),
    timings: {
      plannerMs,
      qdrantMs: explain.timings.qdrantMs,
      rerankMs,
    },
  };
}

function shouldRerank(
  requested: boolean | undefined,
  reranker: RerankClient | undefined,
): boolean {
  if (!reranker?.enabled) return false;
  return requested !== false;
}

function uniqueCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    if (seen.has(citation.url)) return false;
    seen.add(citation.url);
    return true;
  });
}
