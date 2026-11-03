"""FastAPI surface for the finance sidecar.

Internal service: it is called by the TypeScript sources/worker containers, not
by browsers. Keep it on the private network.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException

from . import __version__, presets
from .dion import DionScraper
from .f10 import F10Scraper, Settings
from .hkexnews import HkexNewsError, HkexNewsScraper
from .models import (
    DionRequest,
    DionResponse,
    HealthResponse,
    HkexNewsRequest,
    HkexNewsResponse,
    PagesResponse,
    PdfExtractRequest,
    PdfExtractResponse,
    ScrapeRequest,
    ScrapeResponse,
)
from .pdf import PdfError, extract_pdf

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(__name__)

settings = Settings.from_env()
scraper = F10Scraper(settings)
dion_scraper = DionScraper(scraper.browser_manager)
hkex_news_scraper = HkexNewsScraper(scraper.browser_manager)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    logger.info("finance-analyst starting: %s", settings.public())
    try:
        yield
    finally:
        await scraper.close()
        logger.info("finance-analyst stopped")


app = FastAPI(
    title="OpenCorpCheck finance-analyst sidecar",
    version=__version__,
    description=(
        "Structured Eastmoney F10 scraping for A/HK/US equities. "
        "Internal use only; Eastmoney data is proprietary."
    ),
    lifespan=lifespan,
)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        browser=scraper.browser_manager.state,  # type: ignore[arg-type]
        version=__version__,
        settings=settings.public(),
    )


@app.get("/v1/f10/pages/{market}", response_model=PagesResponse)
async def list_pages(market: str) -> PagesResponse:
    market = market.upper()
    if market not in presets.PAGES:
        raise HTTPException(status_code=422, detail=f"unknown market {market!r}; use A, HK or US")
    return PagesResponse(
        market=market,  # type: ignore[arg-type]
        pages=presets.PAGES[market],
        presets=presets.PRESETS[market],
    )


@app.post("/v1/f10/scrape", response_model=ScrapeResponse)
async def scrape(request: ScrapeRequest) -> ScrapeResponse:
    try:
        resolved = presets.resolve_pages(request.market, request.pages, request.preset)
    except (presets.UnknownMarket, presets.UnknownPage) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    result = await scraper.scrape(
        market=request.market,
        code=request.code,
        pages=resolved,
        force=request.force,
        capture_xhr=request.capture_xhr,
        timeout_ms=request.timeout_ms,
    )
    return ScrapeResponse(**result)


@app.post("/v1/dion/notices", response_model=DionResponse)
async def dion_notices(request: DionRequest) -> DionResponse:
    """Substantial-shareholder notices for one HKEX stock code."""
    result = await dion_scraper.notices(
        request.code,
        days=request.days,
        max_pages=request.max_pages,
    )
    return DionResponse(**result)


@app.post("/v1/hkexnews/search", response_model=HkexNewsResponse)
async def hkexnews_search(request: HkexNewsRequest) -> HkexNewsResponse:
    """Listed-company announcement titles + PDF links for one HKEX code."""
    try:
        result = await hkex_news_scraper.search(
            request.code,
            days=request.days,
            max_items=request.max_items,
        )
    except HkexNewsError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return HkexNewsResponse(**result)


@app.post("/v1/pdf/extract", response_model=PdfExtractResponse)
async def pdf_extract(request: PdfExtractRequest) -> PdfExtractResponse:
    """Extract page text and tables from an official filing PDF."""
    try:
        data = base64.b64decode(request.base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"invalid base64: {exc}") from exc
    if len(data) > 30 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="PDF exceeds the 30 MB cap")
    try:
        result = await asyncio.to_thread(
            extract_pdf,
            data,
            max_pages=request.max_pages,
        )
    except PdfError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return PdfExtractResponse(**result)
