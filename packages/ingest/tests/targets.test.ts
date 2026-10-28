import { describe, expect, it } from "vitest";

import {
  companySlug,
  exchangeForMarket,
  parseTicker,
  tickerIdValue,
} from "../src/index.js";

describe("parseTicker", () => {
  it.each([
    ["600519", "A:600519", "A", "600519"],
    ["600519:A", "A:600519", "A", "600519"],
    ["SH600519", "A:600519", "A", "600519"],
    ["00700", "HK:00700", "HK", "00700"],
    ["700:HK", "HK:00700", "HK", "00700"],
    ["02513.HK", "HK:02513", "HK", "02513"],
    ["AAPL", "US:AAPL", "US", "AAPL"],
    ["BRK.B", "US:BRK.B", "US", "BRK.B"],
  ])("parses %s", (input, key, market, code) => {
    expect(parseTicker(input)).toEqual({ key, ticker: code, market, code });
  });

  it("rejects unsafe values", () => {
    expect(parseTicker("")).toBeNull();
    expect(parseTicker("../etc")).toBeNull();
  });
});

describe("exchange and identifier formatting", () => {
  it("maps markets to exchanges", () => {
    expect(exchangeForMarket("A", "600519")).toBe("SSE");
    expect(exchangeForMarket("A", "000001")).toBe("SZSE");
    expect(exchangeForMarket("HK", "00700")).toBe("HKEX");
    expect(exchangeForMarket("US", "AAPL")).toBe("NASDAQ");
  });

  it("formats ticker ids per market", () => {
    expect(
      tickerIdValue({ market: "US", ticker: "AAPL", code: "AAPL" }),
    ).toBe("AAPL");
    expect(
      tickerIdValue({ market: "HK", ticker: "00700", code: "00700" }),
    ).toBe("00700.HK");
    expect(
      tickerIdValue({ market: "A", ticker: "600519", code: "600519" }),
    ).toBe("600519.SH");
  });
});

describe("companySlug", () => {
  it.each([
    ["Apple Inc.", "apple"],
    ["Analog Devices, Inc.", "analog-devices"],
    ["Automatic Data Processing, Inc.", "automatic-data-processing"],
    ["Alphabet Inc.", "alphabet"],
    ["Tencent Holdings Limited", "tencent"],
  ])("normalizes %s", (input, expected) => {
    expect(companySlug(input)).toBe(expected);
  });
});
