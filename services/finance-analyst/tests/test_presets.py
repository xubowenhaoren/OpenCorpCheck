from __future__ import annotations

import pytest

from occ_finance_analyst import presets


def test_normalize_code_a_share() -> None:
    assert presets.normalize_code("A", "600519") == "SH600519"
    assert presets.normalize_code("A", "900901") == "SH900901"
    assert presets.normalize_code("A", "000001") == "SZ000001"
    assert presets.normalize_code("A", "300750") == "SZ300750"


def test_normalize_code_hk_and_us() -> None:
    assert presets.normalize_code("HK", "700") == "00700"
    assert presets.normalize_code("HK", "00700") == "00700"
    assert presets.normalize_code("US", "aapl") == "AAPL"
    assert presets.normalize_code("US", "brk.b") == "BRK.B"


def test_resolve_pages_explicit_order_and_dedupe() -> None:
    assert presets.resolve_pages("US", ["gsgk", "cwfx", "gsgk"], None) == ["gsgk", "cwfx"]


def test_resolve_pages_default_preset() -> None:
    assert presets.resolve_pages("A", None, None)[0] == "cwfx"
    assert presets.resolve_pages("HK", None, "minimal") == [
        "NewFinancialAnalysis",
        "CoreReading",
    ]


def test_resolve_pages_rejects_unknown() -> None:
    with pytest.raises(presets.UnknownPage):
        presets.resolve_pages("US", ["not-a-page"], None)
    with pytest.raises(presets.UnknownPage):
        presets.resolve_pages("US", None, "nope")


def test_unknown_market() -> None:
    with pytest.raises(presets.UnknownMarket):
        presets.normalize_code("JP", "7203")
    with pytest.raises(presets.UnknownMarket):
        presets.resolve_pages("JP", None, None)


def test_build_url_routes_by_hash() -> None:
    url = presets.build_url("A", "600519", "cwfx")
    assert url.endswith("code=SH600519#/cwfx")
    assert "PC_HSF10" in url


def test_every_preset_page_exists() -> None:
    for market, presets_for_market in presets.PRESETS.items():
        valid = set(presets.PAGES[market].values())
        for name, pages in presets_for_market.items():
            assert set(pages) <= valid, f"{market}/{name} references unknown pages"
