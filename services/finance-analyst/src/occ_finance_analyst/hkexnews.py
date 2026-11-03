"""HKEXnews listed-company announcement search (P1.4).

The public title-search page is a JSF form; the old plain-HTTP
``titleSearchServlet`` now returns an empty result for these searches. We use
the same Playwright Chromium as the F10/DION adapters, drive the normal form
(stock id + date range + submit), and read the server-rendered result table.

Politeness: one search at a time, at most two page loads (search page + form
submit), with a small settle delay. The TypeScript adapter caps items and
paces companies.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from playwright.async_api import (
    Page,
    TimeoutError as PlaywrightTimeoutError,
)

from .f10 import BrowserManager
from .limiter import DomainLimiter

logger = logging.getLogger(__name__)

SEARCH_URL = "https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=en"
PREFIX_URL = "https://www1.hkexnews.hk/search/prefix.do"
HK_TZ = timezone(timedelta(hours=8))
SEARCH_HOST = "https://www1.hkexnews.hk"

SUBMIT_JS = r"""
({ stockId, fromDate, toDate }) => {
  const form = Array.from(document.querySelectorAll("form")).find(
    (candidate) => candidate.querySelector('input[name="stockId"]')
  );
  if (!form) throw new Error("HKEXnews search form not found");
  const set = (name, value) => {
    const field = form.querySelector(`input[name="${name}"]`);
    if (field) field.value = value;
  };
  set("stockId", String(stockId));
  set("from", fromDate);
  set("to", toDate);
  const display = form.querySelector('input[name="displayResultTable"]');
  if (display) display.value = "visible";
  form.submit();
  return true;
}
"""

ROWS_JS = r"""
() => Array.from(document.querySelectorAll("table tr")).map((tr) => {
  const tds = Array.from(tr.querySelectorAll("td"));
  if (tds.length < 4) return null;
  const cells = tds.map((td) => (td.innerText || "").replace(/\s+/g, " ").trim());
  const anchor = tr.querySelector('a[href*=".pdf"], a[href*=".PDF"]');
  const docText = (tds[3].innerText || "").trim();
  const lines = docText.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    date: cells[0] || "",
    stock_code: (tds[1].innerText || "").trim().split("\n")[0].trim(),
    stock_name: (tds[2].innerText || "").trim().split("\n")[0].trim(),
    category: lines[0] || "",
    title: anchor ? (anchor.innerText || "").trim() : (lines[1] || "").trim(),
    url: anchor ? anchor.href : null,
    size: (docText.match(/\(([\d.]+[KMG]B)\)/) || [])[1] || null,
  };
}).filter((row) => row && row.url)
"""


class HkexNewsError(RuntimeError):
    """The HKEXnews search page could not be driven or parsed."""


@dataclass(slots=True)
class HkexNewsSettings:
    timeout_ms: int = 60_000
    settle_ms: int = 1_500
    rate_per_sec: float = 1.0

    @classmethod
    def from_env(cls) -> "HkexNewsSettings":
        import os

        def integer(name: str, fallback: int) -> int:
            raw = os.getenv(name)
            try:
                value = int(raw) if raw else fallback
            except ValueError:
                return fallback
            return value if value > 0 else fallback

        return cls(
            timeout_ms=integer("OCC_HKEXNEWS_TIMEOUT_MS", 60_000),
            settle_ms=integer("OCC_HKEXNEWS_SETTLE_MS", 1_500),
            rate_per_sec=float(os.getenv("OCC_HKEXNEWS_RATE_PER_SEC", "1.0"))
            or 1.0,
        )


class HkexNewsScraper:
    """One Playwright page per stock-code search; shared browser, serialized."""

    def __init__(
        self,
        browser_manager: BrowserManager,
        settings: HkexNewsSettings | None = None,
    ) -> None:
        self.browser_manager = browser_manager
        self.settings = settings or HkexNewsSettings.from_env()
        self.limiter = DomainLimiter(self.settings.rate_per_sec)
        self._lock = asyncio.Lock()

    async def search(
        self,
        code: str,
        *,
        days: int = 365,
        max_items: int = 30,
        timeout_ms: int | None = None,
    ) -> dict:
        normalized = re.sub(r"\D", "", code).zfill(5)
        days = max(1, min(int(days), 3650))
        max_items = max(1, min(int(max_items), 200))
        timeout = timeout_ms or self.settings.timeout_ms
        async with self._lock:
            await self.limiter.acquire(SEARCH_URL)
            return await self._search(
                normalized,
                days=days,
                max_items=max_items,
                timeout=timeout,
            )

    async def _search(
        self,
        code: str,
        *,
        days: int,
        max_items: int,
        timeout: int,
    ) -> dict:
        today = datetime.now(HK_TZ).date()
        from_date = today - timedelta(days=days)
        payload = {
            "code": code,
            "name": None,
            "from_date": from_date.isoformat(),
            "to_date": today.isoformat(),
            "total_records": 0,
            "returned": 0,
            "truncated": False,
            "items": [],
            "errors": [],
        }
        browser = await self.browser_manager.get()
        context = await browser.new_context(locale="en-US")
        page = await context.new_page()
        try:
            stock = await self._resolve_stock(page, code)
            if not stock:
                payload["errors"].append(f"stock code {code} not found on HKEXnews")
                return payload
            payload["name"] = stock.get("name")
            payload["stock_id"] = stock.get("stockId")

            await page.goto(SEARCH_URL, wait_until="domcontentloaded", timeout=timeout)
            await page.wait_for_selector("#searchStockCode", timeout=timeout)
            try:
                await page.evaluate(
                    SUBMIT_JS,
                    {
                        "stockId": stock["stockId"],
                        "fromDate": from_date.strftime("%Y%m%d"),
                        "toDate": today.strftime("%Y%m%d"),
                    },
                )
            except Exception as exc:  # noqa: BLE001 - navigation can destroy the context
                message = str(exc)
                if (
                    "Execution context was destroyed" not in message
                    and "navigation" not in message.lower()
                ):
                    raise HkexNewsError(
                        f"HKEXnews search form submit failed: {message}"
                    ) from exc
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=timeout)
            except PlaywrightTimeoutError:
                pass
            # The header row is always present; wait for the result summary
            # instead, so an unsubmitted form is not mistaken for "0 results".
            try:
                await page.wait_for_function(
                    "() => /Total records found|No matching|No record|No result/i"
                    ".test(document.body.innerText)",
                    timeout=15_000,
                )
            except PlaywrightTimeoutError:
                pass
            await page.wait_for_timeout(self.settings.settle_ms)

            body = await page.inner_text("body")
            total = _total_records(body)
            rows = await page.evaluate(ROWS_JS)
            items = rows[:max_items]
            payload["total_records"] = total if total is not None else len(rows)
            payload["returned"] = len(items)
            payload["truncated"] = len(rows) > len(items) or (
                total is not None and total > len(rows)
            )
            payload["items"] = items
            if not rows and total and total > 0:
                payload["errors"].append(
                    "HKEXnews reported records but the result table was empty"
                )
            elif total is None and not rows:
                payload["errors"].append(
                    "HKEXnews result table not found; the page layout may have changed"
                )
            return payload
        except PlaywrightTimeoutError as exc:
            raise HkexNewsError(f"HKEXnews search timed out for {code}: {exc}") from exc
        finally:
            await context.close()

    async def _resolve_stock(self, page: Page, code: str) -> dict | None:
        response = await page.request.get(
            PREFIX_URL,
            params={
                "callback": "callback",
                "lang": "EN",
                "type": "A",
                "name": code,
                "market": "SEHK",
            },
            headers={"referer": SEARCH_URL},
        )
        if not response.ok:
            raise HkexNewsError(f"HKEXnews prefix HTTP {response.status}")
        text = await response.text()
        match = re.search(r"\((\{.*\})\)\s*;?\s*$", text, re.S)
        if not match:
            return None
        data = json.loads(match.group(1))
        for entry in data.get("stockInfo", []):
            if str(entry.get("code", "")).strip() == code:
                return {
                    "stockId": entry.get("stockId"),
                    "code": entry.get("code"),
                    "name": entry.get("name"),
                }
        return None


def _total_records(body: str) -> int | None:
    match = re.search(r"Total records found:\s*([\d,]+)", body)
    if not match:
        return None
    try:
        return int(match.group(1).replace(",", ""))
    except ValueError:
        return None
