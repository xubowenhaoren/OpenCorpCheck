"""Structured Eastmoney F10 scraper.

This is the sidecar replacement for ``scripts/aif10_scraper.py`` in the private
``finance_analyst`` repository (Apache-2.0). It keeps the same navigation trick
(open the SPA URL, scroll to trigger lazy loading) and fixes its production
limits:

* no 8k-character truncation (2 MB text safety cap instead);
* structured ``<table>`` extraction instead of flattened ``innerText``;
* JSON capture for XHR/fetch responses, so financial statements can be read
  from the data layer directly when available;
* JSON output with HTTP status, warnings, timings and content hashes;
* retries with jitter, per-domain pacing and bounded Playwright concurrency;
* no silent 1-hour disk cache in production (an in-process TTL cache is opt-in
  via ``F10_CACHE_TTL_SECONDS``).

Eastmoney data is proprietary: use it for internal research with attribution,
and never redistribute bulk snapshots.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import os
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from playwright.async_api import (
    Browser,
    Playwright,
    Response,
    TimeoutError as PlaywrightTimeoutError,
    async_playwright,
)

from . import presets
from .limiter import DomainLimiter

logger = logging.getLogger(__name__)

MAX_TEXT_CHARS = 2_000_000
MAX_HTML_CHARS = 4_000_000
MAX_TABLES = 200
MAX_TABLE_ROWS = 2_000
MAX_CELL_CHARS = 4_000
MAX_XHR = 25
MAX_XHR_BYTES = 256 * 1024
MAX_XHR_TOTAL_BYTES = 2 * 1024 * 1024
RETRY_STATUSES = {429, 500, 502, 503, 504}
# The SPA shell renders menus (~300 chars) before any data arrives. Below this
# threshold with no tables, we treat the render as failed and retry.
MIN_RENDER_CHARS = 400
RENDER_POLL_MS = 250
DEFAULT_UA_PLATFORM = "Macintosh; Intel Mac OS X 10_15_7"

TABLE_JS = r"""
() => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const tables = Array.from(document.querySelectorAll("table"));
  return tables.map((t) => {
    const caption = clean(t.caption ? t.caption.innerText : "");
    const headRow = (t.tHead && t.tHead.rows && t.tHead.rows[0])
      || Array.from(t.rows).find((r) => r.querySelector("th"))
      || t.rows[0];
    const headers = headRow
      ? Array.from(headRow.querySelectorAll("th,td")).map((c) => clean(c.innerText))
      : [];
    const bodyRows = t.tBodies && t.tBodies.length
      ? Array.from(t.tBodies).flatMap((b) => Array.from(b.rows))
      : Array.from(t.rows).filter((r) => r !== headRow);
    const rows = bodyRows.map((r) =>
      Array.from(r.querySelectorAll("th,td")).map((c) => clean(c.innerText))
    );
    return { caption, headers, rows };
  });
}
"""

SCROLL_JS = r"""
async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.scrollTo(0, 0);
  await sleep(250);
  let previous = -1;
  for (let i = 0; i < 12; i++) {
    const height = document.body ? document.body.scrollHeight : 0;
    window.scrollBy(0, Math.max(window.innerHeight * 0.8, 400));
    await sleep(320);
    if (height === previous && i > 2) break;
    previous = height;
  }
  if (document.body) window.scrollTo(0, document.body.scrollHeight);
  await sleep(400);
}
"""


class RetryableStatus(RuntimeError):
    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status


class EmptyRender(RuntimeError):
    """The SPA mounted but the data components never rendered."""


@dataclass(slots=True)
class Settings:
    headless: bool = True
    max_concurrency: int = 2
    rate_per_sec: float = 5.0
    timeout_ms: int = 30_000
    settle_ms: int = 1_200
    retries: int = 2
    cache_ttl_seconds: float = 0.0
    snapshot_dir: Path | None = None
    user_agent: str | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        def _bool(name: str, default: bool) -> bool:
            raw = os.getenv(name)
            if raw is None:
                return default
            return raw.strip().lower() not in {"0", "false", "no", "off"}

        def _number(name: str, default: float, cast=float):
            raw = os.getenv(name)
            if raw is None or not raw.strip():
                return default
            try:
                return cast(raw)
            except ValueError:
                logger.warning("ignoring invalid %s=%r", name, raw)
                return default

        snapshot = os.getenv("F10_SNAPSHOT_DIR")
        return cls(
            headless=_bool("F10_HEADLESS", True),
            max_concurrency=max(1, _number("F10_MAX_CONCURRENCY", 2, int)),
            rate_per_sec=max(0.1, _number("F10_RATE_PER_SEC", 5.0)),
            timeout_ms=max(5_000, _number("F10_TIMEOUT_MS", 30_000, int)),
            settle_ms=max(0, _number("F10_SETTLE_MS", 1_200, int)),
            retries=max(0, _number("F10_RETRIES", 2, int)),
            cache_ttl_seconds=max(0.0, _number("F10_CACHE_TTL_SECONDS", 0.0)),
            snapshot_dir=Path(snapshot).expanduser() if snapshot else None,
            user_agent=os.getenv("F10_USER_AGENT") or None,
        )

    def public(self) -> dict[str, Any]:
        return {
            "headless": self.headless,
            "max_concurrency": self.max_concurrency,
            "rate_per_sec": self.rate_per_sec,
            "timeout_ms": self.timeout_ms,
            "settle_ms": self.settle_ms,
            "retries": self.retries,
            "cache_ttl_seconds": self.cache_ttl_seconds,
            "snapshot_dir": str(self.snapshot_dir) if self.snapshot_dir else None,
        }


class BrowserManager:
    """Lazily launch one Chromium for the whole process."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._lock = asyncio.Lock()
        self._closed = False

    @property
    def state(self) -> str:
        if self._closed:
            return "closed"
        if self._browser is not None and self._browser.is_connected():
            return "ready"
        return "starting"

    async def get(self) -> Browser:
        if self._closed:
            raise RuntimeError("browser manager is closed")
        if self._browser is not None and self._browser.is_connected():
            return self._browser
        async with self._lock:
            if self._browser is not None and self._browser.is_connected():
                return self._browser
            if self._playwright is None:
                self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(
                headless=self.settings.headless
            )
            logger.info("chromium launched: %s", self._browser.version)
            return self._browser

    async def close(self) -> None:
        self._closed = True
        async with self._lock:
            if self._browser is not None:
                try:
                    await self._browser.close()
                finally:
                    self._browser = None
            if self._playwright is not None:
                try:
                    await self._playwright.stop()
                finally:
                    self._playwright = None


@dataclass(slots=True)
class _PagePayload:
    text: str = ""
    truncated: bool = False
    tables: list[dict[str, Any]] = field(default_factory=list)
    html_sha256: str | None = None
    storage_key: str | None = None
    final_url: str | None = None
    http_status: int | None = None
    xhr: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class F10Scraper:
    def __init__(
        self,
        settings: Settings | None = None,
        browser_manager: BrowserManager | None = None,
    ) -> None:
        self.settings = settings or Settings.from_env()
        self.browser_manager = browser_manager or BrowserManager(self.settings)
        self.limiter = DomainLimiter(self.settings.rate_per_sec)
        self._page_sem = asyncio.Semaphore(self.settings.max_concurrency)
        self._cache: dict[tuple[str, str, str], tuple[float, dict[str, Any]]] = {}
        self._cache_lock = asyncio.Lock()

    async def close(self) -> None:
        await self.browser_manager.close()

    async def scrape(
        self,
        market: str,
        code: str,
        pages: list[str],
        *,
        force: bool = False,
        capture_xhr: bool = True,
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        """Scrape the requested pages and return a JSON-serializable result."""
        if not pages:
            raise ValueError("at least one page is required")
        normalized = presets.normalize_code(market, code)
        timeout = timeout_ms or self.settings.timeout_ms
        started = time.monotonic()

        unique_pages = list(dict.fromkeys(pages))

        async def run(page_hash: str) -> dict[str, Any]:
            async with self._page_sem:
                return await self._scrape_page(
                    market,
                    code,
                    normalized,
                    page_hash,
                    capture_xhr=capture_xhr,
                    timeout_ms=timeout,
                    force=force,
                )

        raw_results = await asyncio.gather(
            *(run(page) for page in unique_pages), return_exceptions=True
        )

        results: list[dict[str, Any]] = []
        errors: list[str] = []
        for page_hash, raw in zip(unique_pages, raw_results):
            if isinstance(raw, BaseException):
                label = _safe_label(market, page_hash)
                errors.append(f"{label} ({page_hash}): {raw}")
                results.append(_error_page(market, code, page_hash, label, str(raw)))
            else:
                if raw.get("error"):
                    errors.append(f"{raw['label']} ({page_hash}): {raw['error']}")
                results.append(raw)

        pages_ok = sum(1 for result in results if not result.get("error"))
        return {
            "meta": {
                "market": market,
                "code": code,
                "normalized_code": normalized,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "elapsed_ms": int((time.monotonic() - started) * 1000),
                "pages_requested": len(unique_pages),
                "pages_ok": pages_ok,
                "concurrency": self.settings.max_concurrency,
                "rate_per_sec": self.settings.rate_per_sec,
            },
            "pages": results,
            "errors": errors,
        }

    async def _scrape_page(
        self,
        market: str,
        code: str,
        normalized: str,
        page_hash: str,
        *,
        capture_xhr: bool,
        timeout_ms: int,
        force: bool,
    ) -> dict[str, Any]:
        label = _safe_label(market, page_hash)
        url = presets.build_url(market, code, page_hash)
        started = time.monotonic()

        cache_key = (market, normalized, page_hash)
        if self.settings.cache_ttl_seconds > 0 and not force:
            cached = await self._cache_get(cache_key)
            if cached is not None:
                logger.info("cache hit %s", cache_key)
                return copy.deepcopy(cached)

        last_error: str | None = None
        attempts = 0
        for attempt in range(1, self.settings.retries + 2):
            attempts = attempt
            try:
                payload = await self._fetch_page(
                    market=market,
                    code=code,
                    normalized=normalized,
                    page_hash=page_hash,
                    url=url,
                    capture_xhr=capture_xhr,
                    timeout_ms=timeout_ms,
                )
            except RetryableStatus as exc:
                last_error = str(exc)
                if attempt <= self.settings.retries:
                    self.limiter.cooldown(url, 2.0 * attempt)
                    await asyncio.sleep(_backoff(attempt))
                    continue
            except Exception as exc:  # noqa: BLE001 - one page must not kill the batch
                last_error = f"{type(exc).__name__}: {exc}"
                logger.warning("page failed (%s %s %s): %s", market, code, page_hash, exc)
                if attempt <= self.settings.retries:
                    await asyncio.sleep(_backoff(attempt))
                    continue
            else:
                result = {
                    "label": label,
                    "page": page_hash,
                    "url": url,
                    "final_url": payload.final_url,
                    "http_status": payload.http_status,
                    "text": payload.text,
                    "text_chars": len(payload.text),
                    "truncated": payload.truncated,
                    "tables": payload.tables,
                    "table_count": len(payload.tables),
                    "html_sha256": payload.html_sha256,
                    "storage_key": payload.storage_key,
                    "xhr": payload.xhr if capture_xhr else None,
                    "warnings": payload.warnings,
                    "attempts": attempts,
                    "elapsed_ms": int((time.monotonic() - started) * 1000),
                    "error": None,
                }
                if self.settings.cache_ttl_seconds > 0:
                    await self._cache_put(cache_key, result)
                return result

        return {
            **_error_page(market, code, page_hash, label, last_error or "unknown error"),
            "url": url,
            "attempts": attempts,
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }

    async def _fetch_page(
        self,
        *,
        market: str,
        code: str,
        normalized: str,
        page_hash: str,
        url: str,
        capture_xhr: bool,
        timeout_ms: int,
    ) -> _PagePayload:
        browser = await self.browser_manager.get()
        await self.limiter.acquire(url)

        context = await browser.new_context(
            viewport={"width": 1440, "height": 1000},
            screen={"width": 1440, "height": 1000},
            user_agent=self.settings.user_agent or _user_agent(browser),
            locale="en-US" if market == "US" else "zh-CN",
            timezone_id="Asia/Shanghai" if market != "US" else "America/New_York",
        )
        responses: list[Response] = []
        try:
            page = await context.new_page()
            context.set_default_timeout(timeout_ms)
            if capture_xhr:
                page.on("response", _collect_json_response(responses))

            response = await page.goto(url, wait_until="load", timeout=timeout_ms)
            status = response.status if response is not None else None
            if status in RETRY_STATUSES:
                raise RetryableStatus(status)

            render_warning = await self._wait_for_render(page, timeout_ms)
            if self.settings.settle_ms:
                await page.wait_for_timeout(self.settings.settle_ms)
            await page.evaluate(SCROLL_JS)

            text = await page.evaluate(
                "() => (document.body ? document.body.innerText : '')"
            )
            payload = _PagePayload(
                text=text or "",
                final_url=page.url,
                http_status=status,
            )
            if render_warning:
                payload.warnings.append(render_warning)
            if len(payload.text) > MAX_TEXT_CHARS:
                payload.text = payload.text[:MAX_TEXT_CHARS]
                payload.truncated = True
                payload.warnings.append(
                    f"text truncated at {MAX_TEXT_CHARS} chars (original {len(text)})"
                )

            raw_tables = await page.evaluate(TABLE_JS)
            payload.tables = _normalize_tables(raw_tables)
            if not _looks_rendered(payload.text, payload.tables):
                raise EmptyRender(
                    f"SPA rendered only {len(payload.text.strip())} chars "
                    f"and {len(payload.tables)} layout tables"
                )

            html = await page.content()
            if len(html) > MAX_HTML_CHARS:
                payload.warnings.append(
                    f"html truncated at {MAX_HTML_CHARS} chars for hashing/snapshot"
                )
                html = html[:MAX_HTML_CHARS]
            digest = hashlib.sha256(html.encode("utf-8")).hexdigest()
            payload.html_sha256 = digest
            payload.storage_key = (
                f"f10/{market}/{normalized}/{page_hash}/{digest}.html"
            )
            await self._maybe_snapshot(
                payload.storage_key, html, payload.text
            )

            if capture_xhr:
                payload.xhr = await self._collect_xhr(responses)
            return payload
        finally:
            await context.close()

    async def _wait_for_render(self, page, timeout_ms: int) -> str | None:
        """Wait until the data components have mounted.

        The F10 shell paints the menu immediately; financial sections arrive
        from the API afterwards. Waiting for the load event alone is not
        enough on slow days, and a fixed sleep either wastes time or races.
        Returns a warning string when the wait timed out.
        """
        budget = min(timeout_ms, 12_000)
        try:
            await page.wait_for_function(
                """() => {
                    const body = document.body;
                    if (!body) return false;
                    const text = (body.innerText || "").trim();
                    return text.length > 800
                        || document.querySelectorAll("table tr").length > 30;
                }""",
                timeout=budget,
                polling=RENDER_POLL_MS,
            )
            return None
        except PlaywrightTimeoutError:
            return f"render wait timed out after {budget}ms"

    async def _collect_xhr(self, responses: list[Response]) -> list[dict[str, Any]]:
        captured: list[dict[str, Any]] = []
        total = 0
        for response in responses[:MAX_XHR]:
            try:
                content_type = response.headers.get("content-type", "")
            except Exception:  # noqa: BLE001 - disposed response
                continue
            try:
                body = await response.body()
            except Exception:  # noqa: BLE001 - redirects and evicted bodies
                continue
            truncated = len(body) > MAX_XHR_BYTES
            text = body[:MAX_XHR_BYTES].decode("utf-8", errors="replace")
            parsed: Any = None
            if not truncated:
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError:
                    parsed = None
            # Eastmoney serves its data API as text/plain; only keep those when
            # the body really is JSON (truncated bodies are kept as text).
            if parsed is None and "json" not in content_type.lower() and not truncated:
                continue
            total += len(body)
            if total > MAX_XHR_TOTAL_BYTES:
                captured.append(
                    {
                        "url": response.url,
                        "status": response.status,
                        "content_type": content_type,
                        "json": None,
                        "text": None,
                        "truncated": True,
                    }
                )
                break
            captured.append(
                {
                    "url": response.url,
                    "status": response.status,
                    "content_type": content_type,
                    "json": parsed,
                    "text": None if parsed is not None else text,
                    "truncated": truncated,
                }
            )
        return captured

    async def _maybe_snapshot(self, key: str, html: str, text: str) -> None:
        if self.settings.snapshot_dir is None:
            return
        html_path = self.settings.snapshot_dir / key
        text_path = html_path.with_suffix(".txt")
        try:
            await asyncio.to_thread(_write_snapshot, html_path, html, text_path, text)
        except OSError as exc:
            logger.warning("snapshot write failed for %s: %s", key, exc)

    async def _cache_get(self, key: tuple[str, str, str]) -> dict[str, Any] | None:
        async with self._cache_lock:
            hit = self._cache.get(key)
            if hit is None:
                return None
            if time.monotonic() - hit[0] > self.settings.cache_ttl_seconds:
                self._cache.pop(key, None)
                return None
            return hit[1]

    async def _cache_put(self, key: tuple[str, str, str], result: dict[str, Any]) -> None:
        async with self._cache_lock:
            self._cache[key] = (time.monotonic(), copy.deepcopy(result))


def _looks_rendered(text: str, tables: list[dict[str, Any]]) -> bool:
    """Distinguish a real F10 render from the SPA shell.

    The shell carries menus (~285 chars) and a few single-row layout tables.
    A data page has either substantial text or a table with several body rows.
    """
    if len(text.strip()) >= MIN_RENDER_CHARS:
        return True
    return any(len(table.get("rows") or []) >= 3 for table in tables)


def _backoff(attempt: int) -> float:
    return min(8.0, 0.5 * (2 ** (attempt - 1))) + random.uniform(0, 0.3)


def _user_agent(browser: Browser) -> str:
    try:
        version = browser.version.split()[0]
    except Exception:  # noqa: BLE001
        version = "131.0.0.0"
    return (
        f"Mozilla/5.0 ({DEFAULT_UA_PLATFORM}) AppleWebKit/537.36 "
        f"(KHTML, like Gecko) Chrome/{version} Safari/537.36"
    )


def _collect_json_response(responses: list[Response]):
    def handler(response: Response) -> None:
        try:
            content_type = response.headers.get("content-type", "").lower()
        except Exception:  # noqa: BLE001
            return
        host = urlparse(response.url).netloc
        if host and not host.endswith("eastmoney.com"):
            return
        if "json" in content_type:
            responses.append(response)
            return
        # The data API answers with text/plain even though the body is JSON.
        path = urlparse(response.url).path
        if (
            path.endswith(".json")
            or "/api/" in path
            or "reportName=" in response.url
        ):
            responses.append(response)

    return handler


def _normalize_tables(raw_tables: Any) -> list[dict[str, Any]]:
    tables: list[dict[str, Any]] = []
    if not isinstance(raw_tables, list):
        return tables
    for raw in raw_tables:
        if len(tables) >= MAX_TABLES:
            break
        if not isinstance(raw, dict):
            continue
        caption = str(raw.get("caption") or "")[:MAX_CELL_CHARS]
        headers = [
            str(cell)[:MAX_CELL_CHARS]
            for cell in (raw.get("headers") or [])
        ]
        rows: list[list[str]] = []
        for row in (raw.get("rows") or [])[:MAX_TABLE_ROWS]:
            if not isinstance(row, list):
                continue
            cells = [str(cell)[:MAX_CELL_CHARS] for cell in row]
            if any(cell for cell in cells):
                rows.append(cells)
        if not rows and not headers:
            continue
        if len(rows) == 1 and len(rows[0]) == 1 and not headers:
            # Layout tables in the F10 shell carry a single label cell.
            continue
        tables.append({"caption": caption, "headers": headers, "rows": rows})
    return tables


def _safe_label(market: str, page_hash: str) -> str:
    try:
        return presets.page_label(market, page_hash)
    except presets.UnknownPage:
        return page_hash


def _error_page(
    market: str, code: str, page_hash: str, label: str, error: str
) -> dict[str, Any]:
    return {
        "label": label,
        "page": page_hash,
        "url": presets.build_url(market, code, page_hash),
        "final_url": None,
        "http_status": None,
        "text": "",
        "text_chars": 0,
        "truncated": False,
        "tables": [],
        "table_count": 0,
        "html_sha256": None,
        "storage_key": None,
        "xhr": None,
        "warnings": [],
        "attempts": 0,
        "elapsed_ms": 0,
        "error": error,
    }


def _write_snapshot(html_path: Path, html: str, text_path: Path, text: str) -> None:
    html_path.parent.mkdir(parents=True, exist_ok=True)
    html_path.write_text(html, encoding="utf-8")
    text_path.write_text(text, encoding="utf-8")
