/**
 * Section markdown parsing and chunking for research profiles.
 *
 * Worker sections look like:
 *
 *   ## 贵州茅台酒股份有限公司（600519）
 *
 *   ### 1. 一句话
 *   ...
 *   ### 2. 公司快照
 *   | 项目 | 内容 |
 *   ...
 *
 * The title becomes the document title, every `###` heading becomes a chunk
 * section, and chunks target 500–800 tokens with a ~15% overlap.
 */

export interface SectionChapter {
  section: string;
  text: string;
}

export interface ParsedSection {
  /** Raw H1/H2 heading, e.g. `贵州茅台酒股份有限公司（600519）`. */
  title: string;
  /** Heading without the trailing ticker, e.g. `贵州茅台酒股份有限公司`. */
  displayName: string;
  legalName: string;
  chapters: SectionChapter[];
}

export interface TextChunk {
  section: string;
  text: string;
  tokenCount: number;
}

export interface ChunkOptions {
  targetTokens?: number;
  maxTokens?: number;
  overlapTokens?: number;
}

const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = {
  targetTokens: 600,
  maxTokens: 800,
  overlapTokens: 90,
};

const CJK = /[㐀-鿿豈-﫿]/g;
const LATIN_WORD = /[A-Za-z0-9]+(?:[.'’-][A-Za-z0-9]+)*/g;

/** Cheap, deterministic token estimate: CJK chars ≈ 1 token, Latin words ≈ 1.3. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(CJK) ?? []).length;
  const withoutCjk = text.replace(CJK, " ");
  const words = (withoutCjk.match(LATIN_WORD) ?? []).length;
  return cjk + Math.ceil(words * 1.3);
}

export function parseSectionMarkdown(markdown: string): ParsedSection {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let title = "";
  let titleLevel = Number.POSITIVE_INFINITY;
  let titleIndex = -1;

  for (const [index, line] of lines.entries()) {
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const level = match[1]!.length;
    if (level <= 2 && level < titleLevel) {
      title = match[2]!;
      titleLevel = level;
      titleIndex = index;
      if (level === 1) break;
    }
  }

  const body = titleIndex >= 0 ? lines.slice(titleIndex + 1) : lines;
  const chapters: SectionChapter[] = [];
  let currentSection = "概览";
  let buffer: string[] = [];

  const flush = (): void => {
    const text = buffer.join("\n").trim();
    if (text) chapters.push({ section: currentSection, text });
    buffer = [];
  };

  for (const line of body) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      currentSection = normalizeSectionName(heading[1]!);
      continue;
    }
    buffer.push(line);
  }
  flush();

  if (chapters.length === 0) {
    const text = body.join("\n").trim();
    if (text) chapters.push({ section: "全文", text });
  }

  const parsedTitle = title.trim();
  const nameMatch = /^(.*?)\s*[（(]\s*([^）)]*)\s*[）)]\s*$/.exec(parsedTitle);
  const displayName = (nameMatch?.[1] ?? parsedTitle).trim();

  return {
    title: parsedTitle,
    displayName,
    legalName: displayName,
    chapters,
  };
}

/** Split a parsed section into retrieval chunks. */
export function buildChunks(
  parsed: ParsedSection,
  options: ChunkOptions = {},
): TextChunk[] {
  const config = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const chunks: TextChunk[] = [];
  for (const chapter of parsed.chapters) {
    for (const text of chunkText(chapter.text, config)) {
      chunks.push({
        section: chapter.section,
        text,
        tokenCount: estimateTokens(text),
      });
    }
  }
  return chunks;
}

export function chunkText(
  text: string,
  options: ChunkOptions = {},
): string[] {
  const config = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block) =>
      estimateTokens(block) > config.maxTokens
        ? splitLongBlock(block, config.maxTokens)
        : [block],
    );

  if (blocks.length === 0) return [];

  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    const value = current.join("\n\n").trim();
    if (value) chunks.push(value);
  };

  const overlapTail = (): void => {
    const tail: string[] = [];
    let tokens = 0;
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const block = current[index]!;
      const blockTokens = estimateTokens(block);
      if (tail.length > 0 && tokens + blockTokens > config.overlapTokens) break;
      tail.unshift(block);
      tokens += blockTokens;
      if (tokens >= config.overlapTokens) break;
    }
    current = tail;
    currentTokens = tokens;
  };

  for (const block of blocks) {
    const blockTokens = estimateTokens(block);
    if (current.length > 0 && currentTokens + blockTokens > config.targetTokens) {
      flush();
      overlapTail();
      // The overlap plus the incoming block may still exceed the hard cap.
      if (currentTokens + blockTokens > config.maxTokens) {
        current = [];
        currentTokens = 0;
      }
    }
    current.push(block);
    currentTokens += blockTokens;
  }
  flush();

  return chunks.length > 0 ? chunks : [text.trim()];
}

function splitLongBlock(block: string, maxTokens: number): string[] {
  const lines = block.split("\n");
  if (lines.length > 1) return packPieces(lines, maxTokens, "\n");

  const sentences = block
    .split(/(?<=[。！？!?；;])\s*/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (sentences.length > 1) return packPieces(sentences, maxTokens, "");

  // Last resort: split by characters using the block's own token density.
  const tokens = Math.max(1, estimateTokens(block));
  const charsPerToken = block.length / tokens;
  const maxChars = Math.max(200, Math.floor(maxTokens * charsPerToken));
  const pieces: string[] = [];
  for (let start = 0; start < block.length; start += maxChars) {
    pieces.push(block.slice(start, start + maxChars));
  }
  return pieces;
}

function packPieces(pieces: string[], maxTokens: number, separator: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const candidate = current ? `${current}${separator}${piece}` : piece;
    if (current && estimateTokens(candidate) > maxTokens) {
      out.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

function normalizeSectionName(value: string): string {
  return value.replace(/^\d+[.、)]\s*/, "").trim() || "未命名章节";
}
