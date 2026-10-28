"""Market page maps for Eastmoney F10.

The page hashes and URL bases are derived from ``scripts/aif10_scraper.py`` in
the private ``finance_analyst`` repository (Apache-2.0). They are kept as data
so a UI change can be fixed without touching the scraper.

F10 is a proprietary Eastmoney surface: use it for internal research with
attribution, never redistribute bulk snapshots.
"""

from __future__ import annotations

from typing import Callable, Literal

Market = Literal["A", "HK", "US"]

BASE_URLS: dict[str, str] = {
    "A": (
        "https://emweb.eastmoney.com/PC_HSF10/pages/index.html"
        "?type=web&color=w&ischoice=1&code="
    ),
    "HK": (
        "https://emweb.eastmoney.com/pc_hkf10/pages/home/index.html"
        "?type=web&color=w&ischoice=1&code="
    ),
    "US": (
        "https://emweb.eastmoney.com/PC_USF10/pages/index.html"
        "?type=web&color=w&ischoice=1&code="
    ),
}

# Ordered {label: hash} maps. Anthropic labels stay in Chinese like the source
# scraper, because they are what the F10 UI shows.
PAGES: dict[str, dict[str, str]] = {
    "A": {
        "操盘必读": "cpbd",
        "财务分析": "cwfx",
        "盈利预测": "ylyc",
        "研究报告": "yjbg",
        "公司大事": "gsds",
        "股东研究": "gdyj",
        "同行比较": "thbj",
        "核心题材": "hxtc",
        "经营分析": "jyfx",
        "公司概况": "gsgk",
        "公司高管": "gsgg",
        "关联个股": "glgg",
        "分红融资": "fhrz",
        "咨询公告": "zxgg",
        "股本结构": "gbjg",
        "资本运作": "zbyz",
    },
    "HK": {
        "核心必读": "CoreReading",
        "财务分析": "NewFinancialAnalysis",
        "投资评级": "InvestmentRating",
        "行业对比": "IndustryComparison",
        "主要股东": "MajorShareholder",
        "公司大事": "CorporateEvents",
        "业务展望": "BusinessExpectation",
        "股本结构": "CapitalStructure",
        "公司概况": "CompanyProfile",
        "公司高管": "CompanyManager",
        "关联权证": "RelatedWarrants",
        "咨询公告": "CompanyNews",
    },
    "US": {
        "核心必读": "hxbd",
        "财务分析": "cwfx",
        "股本股东": "gbgd",
        "公司大事": "gsds",
        "公司概况": "gsgk",
    },
}

# First-run presets from CONTEXT_TRANSFER.md. Values are page hashes.
PRESETS: dict[str, dict[str, list[str]]] = {
    "A": {
        "default": [
            "cwfx", "jyfx", "gsgk", "gdyj",
            "gsds", "hxtc", "yjbg", "thbj",
        ],
        "minimal": ["cwfx", "gsgk"],
    },
    "HK": {
        "default": [
            "NewFinancialAnalysis", "CoreReading", "CompanyProfile",
            "MajorShareholder", "CorporateEvents", "InvestmentRating",
            "BusinessExpectation",
        ],
        "minimal": ["NewFinancialAnalysis", "CoreReading"],
    },
    "US": {
        "default": ["cwfx", "gsgk", "gbgd", "gsds", "hxbd"],
        "minimal": ["cwfx", "gsgk"],
    },
}

_CODE_FORMATTERS: dict[str, Callable[[str], str]] = {
    "A": lambda c: f"SH{c}" if c.startswith(("6", "9")) else f"SZ{c}",
    "HK": lambda c: c.zfill(5),
    "US": lambda c: c.upper(),
}


class UnknownMarket(ValueError):
    pass


class UnknownPage(ValueError):
    pass


def normalize_code(market: str, code: str) -> str:
    """Return the code as Eastmoney expects it (SH600519, 00700, AAPL)."""
    if market not in PAGES:
        raise UnknownMarket(f"unknown market {market!r}; use A, HK or US")
    code = code.strip()
    if not code:
        raise ValueError("code must not be empty")
    return _CODE_FORMATTERS[market](code)


def page_label(market: str, page: str) -> str:
    """Map a page hash back to its human label."""
    for label, hash_value in PAGES[market].items():
        if hash_value == page:
            return label
    raise UnknownPage(f"unknown page {page!r} for market {market}")


def resolve_pages(market: str, pages: list[str] | None, preset: str | None) -> list[str]:
    """Resolve a request to an ordered list of page hashes.

    ``pages`` wins over ``preset``. With neither, the market's default preset
    is used. Unknown pages raise ``UnknownPage`` with the valid list.
    """
    if market not in PAGES:
        raise UnknownMarket(f"unknown market {market!r}; use A, HK or US")

    valid = PAGES[market]
    valid_hashes = set(valid.values())

    if pages:
        seen: set[str] = set()
        ordered: list[str] = []
        for page in pages:
            if page not in valid_hashes:
                raise UnknownPage(
                    f"unknown page {page!r} for market {market}; "
                    f"valid: {sorted(valid_hashes)}"
                )
            if page not in seen:
                seen.add(page)
                ordered.append(page)
        return ordered

    preset_name = preset or "default"
    if preset_name not in PRESETS[market]:
        raise UnknownPage(
            f"unknown preset {preset_name!r} for market {market}; "
            f"valid: {sorted(PRESETS[market])}"
        )
    return list(PRESETS[market][preset_name])


def build_url(market: str, code: str, page: str) -> str:
    """Build the SPA URL for one F10 page.

    Eastmoney routes tabs with a hash fragment (``#/cwfx``); the SPA reads it
    after load, so the page itself is a normal navigation.
    """
    return f"{BASE_URLS[market]}{normalize_code(market, code)}#/{page}"
