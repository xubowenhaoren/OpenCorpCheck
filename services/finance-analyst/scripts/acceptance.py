#!/usr/bin/env python3
"""P1 acceptance: AAPL (US), 600519 (A), 00700 (HK) return structured JSON.

Checks per page:
  * no error and HTTP 200
  * non-trivial text (>= 200 chars)
  * the old 8k truncation is gone (`truncated` is false)
  * table count and XHR count are reported

Exits non-zero on hard failures. Writes raw results to ``services/finance-analyst/out/``.
Run with: ``uv run python scripts/acceptance.py``
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from occ_finance_analyst.f10 import F10Scraper, Settings

SERVICE_DIR = Path(__file__).resolve().parent.parent
OUT_DIR = SERVICE_DIR / "out"

CASES = [
    {"market": "US", "code": "AAPL", "pages": ["cwfx", "gsgk"]},
    {"market": "A", "code": "600519", "pages": ["cwfx", "gsgk"]},
    {"market": "HK", "code": "00700", "pages": ["NewFinancialAnalysis", "CoreReading"]},
]

MIN_TEXT_CHARS = 800  # the SPA shell alone is ~285 chars


async def main() -> int:
    OUT_DIR.mkdir(exist_ok=True)
    settings = Settings.from_env()
    scraper = F10Scraper(settings)
    failures: list[str] = []
    rows: list[tuple[str, str, str, str, int, int, int]] = []

    try:
        for case in CASES:
            label = f"{case['market']}:{case['code']}"
            print(f"→ scraping {label} pages={case['pages']}", file=sys.stderr)
            result = await scraper.scrape(**case)
            path = OUT_DIR / f"{case['market']}-{case['code']}.json"
            path.write_text(
                json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            print(f"  wrote {path}", file=sys.stderr)

            if result["errors"]:
                failures.extend(f"{label}: {error}" for error in result["errors"])

            for page in result["pages"]:
                status = "ok" if not page["error"] else "FAIL"
                if page["error"]:
                    failure = f"{label}/{page['page']}: {page['error']}"
                    if failure not in failures:
                        failures.append(failure)
                if page["http_status"] != 200:
                    failures.append(
                        f"{label}/{page['page']}: HTTP {page['http_status']}"
                    )
                if not page["error"] and page["text_chars"] < MIN_TEXT_CHARS:
                    failures.append(
                        f"{label}/{page['page']}: only {page['text_chars']} text chars"
                    )
                if page["truncated"]:
                    failures.append(
                        f"{label}/{page['page']}: text still truncated at 2 MB cap"
                    )
                rows.append(
                    (
                        label,
                        page["page"],
                        status,
                        str(page["http_status"]),
                        page["text_chars"],
                        page["table_count"],
                        len(page["xhr"] or []),
                    )
                )
    finally:
        await scraper.close()

    print()
    print("| case | page | status | HTTP | chars | tables | xhr |")
    print("|---|---|---|---:|---:|---:|---:|")
    for row in rows:
        print("| {} | {} | {} | {} | {} | {} | {} |".format(*row))

    if failures:
        print("\nFAILURES:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("\nPASS: all acceptance cases returned structured JSON")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
