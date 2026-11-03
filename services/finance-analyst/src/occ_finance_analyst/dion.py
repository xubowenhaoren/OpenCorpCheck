"""HKEX Disclosure of Interests (DION) substantial-shareholder scraper.

The public DI site is behind a JavaScript bot-defense layer, so a plain HTTP
client gets a "temporarily unavailable" page. We use the same Playwright
browser as the F10 adapter, pace requests at one per second, and return the
notice table as JSON. Only the long-position (`(L)`) values are interpreted by
the TypeScript ownership planner; nothing is written here.

The flow is the site's ordinary search form:
  1. GET the search page for a stock code,
  2. set the date range and submit,
  3. follow "List of notices filed by substantial shareholders",
  4. read the rows (and paginate with `pg=N`).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any
from urllib.parse import urljoin

from playwright.async_api import Page, TimeoutError as PlaywrightTimeoutError

from .f10 import BrowserManager
from .limiter import DomainLimiter

logger = logging.getLogger(__name__)

BASE_URL = "https://di.hkex.com.hk/di"
SEARCH_URL = f"{BASE_URL}/NSSrchCorpQW.aspx"
SERIAL_RE = re.compile(r"^[A-Z]{2}\d{8}[A-Z]\d{5}")

REASON_MAP = {
    "1201": "Sold (L)",
    "1202": "Sold (S)",
    "1101": "Bought (L)",
    "1102": "Bought (S)",
    "1113": "Acquired (L)",
    "1213": "Disposed (L)",
    "1301": "Lending (L)",
    "1402": "Returned (S)",
    "1703": "Exercised options",
    "1704": "Grant of options",
    "1705": "Lapsed options",
    "1706": "Transfer out",
}

ROW_JS = r"""
() => Array.from(document.querySelectorAll("tr"))
  .map((tr) => {
    const tds = Array.from(tr.querySelectorAll("td"));
    if (tds.length !== 8) return null;
    const cells = tds.map((td) => (td.innerText || "").trim());
    const a = tr.querySelector("a");
    return { cells, href: a ? a.getAttribute("href") : null };
  })
  .filter(Boolean)
"""

LINK_JS = r"""
() => {
  const a = Array.from(document.querySelectorAll("a"))
    .find((el) => (el.getAttribute("href") || "").includes("NSNoticeSSList"));
  return a ? a.getAttribute("href") : null;
}
"""


class DionError(RuntimeError):
    """The DI page could not be searched or parsed."""


@dataclass(slots=True)
class DionSettings:
    timeout_ms: int = 60_000
    settle_ms: int = 1_500
    max_pages: int = 10
    rate_per_sec: float = 1.0

    @classmethod
    def from_env(cls) -> "DionSettings":
        def number(name: str, default: float, cast=float):
            raw = os.getenv(name)
            if raw is None or not raw.strip():
                return default
            try:
                return cast(raw)
            except ValueError:
                logger.warning("ignoring invalid %s=%r", name, raw)
                return default

        return cls(
            timeout_ms=max(10_000, number("OCC_DION_TIMEOUT_MS", 60_000, int)),
            settle_ms=max(0, number("OCC_DION_SETTLE_MS", 1_500, int)),
            max_pages=max(1, min(20, number("OCC_DION_MAX_PAGES", 10, int))),
            rate_per_sec=max(0.1, number("OCC_DION_RATE_PER_SEC", 1.0)),
        )


class DionScraper:
    def __init__(
        self,
        browser_manager: BrowserManager,
        settings: DionSettings | None = None,
    ) -> None:
        self.browser_manager = browser_manager
        self.settings = settings or DionSettings.from_env()
        self.limiter = DomainLimiter(self.settings.rate_per_sec)
        # One browser context at a time; the CLI is sequential anyway.
        self._sem = asyncio.Semaphore(1)

    async def notices(
        self,
        code: str,
        *,
        days: int = 365,
        max_pages: int | None = None,
    ) -> dict[str, Any]:
        normalized = normalize_code(code)
        end = date.today()
        start = end - timedelta(days=max(days, 1))
        if start.year < 2003:
            start = date(2003, 1, 1)
        limit = max(1, min(max_pages or self.settings.max_pages, 20))
        response: dict[str, Any] = {
            "code": normalized,
            "name": None,
            "from_date": start.isoformat(),
            "to_date": end.isoformat(),
            "total_records": 0,
            "pages": 0,
            "truncated": False,
            "notices": [],
            "errors": [],
        }
        async with self._sem:
            browser = await self.browser_manager.get()
            context = await browser.new_context(locale="en-US")
            page = await context.new_page()
            try:
                await self._scrape(page, normalized, start, end, limit, response)
            except Exception as exc:  # noqa: BLE001 - returned to the caller
                logger.warning("DION scrape %s failed: %s", normalized, exc)
                response["errors"].append(f"{type(exc).__name__}: {exc}")
            finally:
                await context.close()
        return response

    async def _scrape(
        self,
        page: Page,
        code: str,
        start: date,
        end: date,
        max_pages: int,
        response: dict[str, Any],
    ) -> None:
        search_url = f"{SEARCH_URL}?src=MAIN&lang=EN&in=1&sc={code}"
        await self.limiter.acquire(search_url)
        await page.goto(
            search_url,
            wait_until="domcontentloaded",
            timeout=self.settings.timeout_ms,
        )
        await page.wait_for_timeout(self.settings.settle_ms)
        await page.fill('input[name="txtStockCode"]', code)
        await self._set_date_range(page, start, end)
        await page.click('input[name="cmdSearch"]')
        try:
            await page.wait_for_selector(
                'a[href*="NSNoticeSSList"]',
                timeout=self.settings.timeout_ms,
            )
        except PlaywrightTimeoutError as exc:
            body = await page.inner_text("body")
            if "temporarily unavailable" in body.lower():
                raise DionError(
                    "HKEX DION returned 'temporarily unavailable'; retry later"
                ) from exc
            raise DionError("no substantial-shareholder notice link found") from exc

        href = await page.evaluate(LINK_JS)
        if not href:
            raise DionError("no substantial-shareholder notice link found")
        base = href if str(href).startswith("http") else urljoin(f"{BASE_URL}/", str(href))

        notices: list[dict[str, Any]] = []
        seen: set[str] = set()
        total_records = 0
        pages = 0
        for page_number in range(1, max_pages + 1):
            page_url = base if page_number == 1 else append_page(base, page_number)
            await self.limiter.acquire(page_url)
            await page.goto(
                page_url,
                wait_until="domcontentloaded",
                timeout=self.settings.timeout_ms,
            )
            await page.wait_for_timeout(self.settings.settle_ms)
            body = await page.inner_text("body")
            if "temporarily unavailable" in body.lower():
                raise DionError(
                    "HKEX DION returned 'temporarily unavailable'; retry later"
                )
            if page_number == 1:
                response["name"] = parse_corporation_name(body)
                total_records = parse_total_records(body)
                response["total_records"] = total_records
            rows = await page.evaluate(ROW_JS)
            page_notices = []
            for row in rows or []:
                notice = row_to_notice(row)
                if not notice or notice["serial"] in seen:
                    continue
                seen.add(notice["serial"])
                page_notices.append(notice)
            notices.extend(page_notices)
            pages = page_number
            if not page_notices:
                break
            if total_records > 0 and len(notices) >= total_records:
                break

        response["notices"] = notices
        response["pages"] = pages
        response["truncated"] = total_records > len(notices)
        if total_records > 0 and not notices:
            response["errors"].append(
                "the DION result table reported records but no rows matched the "
                "expected 8-column shape; the site may have changed"
            )

    async def _set_date_range(self, page: Page, start: date, end: date) -> None:
        values = {
            "ddlStartDateYYYY": str(start.year),
            "ddlStartDateMM": f"{start.month:02d}",
            "ddlStartDateDD": f"{start.day:02d}",
            "ddlEndDateYYYY": str(end.year),
            "ddlEndDateMM": f"{end.month:02d}",
            "ddlEndDateDD": f"{end.day:02d}",
        }
        for name, value in values.items():
            try:
                await page.select_option(f'select[name="{name}"]', value)
            except Exception:  # noqa: BLE001 - keep the site default
                logger.debug("could not set %s=%s", name, value)


def normalize_code(code: str) -> str:
    digits = re.sub(r"\D", "", code or "")
    if not digits:
        raise ValueError(f"invalid HK stock code: {code!r}")
    return digits.zfill(5)


def append_page(base: str, page_number: int) -> str:
    return f"{base.rstrip('&')}&pg={page_number}"


def parse_total_records(body: str) -> int:
    match = re.search(r"Total records:\s*([\d,]+)", body)
    if not match:
        return 0
    return int(match.group(1).replace(",", ""))


def parse_corporation_name(body: str) -> str | None:
    match = re.search(r"Name of listed corporation:\s*(.+?)(?:\r?\n|$)", body)
    if not match:
        return None
    value = match.group(1).strip()
    return value or None


def row_to_notice(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    cells = row.get("cells") or []
    if len(cells) != 8:
        return None
    serial = str(cells[0]).strip()
    shareholder = str(cells[1]).strip()
    if not SERIAL_RE.match(serial) or not shareholder:
        return None
    reason_code = str(cells[2]).strip() or None
    href = row.get("href")
    return {
        "serial": serial,
        "shareholder": shareholder,
        "reason_code": reason_code,
        "reason": reason_label(reason_code),
        "shares": empty_to_none(cells[3]),
        "avg_price": empty_to_none(cells[4]),
        "holdings": empty_to_none(cells[5]),
        "percent": empty_to_none(cells[6]),
        "event_date": iso_date(cells[7]),
        "url": urljoin(f"{BASE_URL}/", str(href)) if href else None,
    }


def reason_label(code: str | None) -> str | None:
    if not code:
        return None
    for prefix, label in REASON_MAP.items():
        if code.startswith(prefix):
            return label
    return code


def iso_date(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    match = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", text)
    if not match:
        return text
    day, month, year = match.groups()
    return f"{year}-{month.zfill(2)}-{day.zfill(2)}"


def empty_to_none(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None
