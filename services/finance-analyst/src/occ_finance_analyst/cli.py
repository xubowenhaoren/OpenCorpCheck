"""Command line entry point: ``occ-f10 scrape`` and ``occ-f10 serve``."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from . import __version__, presets
from .dion import DionScraper
from .f10 import BrowserManager, F10Scraper, Settings
from .hkexnews import HkexNewsScraper
from .pdf import extract_pdf


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="occ-f10",
        description="Structured Eastmoney F10 scraper for A/HK/US equities.",
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    scrape = sub.add_parser("scrape", help="scrape one company and print JSON")
    scrape.add_argument("code", help="600519, 00700, AAPL, BRK.B")
    scrape.add_argument("market", choices=["A", "HK", "US"], type=str.upper)
    scrape.add_argument("--pages", help="comma-separated page hashes, e.g. cwfx,gsgk")
    scrape.add_argument("--preset", help="preset name (default: default)")
    scrape.add_argument("--out", help="write JSON to this path instead of stdout")
    scrape.add_argument("--no-xhr", action="store_true", help="skip JSON XHR capture")
    scrape.add_argument("--force", action="store_true", help="bypass result cache")
    scrape.add_argument("--timeout-ms", type=int, default=None)
    scrape.add_argument("--compact", action="store_true", help="compact JSON output")

    serve = sub.add_parser("serve", help="run the HTTP sidecar")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8090)

    dion = sub.add_parser("dion", help="scrape HKEX DI substantial-shareholder notices")
    dion.add_argument("code", help="HKEX stock code, e.g. 00700")
    dion.add_argument("--days", type=int, default=365)
    dion.add_argument("--max-pages", type=int, default=10)
    dion.add_argument("--out", help="write JSON to this path instead of stdout")

    news = sub.add_parser("hkexnews", help="search HKEXnews announcements")
    news.add_argument("code", help="HKEX stock code, e.g. 00700")
    news.add_argument("--days", type=int, default=365)
    news.add_argument("--max-items", type=int, default=30)
    news.add_argument("--out", help="write JSON to this path instead of stdout")

    pdf = sub.add_parser("pdf", help="extract text/tables from a local PDF")
    pdf.add_argument("file", help="path to a PDF")
    pdf.add_argument("--max-pages", type=int, default=80)
    pdf.add_argument("--out", help="write JSON to this path instead of stdout")
    return parser


async def _run_scrape(args: argparse.Namespace) -> int:
    pages = [p.strip() for p in args.pages.split(",") if p.strip()] if args.pages else None
    try:
        resolved = presets.resolve_pages(args.market, pages, args.preset)
    except (presets.UnknownMarket, presets.UnknownPage) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    scraper = F10Scraper(Settings.from_env())
    try:
        result = await scraper.scrape(
            market=args.market,
            code=args.code,
            pages=resolved,
            force=args.force,
            capture_xhr=not args.no_xhr,
            timeout_ms=args.timeout_ms,
        )
    finally:
        await scraper.close()

    indent = None if args.compact else 2
    payload = json.dumps(result, ensure_ascii=False, indent=indent)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(payload + "\n")
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(payload)
    return 1 if result["errors"] else 0


async def _run_dion(args: argparse.Namespace) -> int:
    settings = Settings.from_env()
    manager = BrowserManager(settings)
    scraper = DionScraper(manager)
    try:
        result = await scraper.notices(
            args.code,
            days=args.days,
            max_pages=args.max_pages,
        )
    finally:
        await manager.close()
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(payload + "\n")
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(payload)
    return 1 if result.get("errors") else 0


async def _run_hkexnews(args: argparse.Namespace) -> int:
    settings = Settings.from_env()
    manager = BrowserManager(settings)
    scraper = HkexNewsScraper(manager)
    try:
        result = await scraper.search(
            args.code,
            days=args.days,
            max_items=args.max_items,
        )
    finally:
        await manager.close()
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(payload + "\n")
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(payload)
    return 1 if result.get("errors") else 0


def _run_pdf(args: argparse.Namespace) -> int:
    with open(args.file, "rb") as handle:
        data = handle.read()
    result = extract_pdf(data, max_pages=args.max_pages)
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(payload + "\n")
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(payload)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "scrape":
        return asyncio.run(_run_scrape(args))
    if args.command == "dion":
        return asyncio.run(_run_dion(args))
    if args.command == "hkexnews":
        return asyncio.run(_run_hkexnews(args))
    if args.command == "pdf":
        return _run_pdf(args)
    if args.command == "serve":
        import uvicorn

        uvicorn.run(
            "occ_finance_analyst.main:app",
            host=args.host,
            port=args.port,
            reload=False,
        )
        return 0
    parser.error(f"unknown command {args.command!r}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
