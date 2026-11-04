#!/usr/bin/env python3
"""Capture README screenshots from the real local OpenCorpCheck app.

Usage (the repo does not install Node Playwright):

    services/finance-analyst/.venv/bin/python scripts/readme-screenshots.py
    services/finance-analyst/.venv/bin/python scripts/readme-screenshots.py --with-agent
    services/finance-analyst/.venv/bin/python scripts/readme-screenshots.py --only home,financials

Requirements: the API (:8787), web (:5173) and (for A/HK pages) the F10
sidecar (:8090) are running. Output goes to docs/screenshots/readme/ as WebP,
desktop 1440x900, light theme, Chinese UI, no browser chrome.

The AI-sidebar shot is opt-in because it spends LLM tokens and needs a real
DEEPSEEK_API_KEY in the running API.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "screenshots" / "readme"
BASE = os.environ.get("OCC_WEB_URL", "http://127.0.0.1:5173").rstrip("/")
DESKTOP = {"width": 1440, "height": 900}
MOBILE = {"width": 390, "height": 844}
MAX_BYTES = 300 * 1024


def init_page(context) -> None:
    context.add_init_script(
        """
        localStorage.setItem('occ-theme', 'light');
        localStorage.setItem('occ-lang', 'zh');
        """
    )


def settle(page: Page, selector: str | None = None, ms: int = 700) -> None:
    page.add_style_tag(
        content="""
        *, *::before, *::after {
          animation-duration: 0s !important;
          transition-duration: 0s !important;
          caret-color: transparent !important;
        }
        html { scroll-behavior: auto !important; }
        ::-webkit-scrollbar { width: 0; height: 0; }
        """
    )
    page.evaluate("() => document.fonts.ready")
    page.evaluate(
        """() => Promise.all(Array.from(document.images)
          .filter((img) => !img.complete)
          .map((img) => new Promise((done) => { img.onload = img.onerror = done; })))"""
    )
    if selector:
        page.wait_for_selector(selector, state="visible", timeout=30000)
    page.wait_for_timeout(ms)
    page.evaluate("() => window.scrollTo(0, 0)")


def close_overlays(page: Page) -> None:
    collapse = page.get_by_role("button", name="收起助手")
    if collapse.count() and collapse.first.is_visible():
        collapse.first.click()
        page.wait_for_timeout(250)
    # The dock is a popover; a second click on its trigger closes it.
    card = page.locator("#occ-task-dock")
    if card.count() and card.first.is_visible():
        page.locator(".dock-btn").click()
        page.wait_for_timeout(250)


def save(page: Page, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    png = OUT / f"{name}.png"
    webp = OUT / f"{name}.webp"
    page.screenshot(path=png, full_page=False)
    image = Image.open(png).convert("RGB")
    for quality in (86, 82, 78, 74, 70, 66):
        image.save(webp, "WEBP", quality=quality, method=6)
        if webp.stat().st_size <= MAX_BYTES:
            break
    png.unlink()
    print(f"  {name}.webp  {image.width}x{image.height}  {webp.stat().st_size // 1024} KB")


def open_company(page: Page, ref: str = "00700") -> None:
    page.goto(f"{BASE}/c/{ref}", wait_until="networkidle", timeout=60000)
    page.wait_for_selector("h1", timeout=30000)
    page.wait_for_timeout(400)


def capture_desktop(page: Page, only: set[str]) -> None:
    def want(name: str) -> bool:
        return not only or name in only

    if want("home"):
        print("home")
        # Seed a real "最近查看" entry before the hero shot.
        open_company(page, "00700")
        page.goto(f"{BASE}/", wait_until="networkidle", timeout=60000)
        settle(page, "h1")
        close_overlays(page)
        save(page, "home")

    if want("search"):
        print("search")
        page.goto(f"{BASE}/search?q=%E8%85%BE%E8%AE%AF", wait_until="networkidle", timeout=60000)
        settle(page, "text=找到")
        close_overlays(page)
        save(page, "search")

    if want("company-overview"):
        print("company-overview")
        open_company(page)
        settle(page, "text=一句话介绍")
        close_overlays(page)
        save(page, "company-overview")

    if want("financials"):
        print("financials")
        page.goto(f"{BASE}/c/00700/financials", wait_until="networkidle", timeout=60000)
        settle(page, "text=营业收入")
        close_overlays(page)
        save(page, "financials")

    if want("graph"):
        print("graph")
        # A/HK graphs are sparse in the current corpus; AAPL has a real
        # 13F investment network, so use it for the tab screenshot.
        page.goto(f"{BASE}/c/AAPL/graph", wait_until="networkidle", timeout=60000)
        settle(page, ".graph-layout")
        close_overlays(page)
        save(page, "graph")

    if want("news"):
        print("news")
        page.goto(f"{BASE}/c/00700/news", wait_until="networkidle", timeout=60000)
        settle(page, "text=新闻动态")
        close_overlays(page)
        save(page, "news")

    if want("filings"):
        print("filings")
        page.goto(f"{BASE}/c/00700/filings", wait_until="networkidle", timeout=60000)
        settle(page, "text=公告文件")
        close_overlays(page)
        save(page, "filings")

    if want("sources"):
        print("sources")
        page.goto(f"{BASE}/c/00700/sources", wait_until="networkidle", timeout=60000)
        settle(page, "text=资料来源")
        close_overlays(page)
        save(page, "sources")

    if want("global-graph"):
        print("global-graph")
        page.goto(f"{BASE}/graph?company=NVDA", wait_until="networkidle", timeout=60000)
        settle(page, ".graph-layout")
        close_overlays(page)
        save(page, "global-graph")

    if want("taskdock"):
        print("taskdock")
        open_company(page)
        settle(page, "text=一句话介绍")
        close_overlays(page)
        page.locator(".dock-btn").click()
        page.wait_for_selector("#occ-task-dock", state="visible", timeout=10000)
        page.wait_for_timeout(500)
        save(page, "taskdock")
        page.locator(".dock-btn").click()
        page.wait_for_timeout(200)


def capture_mobile(browser, only: set[str]) -> None:
    if only and "mobile-financials" not in only:
        return
    print("mobile-financials")
    context = browser.new_context(
        viewport=MOBILE,
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
        color_scheme="light",
        locale="zh-CN",
    )
    init_page(context)
    page = context.new_page()
    page.goto(f"{BASE}/c/00700/financials", wait_until="networkidle", timeout=60000)
    settle(page, "text=营业收入")
    save(page, "mobile-financials")
    context.close()


def capture_agent(browser) -> None:
    print("agent (optional; spends LLM tokens)")
    context = browser.new_context(viewport=DESKTOP, color_scheme="light", locale="zh-CN")
    init_page(context)
    page = context.new_page()
    page.goto(f"{BASE}/c/00700", wait_until="networkidle", timeout=60000)
    page.get_by_role("button", name="AI 助手").first.click()
    page.wait_for_selector("#agent-input", timeout=15000)
    page.locator("#agent-input").fill("腾讯控股靠什么赚钱？请用两句话回答。")
    page.locator("#agent-input").press("Enter")
    # A real ACP answer ends with a citation row; wait for it to settle.
    page.wait_for_selector(".cite-row", state="visible", timeout=180000)
    page.wait_for_timeout(1200)
    page.evaluate(
        "() => { const body = document.querySelector('.ask-body'); if (body) body.scrollTop = 0; }"
    )
    page.wait_for_timeout(300)
    page.add_style_tag(
        content="*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; caret-color: transparent !important; }"
    )
    save(page, "agent")
    context.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="", help="comma-separated shot names")
    parser.add_argument("--with-agent", action="store_true", help="also capture the AI sidebar")
    args = parser.parse_args()
    only = {part.strip() for part in args.only.split(",") if part.strip()}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            viewport=DESKTOP,
            device_scale_factor=1,
            color_scheme="light",
            locale="zh-CN",
        )
        init_page(context)
        page = context.new_page()
        capture_desktop(page, only)
        context.close()
        capture_mobile(browser, only)
        if args.with_agent:
            capture_agent(browser)
        browser.close()
    print(f"done: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
