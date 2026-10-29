import { describe, expect, it } from "vitest";

import {
  buildRelationRequest,
  findRelationCandidates,
  runRelationRequest,
  type RelationRequestInput,
} from "../src/relations/extract.js";
import type { ChatClient } from "../src/relations/llm.js";
import type { UniverseCompany } from "../src/relations/prompt.js";
import { parseRelationsJson, validateRelations } from "../src/relations/validate.js";

const universe: UniverseCompany[] = [
  {
    id: "c_aapl",
    ticker: "AAPL",
    displayName: "Apple Inc.",
    names: ["Apple", "Apple Inc.", "苹果"],
  },
  {
    id: "c_googl",
    ticker: "GOOGL",
    displayName: "Alphabet Inc.",
    names: ["Google", "Alphabet", "谷歌"],
  },
  {
    id: "c_tsm",
    ticker: "TSM",
    displayName: "Taiwan Semiconductor Manufacturing",
    names: ["TSMC", "台积电", "Taiwan Semiconductor"],
  },
];

const chapterText =
  "对外最重要的一条是 Google/Alphabet：既是 Siri 的模型供应商，也是默认搜索位付费方 [10]。台积电负责代工 A 系列芯片 [11]。";

const citations = [
  { ref: 10, title: "Apple and Gemini" },
  { ref: 11, title: "TSMC Apple chips" },
];

describe("relation candidates", () => {
  it("finds whole-word company mentions and excludes self", () => {
    const candidates = findRelationCandidates(chapterText, universe, "c_aapl");
    expect(candidates.map((company) => company.ticker)).toEqual(["GOOGL", "TSM"]);
  });

  it("does not match a company name inside another word", () => {
    const text = "Applesauce is not Apple.";
    const candidates = findRelationCandidates(text, universe, "c_googl");
    // "Apple." does match as a whole word; "Applesauce" must not.
    expect(candidates.every((company) => company.ticker !== "TSM")).toBe(true);
  });
});

describe("relation validation", () => {
  const base = {
    candidates: universe,
    chapterText,
    citationRefs: [10, 11],
    selfCompanyId: "c_aapl",
  };

  it("accepts a quoted, cited, in-universe relation", () => {
    const result = validateRelations({
      ...base,
      raw: [
        {
          dst_ticker: "GOOGL",
          type: "buys_from",
          quote: "Google/Alphabet：既是 Siri 的模型供应商",
          refs: [10],
          confidence: 0.7,
        },
      ],
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({
      dstTicker: "GOOGL",
      type: "buys_from",
      refs: [10],
    });
  });

  it("drops self, unknown, invalid type, bad quote and missing refs", () => {
    const result = validateRelations({
      ...base,
      raw: [
        { dst_ticker: "AAPL", type: "supplies", quote: "台积电负责代工", refs: [11] },
        { dst_ticker: "MSFT", type: "supplies", quote: "台积电负责代工", refs: [11] },
        { dst_ticker: "TSM", type: "unknown_type", quote: "台积电负责代工", refs: [11] },
        { dst_ticker: "TSM", type: "supplies", quote: "这句话不存在", refs: [11] },
        { dst_ticker: "TSM", type: "supplies", quote: "台积电负责代工", refs: [99] },
      ],
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.dropped.map((entry) => entry.reason)).toEqual([
      "unknown_or_self_destination",
      "unknown_or_self_destination",
      "invalid_type",
      "quote_not_in_source",
      "missing_valid_citation",
    ]);
  });

  it("drops duplicates and tolerates fenced JSON", () => {
    const raw = parseRelationsJson(
      '```json\n{"relations":[{"dst_ticker":"TSM","type":"supplies","quote":"台积电负责代工","refs":[11]},{"dst_ticker":"TSM","type":"supplies","quote":"台积电负责代工","refs":[11]}]}\n```',
    );
    expect(raw).toHaveLength(2);
    const result = validateRelations({ ...base, raw });
    expect(result.accepted).toHaveLength(1);
    expect(result.dropped[0]?.reason).toBe("duplicate");
  });
});

describe("relation prompt and LLM run", () => {
  const input: RelationRequestInput = {
    companyId: "c_aapl",
    companyName: "Apple Inc.",
    companyTicker: "AAPL",
    chapterText,
    citations,
    universe,
  };

  it("builds a prompt naming the candidates and returns null with no matches", () => {
    const request = buildRelationRequest(input);
    expect(request?.prompt).toContain("GOOGL");
    expect(request?.prompt).toContain("buys_from");
    expect(request?.promptHash).toHaveLength(64);
    expect(
      buildRelationRequest({ ...input, chapterText: "没有任何公司名。" }),
    ).toBeNull();
  });

  it("runs the chat client and keeps validated relations", async () => {
    const chat: ChatClient = {
      async complete() {
        return {
          text: JSON.stringify({
            relations: [
              {
                dst_ticker: "GOOGL",
                type: "buys_from",
                quote: "Google/Alphabet：既是 Siri 的模型供应商",
                refs: [10],
                confidence: 0.7,
              },
            ],
          }),
          inputTokens: 100,
          outputTokens: 20,
        };
      },
    };
    const request = buildRelationRequest(input)!;
    const result = await runRelationRequest(request, chat);
    expect(result.error).toBeUndefined();
    expect(result.relations).toHaveLength(1);
    expect(result.rawCount).toBe(1);
    expect(result.inputTokens).toBe(100);
  });

  it("returns an error instead of throwing on malformed JSON", async () => {
    const chat: ChatClient = {
      async complete() {
        return { text: "not json", inputTokens: 1, outputTokens: 1 };
      },
    };
    const request = buildRelationRequest(input)!;
    const result = await runRelationRequest(request, chat);
    expect(result.error).toBeUndefined();
    expect(result.relations).toHaveLength(0);
  });
});
