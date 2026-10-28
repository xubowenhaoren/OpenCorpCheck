import type { ScrapeResponse } from "../src/types.ts";

export function makeScrapeResponse(): ScrapeResponse {
  return {
    meta: {
      market: "A",
      code: "600519",
      normalized_code: "SH600519",
      fetched_at: "2026-10-28T00:00:00.000Z",
      elapsed_ms: 12_345,
      pages_requested: 1,
      pages_ok: 1,
      concurrency: 2,
      rate_per_sec: 5,
    },
    pages: [
      {
        label: "财务分析",
        page: "cwfx",
        url: "https://emweb.eastmoney.com/PC_HSF10/pages/index.html?code=SH600519#/cwfx",
        final_url:
          "https://emweb.eastmoney.com/PC_HSF10/pages/index.html?code=SH600519#/cwfx",
        http_status: 200,
        text: "主要指标\n" + "营".repeat(25_000),
        text_chars: 25_005,
        truncated: false,
        tables: [
          {
            caption: "主要指标",
            headers: ["指标", "2025"],
            rows: Array.from({ length: 100 }, (_, index) => [
              `指标${index}`,
              String(index),
            ]),
          },
        ],
        table_count: 1,
        html_sha256: "abc123",
        storage_key: "f10/A/SH600519/cwfx/abc123.html",
        xhr: [
          {
            url: "https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=X",
            status: 200,
            content_type: "text/plain;charset=UTF-8",
            json: { result: { data: [{ X: 1 }] } },
            text: null,
            truncated: false,
          },
          {
            url: "https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FN_BALANCE&columns=Y",
            status: 200,
            content_type: "text/plain;charset=UTF-8",
            json: { result: { data: [] } },
            text: null,
            truncated: false,
          },
        ],
        warnings: [],
        attempts: 1,
        elapsed_ms: 12_000,
        error: null,
      },
    ],
    errors: [],
  };
}
