import { describe, expect, it } from "vitest";

import type { ResearchJobView } from "@occ/core";

import type { DataRunView } from "../api";
import {
  dataRunPercent,
  dataRunState,
  describeDataRun,
  describeDataSubtask,
  groupDataJobs,
} from "./task-dock";

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

function run(patch: Partial<DataRunView> = {}): DataRunView {
  return {
    runId: "run-1",
    status: "running",
    total: 10,
    done: 4,
    failed: 0,
    companies: 10,
    inserted: 3,
    documents: 2,
    financials: 1,
    startedAt: "2026-11-03T08:00:00.000Z",
    finishedAt: null,
    elapsedMs: null,
    source: "auto",
    sweepSource: "schedule",
    active: true,
    ...patch,
  };
}

function job(patch: Partial<ResearchJobView> = {}): ResearchJobView {
  return {
    queue: "data.source.check",
    jobKey: "US:AAPL:edgar",
    companyId: "US:AAPL",
    status: "completed",
    attempts: 1,
    payload: { ticker: "AAPL", name: "Apple Inc." },
    meta: {},
    ...patch,
  };
}

describe("data run dock helpers", () => {
  it("maps run status and progress", () => {
    expect(dataRunState({ status: "queued" })).toBe("queued");
    expect(dataRunState({ status: "running" })).toBe("running");
    expect(dataRunState({ status: "partial" })).toBe("partial");
    expect(dataRunState({ status: "failed" })).toBe("failed");
    expect(dataRunState({ status: "completed" })).toBe("completed");
    expect(dataRunPercent({ done: 4, total: 10 })).toBe(40);
    expect(dataRunPercent({ done: 0, total: 0 })).toBe(0);
  });

  it("describes a data run without faking success", () => {
    expect(describeDataRun(run(), "zh", t)).toContain("dock.dataRunning");
    expect(
      describeDataRun(
        run({ status: "completed", active: false, inserted: 7 }),
        "zh",
        t,
      ),
    ).toContain('"count":7');
    expect(
      describeDataRun(
        run({ status: "completed", active: false, inserted: 0, financials: 0 }),
        "zh",
        t,
      ),
    ).toBe("dock.dataNoChange");
    expect(
      describeDataRun(
        run({ status: "completed", active: false, inserted: 0, financials: 1 }),
        "zh",
        t,
      ),
    ).toBe("dock.dataChecked");
    expect(
      describeDataRun(
        run({ status: "partial", active: false, failed: 2 }),
        "zh",
        t,
      ),
    ).toContain('"failed":2');
  });

  it("groups check, filing and financials jobs by company", () => {
    const groups = groupDataJobs([
      job(),
      job({
        queue: "ingest.filing",
        jobKey: "US:AAPL:edgar:filing",
        status: "active",
        payload: { filingIds: [] },
      }),
      job({
        queue: "financials.company",
        jobKey: "US:AAPL",
        status: "queued",
        payload: { ticker: "AAPL" },
      }),
      job({
        companyId: "HK:00700",
        payload: { ticker: "00700", name: "腾讯控股" },
        meta: { inserted: 0 },
      }),
    ]);
    expect(groups).toHaveLength(2);
    const apple = groups.find((group) => group.companyId === "US:AAPL")!;
    expect(apple.name).toBe("Apple Inc.");
    expect(apple.ticker).toBe("AAPL");
    expect(apple.checks[0]?.queue).toBe("data.source.check");
    expect(apple.filings).toHaveLength(1);
    expect(apple.financials?.status).toBe("queued");
  });

  it("merges dual-listed checks and keeps a failure visible", () => {
    const groups = groupDataJobs([
      job({ jobKey: "HK:02318:cninfo", status: "completed", meta: { inserted: 2 } }),
      job({
        jobKey: "HK:02318:hkexnews",
        status: "dead",
        payload: { ticker: "02318", name: "中国平安" },
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.checks).toHaveLength(2);
    expect(describeDataSubtask(groups[0]!, t)).toEqual({
      state: "failed",
      text: "dock.retrying",
    });
  });

  it("states what is actually happening per company", () => {
    expect(
      describeDataSubtask(
        { companyId: "US:AAPL", ticker: "AAPL", name: "Apple", checks: [job()], financials: null, filings: [] },
        t,
      ),
    ).toEqual({ state: "completed", text: "dock.noChange" });

    expect(
      describeDataSubtask(
        {
          companyId: "US:AAPL",
          ticker: "AAPL",
          name: "Apple",
          checks: [job({ meta: { inserted: 4 } })],
          financials: null,
          filings: [],
        },
        t,
      ).text,
    ).toContain('"count":4');

    expect(
      describeDataSubtask(
        {
          companyId: "US:AAPL",
          ticker: "AAPL",
          name: "Apple",
          checks: [job({ meta: { periodic: 1, enqueuedFinancials: 1 } })],
          financials: null,
          filings: [],
        },
        t,
      ),
    ).toEqual({ state: "running", text: "dock.financialsUpdating" });

    expect(
      describeDataSubtask(
        {
          companyId: "US:AAPL",
          ticker: "AAPL",
          name: "Apple",
          checks: [job()],
          financials: job({
            queue: "financials.company",
            status: "completed",
            meta: { financialsStatus: "pending" },
          }),
          filings: [],
        },
        t,
      ),
    ).toEqual({ state: "queued", text: "dock.financialsWaiting" });

    expect(
      describeDataSubtask(
        {
          companyId: "US:AAPL",
          ticker: "AAPL",
          name: "Apple",
          checks: [job()],
          financials: job({
            queue: "financials.company",
            status: "completed",
            meta: { financialsStatus: "applied" },
          }),
          filings: [],
        },
        t,
      ),
    ).toEqual({ state: "completed", text: "dock.financialsDone" });

    expect(
      describeDataSubtask(
        {
          companyId: "HK:00700",
          ticker: "00700",
          name: "腾讯控股",
          checks: [job({ status: "dead" })],
          financials: null,
          filings: [],
        },
        t,
      ),
    ).toEqual({ state: "failed", text: "dock.retrying" });
  });
});
