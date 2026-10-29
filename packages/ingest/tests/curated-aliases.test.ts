import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  clearCuratedAliasCache,
  curatedAliasesForTicker,
  defaultCuratedAliasPath,
  loadCuratedAliases,
  readCuratedAliasFile,
} from "../src/curated-aliases.js";

const configFile = fileURLToPath(
  new URL("../../../config/aliases/zh.yaml", import.meta.url),
);

describe("curated aliases", () => {
  it("resolves the default file inside the monorepo", () => {
    expect(defaultCuratedAliasPath()).toBe(configFile);
  });

  it("reads the curated Chinese names that profiles miss", () => {
    const parsed = readCuratedAliasFile(configFile);
    expect(parsed.aliases.NFLX).toContain("奈飞");
    expect(parsed.aliases.COST).toContain("好市多");
    expect(parsed.aliases.NVDA).toContain("英伟达");
    expect(parsed.aliases["600519"]).toContain("茅台");
  });

  it("normalizes tickers to uppercase", () => {
    clearCuratedAliasCache();
    const map = loadCuratedAliases(configFile);
    expect(map.get("NFLX")).toContain("奈飞");
    expect(curatedAliasesForTicker("nflx", configFile)).toContain("奈飞");
  });

  it("returns an empty list for unknown tickers instead of throwing", () => {
    expect(curatedAliasesForTicker("NOPE", configFile)).toEqual([]);
  });

  it("does not fail ingestion when the file is missing", () => {
    clearCuratedAliasCache();
    expect(curatedAliasesForTicker("NFLX", "/nonexistent/aliases.yaml")).toEqual(
      [],
    );
  });
});
