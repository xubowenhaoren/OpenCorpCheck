import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadIndexSnapshot, primaryConstituents } from "../src/ndx.js";

const NDX_FILE = fileURLToPath(
  new URL("../../../config/indices/ndx.yaml", import.meta.url),
);
const A500_FILE = fileURLToPath(
  new URL("../../../config/indices/a500.yaml", import.meta.url),
);
const SP500_FILE = fileURLToPath(
  new URL("../../../config/indices/sp500.yaml", import.meta.url),
);

// Index snapshots are proprietary and not shipped in the public repo.
// Local development keeps them via the gitignored `config/indices` symlink.
const hasSnapshots = [NDX_FILE, A500_FILE, SP500_FILE].every((file) =>
  existsSync(file),
);
const describeWithSnapshots = hasSnapshots ? describe : describe.skip;

describeWithSnapshots("config/indices/ndx.yaml", () => {
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

describeWithSnapshots("config/indices/a500.yaml", () => {
  it("loads the official CSI A500 snapshot", () => {
    const snapshot = loadIndexSnapshot(A500_FILE);
    expect(snapshot.index.code).toBe("A500");
    expect(snapshot.index.market).toBe("A");
    expect(snapshot.index.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snapshot.index.source.url).toContain("csindex.com.cn");
    expect(snapshot.index.weights_as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("has 500 securities owned by 500 companies", () => {
    const snapshot = loadIndexSnapshot(A500_FILE);
    expect(snapshot.constituents).toHaveLength(500);
    expect(primaryConstituents(snapshot)).toHaveLength(500);
    expect(new Set(snapshot.constituents.map((entry) => entry.ticker)).size).toBe(500);
  });

  it("keeps numeric tickers as strings with exchange and both names", () => {
    const snapshot = loadIndexSnapshot(A500_FILE);
    for (const entry of snapshot.constituents) {
      expect(entry.ticker).toMatch(/^\d{6}$/);
      expect(["SSE", "SZSE"]).toContain(entry.exchange);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.name_en?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describeWithSnapshots("config/indices/sp500.yaml", () => {
  it("loads the SPY-holdings fallback snapshot", () => {
    const snapshot = loadIndexSnapshot(SP500_FILE);
    expect(snapshot.index.code).toBe("SPX");
    expect(snapshot.index.market).toBe("US");
    expect(snapshot.index.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snapshot.index.source.url).toContain("ssga.com");
  });

  it("has 503 securities and 500 companies", () => {
    const snapshot = loadIndexSnapshot(SP500_FILE);
    expect(snapshot.constituents).toHaveLength(503);
    expect(primaryConstituents(snapshot)).toHaveLength(500);
    expect(new Set(primaryConstituents(snapshot).map((entry) => entry.ticker)).size).toBe(500);
  });

  it("attaches secondary share classes to the primary company", () => {
    const snapshot = loadIndexSnapshot(SP500_FILE);
    const byTicker = new Map(
      snapshot.constituents.map((entry) => [entry.ticker, entry]),
    );
    for (const ticker of ["GOOG", "FOX", "NWS"]) {
      expect(byTicker.get(ticker)?.primary).toBe(false);
    }
    for (const ticker of ["GOOGL", "FOXA", "NWSA"]) {
      expect(byTicker.get(ticker)?.primary).toBe(true);
    }
    expect(byTicker.get("GOOG")?.cik).toBe(byTicker.get("GOOGL")?.cik);
    expect(byTicker.get("GOOG")?.weight).toBe(byTicker.get("GOOGL")?.weight);
  });

  it("keeps ten-digit CIK strings", () => {
    const snapshot = loadIndexSnapshot(SP500_FILE);
    const nvidia = snapshot.constituents.find((entry) => entry.ticker === "NVDA");
    expect(nvidia?.cik).toBe("0001045810");
  });
});
