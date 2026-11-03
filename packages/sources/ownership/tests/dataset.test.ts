import { describe, expect, it } from "vitest";

import {
  parseThirteenFDataSets,
  pickLatestThirteenFDataSet,
} from "../src/sec-13f-dataset.js";

const html = `
<a href="/files/structureddata/data/form-13f-data-sets/01mar2026-31may2026_form13f.zip">latest</a>
<a href="/files/structureddata/data/form-13f-data-sets/01dec2025-28feb2026_form13f.zip">prev</a>
<a href="/files/structureddata/data/form-13f-data-sets/2023q4_form13f.zip">q4</a>
<a href="/files/structureddata/data/form-13f-data-sets/2016q1_form13f.zip">old</a>
`;

describe("13F data-set discovery", () => {
  it("parses date-range and quarterly names", () => {
    const datasets = parseThirteenFDataSets(html);
    expect(datasets).toHaveLength(4);
    expect(datasets[0]).toMatchObject({
      name: "01mar2026-31may2026",
      start: "2026-03-01",
      end: "2026-05-31",
    });
    expect(datasets[2]).toMatchObject({
      name: "2023q4",
      start: "2023-10-01",
      end: null,
    });
  });

  it("picks the newest window", () => {
    const latest = pickLatestThirteenFDataSet(parseThirteenFDataSets(html));
    expect(latest?.name).toBe("01mar2026-31may2026");
    expect(latest?.url).toContain("01mar2026-31may2026_form13f.zip");
  });
});
