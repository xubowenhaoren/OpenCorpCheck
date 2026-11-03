import { matchName } from "./matching.js";
import type { OwnershipEdgeDraft } from "./types.js";

/**
 * SEC Form 13F-HR ownership planner.
 *
 * A 13F is an institutional position, not control, so every edge is
 * `invests_in`. The planner only accepts counterparties already present in
 * `companies` (exact CIK for the filer, exact CUSIP for the issuer, with an
 * exact normalized-name fallback). It never creates a company.
 *
 * Dedupe is `(holder, issuer, type)`: a later quarter refreshes the edge's
 * value and evidence instead of adding another edge.
 */

export const THIRTEEN_F_VERSION = "sec-13f-v1";

export interface ThirteenFSubmissionRow {
  accession: string;
  filingDate: string;
  submissionType: string;
  cik: string;
  period: string;
}

export interface ThirteenFCoverPageRow {
  accession: string;
  managerName: string;
}

export interface ThirteenFHoldingRow {
  accession: string;
  issuerName: string;
  cusip: string;
  value: number;
  shares: number;
  shareType: string;
  putCall: string;
}

export interface ThirteenFFiling {
  accession: string;
  cik: string;
  period: string;
  filingDate: string;
  managerName: string;
}

export interface ThirteenFPlannerOptions {
  filerByCik: Map<string, string>;
  /** Normalized-name index built with `buildNameIndex`. */
  filerByName: Map<string, string | null>;
  issuerByCusip: Map<string, string>;
  /** Normalized-name index built with `buildNameIndex`. */
  issuerByName: Map<string, string | null>;
}

export interface ThirteenFStats {
  filings: number;
  filingsMatched: number;
  filingsUnmatched: number;
  holders: number;
  holdersMatchedByCik: number;
  holdersMatchedByName: number;
  filersUnmatched: number;
  ambiguousFilers: number;
  holdingsRows: number;
  matchedHoldingsRows: number;
  optionRows: number;
  nonShareRows: number;
  selfRows: number;
  issuers: number;
  issuerNameMatchedCompanies: number;
  unmatchedIssuerCusips: number;
  unmatchedIssuerNames: number;
  issuerNameMatches: number;
  ambiguousIssuerNames: number;
  latestPeriod: string | null;
  dollarFilings: number;
  thousandFilings: number;
}

export interface ThirteenFPlan {
  edges: OwnershipEdgeDraft[];
  stats: ThirteenFStats;
}

interface SelectedFiling {
  accession: string;
  cik: string;
  period: string;
  filingDate: string;
  managerName: string;
  holderCompanyId: string;
  holderMatchedBy: "cik" | "name";
}

interface AggregatedEdge {
  holderCompanyId: string;
  issuerCompanyId: string;
  period: string;
  filingDate: string;
  accession: string;
  cusip: string;
  issuerName: string;
  managerName: string;
  holderCik: string;
  holderMatchedBy: "cik" | "name";
  issuerMatchedBy: "cusip" | "name";
  valueUsd: number;
  shares: number;
  dollarUnits: boolean;
}

export class ThirteenFPlanner {
  private readonly filings = new Map<string, SelectedFiling>();
  private readonly edges = new Map<string, AggregatedEdge>();
  private readonly holderIdsByCik = new Set<string>();
  private readonly holderIdsByName = new Set<string>();
  private readonly issuerIds = new Set<string>();
  private readonly unmatchedIssuerCusips = new Set<string>();
  private readonly unmatchedIssuerNames = new Set<string>();
  private readonly ambiguousIssuerNames = new Set<string>();
  private readonly nameMatchedIssuerIds = new Set<string>();
  private readonly unmatchedFilerKeys = new Set<string>();
  private readonly ambiguousFilerKeys = new Set<string>();
  private filingsSeen = 0;
  private filingsMatched = 0;
  private filingsUnmatched = 0;
  private holdingsRows = 0;
  private matchedHoldingsRows = 0;
  private optionRows = 0;
  private nonShareRows = 0;
  private selfRows = 0;
  private issuerNameMatches = 0;
  private latestPeriod: string | null = null;
  private dollarFilings = 0;
  private thousandFilings = 0;

  constructor(private readonly options: ThirteenFPlannerOptions) {}

  /** Register one 13F-HR filing; amendments/notices must be filtered out. */
  addFiling(row: {
    accession: string;
    cik: string;
    period: string;
    filingDate: string;
    managerName: string;
  }): void {
    this.filingsSeen += 1;
    const cik = normalizeCik(row.cik);
    const period = toIsoDate(row.period);
    const filingDate = toIsoDate(row.filingDate);
    if (!period || !filingDate || !row.accession) {
      this.filingsUnmatched += 1;
      this.unmatchedFilerKeys.add(cik ? `cik:${cik}` : `name:${row.managerName}`);
      return;
    }
    const byCik = this.options.filerByCik.get(cik);
    let holderCompanyId = byCik;
    let holderMatchedBy: "cik" | "name" = "cik";
    if (!holderCompanyId) {
      const match = matchName(this.options.filerByName, row.managerName);
      if (match.ambiguous) {
        this.ambiguousFilerKeys.add(`name:${row.managerName.trim().toLowerCase()}`);
        return;
      }
      if (!match.companyId) {
        this.filingsUnmatched += 1;
        this.unmatchedFilerKeys.add(
          cik ? `cik:${cik}` : `name:${row.managerName.trim().toLowerCase()}`,
        );
        return;
      }
      holderCompanyId = match.companyId;
      holderMatchedBy = "name";
    }
    this.filingsMatched += 1;
    if (holderMatchedBy === "cik") this.holderIdsByCik.add(holderCompanyId);
    else this.holderIdsByName.add(holderCompanyId);
    this.filings.set(row.accession, {
      accession: row.accession,
      cik,
      period,
      filingDate,
      managerName: row.managerName,
      holderCompanyId,
      holderMatchedBy,
    });
    if (this.latestPeriod === null || period > this.latestPeriod) {
      this.latestPeriod = period;
    }
    if (filingDate >= "2023-01-03") this.dollarFilings += 1;
    else this.thousandFilings += 1;
  }

  /** True when this accession is a matched 13F-HR filing. */
  hasFiling(accession: string): boolean {
    return this.filings.has(accession);
  }

  /** Feed one INFOTABLE row; rows from unselected filings are ignored. */
  addHolding(row: {
    accession: string;
    issuerName: string;
    cusip: string;
    value: number;
    shares: number;
    shareType?: string;
    putCall?: string;
  }): void {
    const filing = this.filings.get(row.accession);
    if (!filing) return;
    this.holdingsRows += 1;
    const putCall = (row.putCall ?? "").trim();
    if (putCall) {
      this.optionRows += 1;
      return;
    }
    const shareType = (row.shareType ?? "SH").trim().toUpperCase();
    if (shareType !== "SH") {
      this.nonShareRows += 1;
      return;
    }
    const cusip = (row.cusip ?? "").trim().toUpperCase();
    if (!cusip) return;
    const issuerName = (row.issuerName ?? "").trim();
    let issuerCompanyId = this.options.issuerByCusip.get(cusip);
    let issuerMatchedBy: "cusip" | "name" = "cusip";
    if (!issuerCompanyId) {
      const match = matchName(this.options.issuerByName, issuerName);
      if (match.ambiguous) {
        this.ambiguousIssuerNames.add(issuerName);
        this.unmatchedIssuerCusips.add(cusip);
        return;
      }
      if (!match.companyId) {
        this.unmatchedIssuerCusips.add(cusip);
        this.unmatchedIssuerNames.add(issuerName);
        return;
      }
      issuerCompanyId = match.companyId;
      issuerMatchedBy = "name";
      this.issuerNameMatches += 1;
      this.nameMatchedIssuerIds.add(issuerCompanyId);
    }
    if (issuerCompanyId === filing.holderCompanyId) {
      this.selfRows += 1;
      return;
    }
    this.matchedHoldingsRows += 1;
    this.issuerIds.add(issuerCompanyId);
    const dollarUnits = filing.filingDate >= "2023-01-03";
    const valueUsd = row.value * (dollarUnits ? 1 : 1_000);
    const shares = row.shares;
    const key = `${filing.holderCompanyId}\0${issuerCompanyId}`;
    const existing = this.edges.get(key);
    if (!existing) {
      this.edges.set(key, {
        holderCompanyId: filing.holderCompanyId,
        issuerCompanyId,
        period: filing.period,
        filingDate: filing.filingDate,
        accession: filing.accession,
        cusip,
        issuerName,
        managerName: filing.managerName,
        holderCik: filing.cik,
        holderMatchedBy: filing.holderMatchedBy,
        issuerMatchedBy,
        valueUsd,
        shares,
        dollarUnits,
      });
      return;
    }
    if (filing.period > existing.period) {
      existing.period = filing.period;
      existing.filingDate = filing.filingDate;
      existing.accession = filing.accession;
      existing.cusip = cusip;
      existing.issuerName = issuerName;
      existing.managerName = filing.managerName;
      existing.holderCik = filing.cik;
      existing.holderMatchedBy = filing.holderMatchedBy;
      existing.issuerMatchedBy = issuerMatchedBy;
      existing.valueUsd = valueUsd;
      existing.shares = shares;
      existing.dollarUnits = dollarUnits;
      return;
    }
    if (filing.period === existing.period) {
      existing.valueUsd += valueUsd;
      existing.shares += shares;
      if (filing.filingDate > existing.filingDate) {
        existing.filingDate = filing.filingDate;
        existing.accession = filing.accession;
        existing.cusip = cusip;
        existing.issuerName = issuerName;
        existing.managerName = filing.managerName;
        existing.holderCik = filing.cik;
        existing.holderMatchedBy = filing.holderMatchedBy;
        existing.issuerMatchedBy = issuerMatchedBy;
        existing.dollarUnits = dollarUnits;
      }
    }
  }

  finish(): ThirteenFPlan {
    const edges: OwnershipEdgeDraft[] = [...this.edges.values()]
      .sort((left, right) => right.valueUsd - left.valueUsd)
      .map((edge) => {
        const sourceUrl = secFilingUrl(edge.holderCik, edge.accession);
        const quote = [
          `${edge.period} Form 13F-HR`,
          `${edge.issuerName} (CUSIP ${edge.cusip})`,
          `${formatInteger(edge.shares)} shares`,
          `$${formatInteger(edge.valueUsd)}${edge.dollarUnits ? "" : " (reported in thousands)"}`,
          `accession ${edge.accession}`,
        ].join(" · ");
        return {
          srcCompanyId: edge.holderCompanyId,
          dstCompanyId: edge.issuerCompanyId,
          type: "invests_in" as const,
          quote,
          sourceUrl,
          sourceTitle: `SEC Form 13F-HR — ${edge.managerName} — ${edge.period}`,
          confidence: 0.9,
          validFrom: edge.period,
          publishedAt: dateOrUndefined(edge.filingDate),
          amount: Math.round(edge.valueUsd * 100) / 100,
          currency: "USD",
          metadata: {
            source: "sec-13f",
            period: edge.period,
            filingDate: edge.filingDate,
            accession: edge.accession,
            shares: edge.shares,
            valueUsd: edge.valueUsd,
            cusip: edge.cusip,
            issuerName: edge.issuerName,
            managerName: edge.managerName,
            holderCik: edge.holderCik,
            holderMatchedBy: edge.holderMatchedBy,
            issuerMatchedBy: edge.issuerMatchedBy,
            valueUnit: edge.dollarUnits ? "USD" : "thousands-USD",
          },
          extractorVersion: THIRTEEN_F_VERSION,
          origin: "sec-13f",
        };
      });
    return {
      edges,
      stats: {
        filings: this.filingsSeen,
        filingsMatched: this.filingsMatched,
        filingsUnmatched: this.filingsUnmatched,
        holders: new Set([
          ...this.holderIdsByCik,
          ...this.holderIdsByName,
        ]).size,
        holdersMatchedByCik: this.holderIdsByCik.size,
        holdersMatchedByName: this.holderIdsByName.size,
        filersUnmatched: this.unmatchedFilerKeys.size,
        ambiguousFilers: this.ambiguousFilerKeys.size,
        holdingsRows: this.holdingsRows,
        matchedHoldingsRows: this.matchedHoldingsRows,
        optionRows: this.optionRows,
        nonShareRows: this.nonShareRows,
        selfRows: this.selfRows,
        issuers: this.issuerIds.size,
        issuerNameMatchedCompanies: this.nameMatchedIssuerIds.size,
        unmatchedIssuerCusips: this.unmatchedIssuerCusips.size,
        unmatchedIssuerNames: this.unmatchedIssuerNames.size,
        issuerNameMatches: this.issuerNameMatches,
        ambiguousIssuerNames: this.ambiguousIssuerNames.size,
        latestPeriod: this.latestPeriod,
        dollarFilings: this.dollarFilings,
        thousandFilings: this.thousandFilings,
      },
    };
  }
}

/** Column positions resolved from a TSV header, so format changes fail loudly. */
export interface ThirteenFColumns {
  submission: {
    accession: number;
    filingDate: number;
    submissionType: number;
    cik: number;
    period: number;
  };
  coverPage: { accession: number; managerName: number };
  infoTable: {
    accession: number;
    issuerName: number;
    cusip: number;
    value: number;
    shares: number;
    shareType: number;
    putCall: number;
  };
}

export function submissionColumns(headerLine: string): ThirteenFColumns["submission"] {
  const header = tsvHeader(headerLine);
  return {
    accession: requiredColumn(header, "ACCESSION_NUMBER", "SUBMISSION"),
    filingDate: requiredColumn(header, "FILING_DATE", "SUBMISSION"),
    submissionType: requiredColumn(header, "SUBMISSIONTYPE", "SUBMISSION"),
    cik: requiredColumn(header, "CIK", "SUBMISSION"),
    period: requiredColumn(header, "PERIODOFREPORT", "SUBMISSION"),
  };
}

export function coverPageColumns(headerLine: string): ThirteenFColumns["coverPage"] {
  const header = tsvHeader(headerLine);
  return {
    accession: requiredColumn(header, "ACCESSION_NUMBER", "COVERPAGE"),
    managerName: requiredColumn(header, "FILINGMANAGER_NAME", "COVERPAGE"),
  };
}

export function infoTableColumns(headerLine: string): ThirteenFColumns["infoTable"] {
  const header = tsvHeader(headerLine);
  return {
    accession: requiredColumn(header, "ACCESSION_NUMBER", "INFOTABLE"),
    issuerName: requiredColumn(header, "NAMEOFISSUER", "INFOTABLE"),
    cusip: requiredColumn(header, "CUSIP", "INFOTABLE"),
    value: requiredColumn(header, "VALUE", "INFOTABLE"),
    shares: requiredColumn(header, "SSHPRNAMT", "INFOTABLE"),
    shareType: requiredColumn(header, "SSHPRNAMTTYPE", "INFOTABLE"),
    putCall: requiredColumn(header, "PUTCALL", "INFOTABLE"),
  };
}

/** Parse a small SUBMISSION.tsv (tests and one-shot diagnostics). */
export function parseThirteenFSubmissions(tsv: string): ThirteenFSubmissionRow[] {
  const lines = nonEmptyLines(tsv);
  if (lines.length === 0) return [];
  const columns = submissionColumns(lines[0]!);
  return lines.slice(1).map((line) => {
    const cells = tsvCells(line);
    return {
      accession: cells[columns.accession] ?? "",
      filingDate: cells[columns.filingDate] ?? "",
      submissionType: cells[columns.submissionType] ?? "",
      cik: cells[columns.cik] ?? "",
      period: cells[columns.period] ?? "",
    };
  });
}

/** Parse COVERPAGE.tsv into accession → manager name. */
export function parseThirteenFCoverPages(tsv: string): Map<string, string> {
  const lines = nonEmptyLines(tsv);
  const map = new Map<string, string>();
  if (lines.length === 0) return map;
  const columns = coverPageColumns(lines[0]!);
  for (const line of lines.slice(1)) {
    const cells = tsvCells(line);
    const accession = cells[columns.accession];
    if (!accession) continue;
    map.set(accession, cells[columns.managerName] ?? "");
  }
  return map;
}

/** Parse a small INFOTABLE.tsv (tests only; production streams line by line). */
export function parseThirteenFHoldings(tsv: string): ThirteenFHoldingRow[] {
  const lines = nonEmptyLines(tsv);
  if (lines.length === 0) return [];
  const columns = infoTableColumns(lines[0]!);
  return lines.slice(1).map((line) => {
    const cells = tsvCells(line);
    return {
      accession: cells[columns.accession] ?? "",
      issuerName: cells[columns.issuerName] ?? "",
      cusip: cells[columns.cusip] ?? "",
      value: parseNumber(cells[columns.value]),
      shares: parseNumber(cells[columns.shares]),
      shareType: cells[columns.shareType] ?? "",
      putCall: cells[columns.putCall] ?? "",
    };
  });
}

/** `31-MAR-2026` (SEC dataset) or `2026-03-31` → `2026-03-31`. */
export function toIsoDate(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return text;
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(text);
  if (!match) return null;
  const months: Record<string, string> = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };
  const month = months[match[2]!.toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${month}-${match[1]}`;
}

export function secFilingUrl(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/`;
}

export function normalizeCik(value: string): string {
  return value.trim().replace(/\D/g, "").padStart(10, "0");
}

function tsvHeader(line: string): string[] {
  return line.replace(/^﻿/, "").split("\t").map((cell) => cell.trim().toUpperCase());
}

function tsvCells(line: string): string[] {
  return line.split("\t");
}

function requiredColumn(header: string[], name: string, file: string): number {
  const index = header.indexOf(name);
  if (index < 0) {
    throw new Error(`13F ${file} is missing the ${name} column`);
  }
  return index;
}

function nonEmptyLines(tsv: string): string[] {
  return tsv.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.length > 0);
}

function parseNumber(value: string | undefined): number {
  if (!value) return 0;
  const number = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : 0;
}

/** Exported for the streaming INFOTABLE reader. */
export function parseThirteenFNumber(value: string | undefined): number {
  return parseNumber(value);
}

function formatInteger(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function dateOrUndefined(value: string): Date | undefined {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
