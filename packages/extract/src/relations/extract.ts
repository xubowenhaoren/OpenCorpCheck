import type { RelationType } from "@occ/core";
import { aliases, companies, securities, type Db } from "@occ/db";
import { sha256Text } from "@occ/ingest";
import { eq, inArray } from "drizzle-orm";

import type { ChatClient } from "./llm.js";
import {
  buildRelationPrompt,
  type UniverseCompany,
} from "./prompt.js";
import {
  parseRelationsJson,
  validateRelations,
  type RawRelation,
} from "./validate.js";

export interface RelationDraft {
  dstCompanyId: string;
  dstTicker: string;
  type: RelationType;
  quote: string;
  refs: number[];
  confidence: number;
}

export interface RelationExtractionResult {
  relations: RelationDraft[];
  promptHash: string;
  prompt: string;
  rawCount: number;
  dropped: Array<{ reason: string; raw: RawRelation }>;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

/** Load visible companies + aliases once; reuse across a batch. */
export async function loadRelationUniverse(db: Db): Promise<UniverseCompany[]> {
  const companyRows = await db
    .select({
      id: companies.id,
      displayName: companies.displayName,
      legalName: companies.legalName,
    })
    .from(companies)
    .where(eq(companies.isFixture, false));
  if (companyRows.length === 0) return [];

  const ids = companyRows.map((company) => company.id);
  const [aliasRows, securityRows] = await Promise.all([
    db
      .select({ companyId: aliases.companyId, alias: aliases.alias })
      .from(aliases)
      .where(inArray(aliases.companyId, ids)),
    db
      .select({
        companyId: securities.companyId,
        ticker: securities.ticker,
        exchange: securities.exchange,
      })
      .from(securities)
      .where(inArray(securities.companyId, ids)),
  ]);

  const aliasesByCompany = new Map<string, string[]>();
  for (const alias of aliasRows) {
    const list = aliasesByCompany.get(alias.companyId) ?? [];
    list.push(alias.alias);
    aliasesByCompany.set(alias.companyId, list);
  }
  const tickerByCompany = new Map<string, string>();
  for (const security of securityRows) {
    if (!tickerByCompany.has(security.companyId)) {
      tickerByCompany.set(security.companyId, security.ticker);
    }
  }

  return companyRows.map((company) => {
    const names = new Set<string>([
      company.displayName,
      company.legalName,
      ...(aliasesByCompany.get(company.id) ?? []),
    ]);
    return {
      id: company.id,
      ticker: tickerByCompany.get(company.id) ?? company.displayName,
      displayName: company.displayName,
      names: [...names].filter((name) => isUsableName(name)),
    };
  });
}

const STOP_NAMES = new Set([
  "inc",
  "inc.",
  "corp",
  "corp.",
  "corporation",
  "ltd",
  "ltd.",
  "limited",
  "group",
  "holdings",
  "company",
  "the",
  "and",
]);

function isUsableName(name: string): boolean {
  const value = name.trim();
  if (!value || STOP_NAMES.has(value.toLowerCase())) return false;
  if (/[㐀-鿿]/.test(value)) return value.length >= 2;
  return value.replace(/[^A-Za-z0-9]/g, "").length >= 3;
}

function containsName(text: string, name: string): boolean {
  if (/[㐀-鿿]/.test(name)) return text.includes(name);
  const haystack = text.toLowerCase();
  const needle = name.toLowerCase();
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const before = haystack[index - 1] ?? " ";
    const after = haystack[index + needle.length] ?? " ";
    const boundary = (value: string) => !/[a-z0-9]/.test(value);
    if (boundary(before) && boundary(after)) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

/** Longest whole-name match per company, excluding the profiled company. */
export function findRelationCandidates(
  text: string,
  universe: UniverseCompany[],
  selfCompanyId: string,
  limit = 20,
): UniverseCompany[] {
  const matches: Array<{ company: UniverseCompany; length: number }> = [];
  for (const company of universe) {
    if (company.id === selfCompanyId) continue;
    let best = 0;
    for (const name of company.names) {
      if (containsName(text, name)) best = Math.max(best, name.length);
    }
    if (best > 0) matches.push({ company, length: best });
  }
  return matches
    .sort((a, b) => b.length - a.length)
    .slice(0, limit)
    .map((entry) => entry.company);
}

export interface RelationRequest {
  prompt: string;
  promptHash: string;
  candidates: UniverseCompany[];
  chapterText: string;
  citations: Array<{ ref: number; title?: string; publisher?: string }>;
  companyId: string;
}

export interface RelationRequestInput {
  companyId: string;
  companyName: string;
  companyTicker?: string;
  chapterText: string;
  citations: Array<{ ref: number; title?: string; publisher?: string }>;
  universe: UniverseCompany[];
}

/** Build the prompt before spending any tokens (used for cache checks). */
export function buildRelationRequest(
  input: RelationRequestInput,
): RelationRequest | null {
  const candidates = findRelationCandidates(
    input.chapterText,
    input.universe,
    input.companyId,
  );
  if (candidates.length === 0) return null;
  const prompt = buildRelationPrompt({
    company: { displayName: input.companyName, ticker: input.companyTicker },
    chapterText: input.chapterText,
    citations: input.citations,
    candidates,
  });
  return {
    prompt,
    promptHash: sha256Text(prompt),
    candidates,
    chapterText: input.chapterText,
    citations: input.citations,
    companyId: input.companyId,
  };
}

export async function runRelationRequest(
  request: RelationRequest,
  chat: ChatClient,
): Promise<RelationExtractionResult> {
  try {
    const response = await chat.complete([
      { role: "user", content: request.prompt },
    ]);
    const raw = parseRelationsJson(response.text);
    const validation = validateRelations({
      raw,
      candidates: request.candidates,
      chapterText: request.chapterText,
      citationRefs: request.citations.map((citation) => citation.ref),
      selfCompanyId: request.companyId,
    });
    return {
      relations: validation.accepted.map((relation) => ({
        dstCompanyId: relation.dstCompanyId,
        dstTicker: relation.dstTicker,
        type: relation.type,
        quote: relation.quote,
        refs: relation.refs,
        confidence: relation.confidence,
      })),
      promptHash: request.promptHash,
      prompt: request.prompt,
      rawCount: raw.length,
      dropped: validation.dropped,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    };
  } catch (error) {
    return {
      relations: [],
      promptHash: request.promptHash,
      prompt: request.prompt,
      rawCount: 0,
      dropped: [],
      inputTokens: 0,
      outputTokens: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function extractRelations(
  input: RelationRequestInput & { chat: ChatClient },
): Promise<RelationExtractionResult> {
  const request = buildRelationRequest(input);
  if (!request) {
    return {
      relations: [],
      promptHash: "",
      prompt: "",
      rawCount: 0,
      dropped: [],
      inputTokens: 0,
      outputTokens: 0,
    };
  }
  return runRelationRequest(request, input.chat);
}
