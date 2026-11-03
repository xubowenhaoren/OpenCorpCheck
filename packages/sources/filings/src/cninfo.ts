import {
  DEFAULT_FILING_USER_AGENT,
  type FilingFetchOptions,
  type FilingItem,
} from "./types.js";
import { cleanText, startOfDay, isoDate } from "./text.js";

/**
 * CNINFO (巨潮资讯) announcement adapter (P1.4).
 *
 * CNINFO is the CSRC-designated disclosure platform for SSE and SZSE, so it
 * serves both A-share boards through one official JSON API. We resolve the
 * company's `orgId` through the public top-search endpoint (it is not always
 * derivable from the ticker), then query the announcement history and link
 * directly to the PDF hosted on `static.cninfo.com.cn`.
 *
 * One company = two requests. The CLI handles company-level pacing; this
 * module only retries transient errors.
 */

const CNINFO_BASE = "https://www.cninfo.com.cn";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CninfoStock {
  code: string;
  orgId: string;
  name?: string;
  category?: string;
  type?: string;
}

export interface CninfoAnnouncement {
  announcementId?: string | number;
  announcementTitle?: string;
  announcementTime?: number;
  adjunctUrl?: string;
  adjunctType?: string;
  adjunctSize?: number;
  orgId?: string;
  secCode?: string;
  secName?: string;
  announcementType?: string;
  announcementTypeName?: string | null;
  columnId?: string;
  pageColumn?: string;
}

export interface CninfoQuery {
  announcements?: CninfoAnnouncement[] | null;
  totalAnnouncement?: number;
  totalRecordNum?: number;
  hasMore?: boolean;
}

export function cninfoBoard(code: string): { column: "sse" | "szse"; plate: "sh" | "sz" } {
  const value = code.trim();
  // SSE A-shares (6xxxxx) and B-shares (900xxx). SZSE covers 0/2/3.
  return value.startsWith("6") || value.startsWith("9")
    ? { column: "sse", plate: "sh" }
    : { column: "szse", plate: "sz" };
}

export function parseCninfoStocks(payload: unknown, code: string): CninfoStock | null {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? ((payload as { data: unknown[] }).data)
      : [];
  const target = code.trim();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    if (String(entry.code ?? "").trim() !== target) continue;
    const orgId = String(entry.orgId ?? "").trim();
    if (!orgId) continue;
    return {
      code: target,
      orgId,
      name: typeof entry.zwjc === "string" ? entry.zwjc : undefined,
      category: typeof entry.category === "string" ? entry.category : undefined,
      type: typeof entry.type === "string" ? entry.type : undefined,
    };
  }
  return null;
}

export function cninfoPdfUrl(adjunctUrl: string): string {
  const value = adjunctUrl.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://static.cninfo.com.cn/${value.replace(/^\/+/, "")}`;
}

export function cninfoDetailUrl(input: {
  code: string;
  orgId: string;
  announcementId: string;
  publishedAt?: string;
}): string {
  const params = new URLSearchParams({
    stockCode: input.code,
    announcementId: input.announcementId,
    orgId: input.orgId,
  });
  if (input.publishedAt) {
    params.set("announcementTime", input.publishedAt.slice(0, 10));
  }
  return `${CNINFO_BASE}/new/disclosure/detail?${params.toString()}`;
}

/**
 * CNINFO returns a Beijing-midnight epoch. Convert it to the local calendar
 * date at 00:00Z so the source date (and the PDF path date) is not shifted by
 * one day in UTC/negative-offset timezones.
 */
export function cninfoPublishedAt(epochMs: number): string | undefined {
  if (!Number.isFinite(epochMs)) return undefined;
  const date = new Date(epochMs + 8 * 3_600_000);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** Coarse, deterministic announcement kind used for the timeline label. */
export function cninfoForm(title: string): string {
  const value = title.trim();
  if (/半年度报告|半年报|中期报告/.test(value)) return "半年报";
  if (/年度报告|年报/.test(value)) return "年报";
  if (/季度报告|季报/.test(value)) return "季报";
  if (/业绩预告|业绩快报|经营数据|主要经营/.test(value)) return "经营数据";
  if (/董事会|监事会|股东大会|股东会/.test(value)) return "治理";
  if (/利润分配|权益分派|分红/.test(value)) return "分红";
  if (/回购/.test(value)) return "回购";
  if (/关联交易/.test(value)) return "关联交易";
  if (/重大合同|中标|框架协议/.test(value)) return "重大合同";
  if (/停牌|复牌/.test(value)) return "停复牌";
  if (/增持|减持|权益变动/.test(value)) return "权益变动";
  return "公告";
}

export interface QueryCninfoOptions extends FilingFetchOptions {
  code: string;
  orgId?: string;
  /** Inclusive window; defaults to the last 365 days. */
  from?: Date;
  to?: Date;
  pageSize?: number;
  /** Follow `hasMore` until this many items are collected (default 30). */
  maxItems?: number;
}

export interface CninfoResult {
  stock: CninfoStock;
  items: FilingItem[];
  total: number;
  fetchedAt: string;
}

export async function fetchCninfoFilings(
  options: QueryCninfoOptions,
): Promise<CninfoResult> {
  const stock =
    (options.orgId
      ? { code: options.code, orgId: options.orgId }
      : await resolveCninfoStock(options.code, options)) ?? null;
  if (!stock) {
    throw new Error(`CNINFO could not resolve an orgId for ${options.code}`);
  }
  const to = options.to ?? new Date();
  const from = options.from ?? new Date(to.getTime() - 365 * 86_400_000);
  const pageSize = Math.min(Math.max(options.pageSize ?? 30, 1), 50);
  const maxItems = Math.max(options.maxItems ?? 30, 1);
  const board = cninfoBoard(options.code);
  const items: FilingItem[] = [];
  let total = 0;
  let pageNum = 1;

  while (items.length < maxItems) {
    const payload = await postCninfoForm(
      `${CNINFO_BASE}/new/hisAnnouncement/query`,
      {
        pageNum: String(pageNum),
        pageSize: String(pageSize),
        column: board.column,
        tabName: "fulltext",
        plate: board.plate,
        stock: `${stock.code},${stock.orgId}`,
        searchkey: "",
        secid: "",
        category: "",
        trade: "",
        seDate: `${isoDate(startOfDay(isoDate(from)))}~${isoDate(startOfDay(isoDate(to)))}`,
        sortName: "",
        sortType: "",
        isHLtitle: "true",
      },
      options,
    );
    const query = payload as CninfoQuery;
    total = Number(query.totalAnnouncement ?? query.totalRecordNum ?? total);
    const rows = Array.isArray(query.announcements) ? query.announcements : [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const externalId = String(row.announcementId ?? "").trim();
      const title = cleanText(row.announcementTitle);
      const pdfUrl = cninfoPdfUrl(row.adjunctUrl ?? "");
      if (!externalId || !title) continue;
      const publishedAt = row.announcementTime
        ? cninfoPublishedAt(Number(row.announcementTime))
        : undefined;
      const detailUrl = cninfoDetailUrl({
        code: stock.code,
        orgId: stock.orgId,
        announcementId: externalId,
        publishedAt,
      });
      const url = pdfUrl || detailUrl;
      const form = cninfoForm(title);
      items.push({
        source: "cninfo",
        market: "A",
        externalId,
        title,
        url,
        ...(pdfUrl ? { pdfUrl } : {}),
        form,
        category: board.plate === "sh" ? "上交所" : "深交所",
        publishedAt,
        language: "zh",
        trustTier: "official",
        metadata: {
          source: "cninfo-announcement",
          orgId: stock.orgId,
          secCode: row.secCode ?? stock.code,
          secName: row.secName ?? stock.name ?? null,
          announcementType: row.announcementType ?? null,
          announcementTypeName: row.announcementTypeName ?? null,
          columnId: row.columnId ?? null,
          pageColumn: row.pageColumn ?? null,
          adjunctType: row.adjunctType ?? null,
          adjunctSizeKb: row.adjunctSize ?? null,
          detailUrl,
        },
      });
      if (items.length >= maxItems) break;
    }
    if (!query.hasMore || items.length >= maxItems) break;
    pageNum += 1;
    if (pageNum > 20) break;
  }

  return { stock, items, total, fetchedAt: new Date().toISOString() };
}

export async function resolveCninfoStock(
  code: string,
  options: FilingFetchOptions = {},
): Promise<CninfoStock | null> {
  const payload = await postCninfoForm(
    `${CNINFO_BASE}/new/information/topSearch/query`,
    { keyWord: code, maxNum: "10" },
    options,
  );
  return parseCninfoStocks(payload, code);
}

async function postCninfoForm(
  url: string,
  form: Record<string, string>,
  options: FilingFetchOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = new URLSearchParams(form);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "user-agent": options.userAgent ?? DEFAULT_FILING_USER_AGENT,
          referer: `${CNINFO_BASE}/`,
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (response.status === 429 || response.status >= 500) {
        await sleep(500 * 2 ** attempt);
        lastError = new Error(`CNINFO responded ${response.status} for ${url}`);
        continue;
      }
      if (!response.ok) {
        throw new Error(`CNINFO responded ${response.status} for ${url}`);
      }
      const text = await response.text();
      return JSON.parse(text) as unknown;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`CNINFO request failed: ${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
