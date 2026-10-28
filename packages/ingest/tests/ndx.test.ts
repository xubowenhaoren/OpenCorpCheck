import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadIndexSnapshot, primaryConstituents } from "../src/ndx.js";

const NDX_FILE = fileURLToPath(
  new URL("../../../config/indices/ndx.yaml", import.meta.url),
);

describe("config/indices/ndx.yaml", () => {
  it("loads the official Nasdaq snapshot with metadata", () => {
    const snapshot = loadIndexSnapshot(NDX_FILE);
    expect(snapshot.index.code).toBe("NDX");
    expect(snapshot.index.market).toBe("US");
    expect(snapshot.index.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snapshot.index.source.url).toContain("nasdaq.com");
    expect(snapshot.index.source.license).toContain("redistribution");
  });

  it("has 101 securities and 100 backfill companies", () => {
    const snapshot = loadIndexSnapshot(NDX_FILE);
    expect(snapshot.constituents).toHaveLength(101);
    expect(primaryConstituents(snapshot)).toHaveLength(100);
  });

  it("marks Alphabet's second share class as non-primary", () => {
    const snapshot = loadIndexSnapshot(NDX_FILE);
    const byTicker = new Map(
      snapshot.constituents.map((entry) => [entry.ticker, entry]),
    );
    expect(byTicker.get("GOOGL")?.primary).toBe(true);
    expect(byTicker.get("GOOG")?.primary).toBe(false);
  });

  it("has unique primary tickers", () => {
    const snapshot = loadIndexSnapshot(NDX_FILE);
    const tickers = primaryConstituents(snapshot).map((entry) => entry.ticker);
    expect(new Set(tickers).size).toBe(tickers.length);
  });
});
