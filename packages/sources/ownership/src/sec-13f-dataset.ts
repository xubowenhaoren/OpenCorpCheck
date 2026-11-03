import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { openZipEntry, readZipText } from "./zip.js";

/**
 * SEC Form 13F data-set discovery, download and streaming.
 *
 * The SEC publishes a ZIP per filing window (the current naming is a date
 * range, e.g. `01mar2026-31may2026_form13f.zip`; older quarters use
 * `2023q4_form13f.zip`). The ZIP is cached under
 * `<OCC_EDGAR_DIR>/13f/<name>/` with its SHA-256; raw files are never
 * committed.
 */

export const THIRTEEN_F_PAGE_URL =
  "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets";

export interface ThirteenFDataSet {
  name: string;
  url: string;
  /** ISO date of the first filing in the window, when derivable. */
  start: string | null;
  end: string | null;
}

export interface CachedThirteenFDataSet extends ThirteenFDataSet {
  zipPath: string;
  sha256: string;
  bytes: number;
  downloaded: boolean;
}

const MONTHS: Record<string, string> = {
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

/** Extract every 13F ZIP link from the SEC data-set page. */
export function parseThirteenFDataSets(
  html: string,
  baseUrl = "https://www.sec.gov",
): ThirteenFDataSet[] {
  const pattern =
    /href="([^"]*form-13f-data-sets\/([^"/]+)_form13f\.zip)"/gi;
  const seen = new Set<string>();
  const out: ThirteenFDataSet[] = [];
  for (const match of html.matchAll(pattern)) {
    const href = match[1]!;
    const name = match[2]!;
    if (seen.has(name)) continue;
    seen.add(name);
    const url = href.startsWith("http") ? href : `${baseUrl}${href}`;
    const range = parseRangeName(name);
    out.push({ name, url, start: range.start, end: range.end });
  }
  return out;
}

export function pickLatestThirteenFDataSet(
  datasets: ThirteenFDataSet[],
): ThirteenFDataSet | null {
  let best: ThirteenFDataSet | null = null;
  for (const dataset of datasets) {
    if (!best) {
      best = dataset;
      continue;
    }
    const left = dataset.start ?? "";
    const right = best.start ?? "";
    if (left > right || (left === right && (dataset.end ?? "") > (best.end ?? ""))) {
      best = dataset;
    }
  }
  return best;
}

export async function resolveThirteenFDataSets(options: {
  userAgent: string;
  pageUrl?: string;
}): Promise<ThirteenFDataSet[]> {
  assertSecUserAgent(options.userAgent);
  const pageUrl = options.pageUrl ?? THIRTEEN_F_PAGE_URL;
  const response = await fetch(pageUrl, {
    headers: { "User-Agent": options.userAgent, Accept: "text/html" },
  });
  if (!response.ok) {
    throw new Error(`SEC 13F data-set page HTTP ${response.status}`);
  }
  const html = await response.text();
  return parseThirteenFDataSets(html);
}

export async function resolveLatestThirteenFDataSet(options: {
  userAgent: string;
  pageUrl?: string;
}): Promise<ThirteenFDataSet> {
  const datasets = await resolveThirteenFDataSets(options);
  const dataset = pickLatestThirteenFDataSet(datasets);
  if (!dataset) {
    throw new Error(
      `no 13F data set found on ${options.pageUrl ?? THIRTEEN_F_PAGE_URL}`,
    );
  }
  return dataset;
}

export async function ensureThirteenFDataSet(options: {
  dataset: ThirteenFDataSet;
  edgarDir: string;
  userAgent: string;
  refresh?: boolean;
  verify?: boolean;
  onProgress?: (message: string) => void;
}): Promise<CachedThirteenFDataSet> {
  assertSecUserAgent(options.userAgent);
  const dir = path.join(options.edgarDir, "13f", options.dataset.name);
  const zipPath = path.join(dir, "dataset.zip");
  const metaPath = path.join(dir, "meta.json");
  const existing = readMeta(metaPath);
  if (!options.refresh && existing && fs.existsSync(zipPath)) {
    const bytes = fs.statSync(zipPath).size;
    if (existing.bytes === bytes && existing.url === options.dataset.url) {
      if (!options.verify) {
        return {
          ...options.dataset,
          zipPath,
          sha256: existing.sha256,
          bytes,
          downloaded: false,
        };
      }
      const sha256 = await sha256File(zipPath);
      if (sha256 === existing.sha256) {
        return {
          ...options.dataset,
          zipPath,
          sha256,
          bytes,
          downloaded: false,
        };
      }
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${zipPath}.tmp`;
  options.onProgress?.(
    `downloading ${options.dataset.name} (${options.dataset.url})`,
  );
  const response = await fetch(options.dataset.url, {
    headers: {
      "User-Agent": options.userAgent,
      Accept: "application/zip,application/octet-stream",
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `SEC 13F data set HTTP ${response.status} for ${options.dataset.url}`,
    );
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    const body = Readable.fromWeb(
      response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    );
    await pipeline(body, hasher, fs.createWriteStream(tempPath));
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  const sha256 = hash.digest("hex");
  fs.renameSync(tempPath, zipPath);
  fs.writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        name: options.dataset.name,
        url: options.dataset.url,
        sha256,
        bytes,
        downloadedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    ...options.dataset,
    zipPath,
    sha256,
    bytes,
    downloaded: true,
  };
}

/** Stream one TSV member line by line. The caller owns parsing. */
export async function* readThirteenFTsv(
  zipPath: string,
  member: "SUBMISSION.tsv" | "COVERPAGE.tsv" | "INFOTABLE.tsv",
): AsyncGenerator<string> {
  const stream = await openZipEntry(zipPath, member);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let first = true;
  try {
    for await (const line of lines) {
      if (first) {
        first = false;
        yield line.replace(/^﻿/, "");
      } else {
        yield line;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function readThirteenFMember(
  zipPath: string,
  member: "SUBMISSION.tsv" | "COVERPAGE.tsv" | "INFOTABLE.tsv",
): Promise<string> {
  return readZipText(zipPath, member);
}

function parseRangeName(name: string): { start: string | null; end: string | null } {
  const range = /^(\d{2})([a-z]{3})(\d{4})-(\d{2})([a-z]{3})(\d{4})$/i.exec(
    name,
  );
  if (range) {
    const startMonth = MONTHS[range[2]!.toLowerCase()];
    const endMonth = MONTHS[range[5]!.toLowerCase()];
    if (startMonth && endMonth) {
      return {
        start: `${range[3]}-${startMonth}-${range[1]}`,
        end: `${range[6]}-${endMonth}-${range[4]}`,
      };
    }
  }
  const quarter = /^(\d{4})q([1-4])$/i.exec(name);
  if (quarter) {
    const month = String((Number(quarter[2]) - 1) * 3 + 1).padStart(2, "0");
    return { start: `${quarter[1]}-${month}-01`, end: null };
  }
  return { start: null, end: null };
}

function assertSecUserAgent(value: string): void {
  if (!value || !value.includes("@")) {
    throw new Error(
      "SEC requires a User-Agent with a contact address; set OCC_EDGAR_USER_AGENT",
    );
  }
}

function readMeta(
  file: string,
): { url: string; sha256: string; bytes: number } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      url?: string;
      sha256?: string;
      bytes?: number;
    };
    if (!parsed.url || !parsed.sha256 || typeof parsed.bytes !== "number") {
      return null;
    }
    return { url: parsed.url, sha256: parsed.sha256, bytes: parsed.bytes };
  } catch {
    return null;
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
