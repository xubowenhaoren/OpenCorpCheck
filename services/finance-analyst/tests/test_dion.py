from __future__ import annotations

from occ_finance_analyst.dion import (
    append_page,
    iso_date,
    normalize_code,
    parse_corporation_name,
    parse_total_records,
    reason_label,
    row_to_notice,
)


def test_normalize_code_pads_and_strips_suffix() -> None:
    assert normalize_code("700") == "00700"
    assert normalize_code("00700.HK") == "00700"


def test_append_page_handles_trailing_ampersand() -> None:
    base = "https://di.hkex.com.hk/di/NSNoticeSSList.aspx?sc=00700&"
    assert append_page(base, 2).endswith("sc=00700&pg=2")
    assert append_page(base, 3).endswith("sc=00700&pg=3")


def test_total_records_and_corporation_name() -> None:
    body = (
        "Stock code:\t00700\n"
        "Name of listed corporation:\tTencent Holdings Ltd.\n"
        "Total records: 55\n"
    )
    assert parse_total_records(body) == 55
    assert parse_corporation_name(body) == "Tencent Holdings Ltd."


def test_row_to_notice_accepts_a_real_row() -> None:
    row = {
        "cells": [
            "CS20261031E00038",
            "BlackRock, Inc.",
            "1314(L)",
            "1,064,500(L)",
            "",
            "503,702,863(L)",
            "6.76(L)",
            "28/10/2026",
        ],
        "href": "NSForm2.aspx?fn=CS20261031E00038",
    }
    notice = row_to_notice(row)
    assert notice is not None
    assert notice["serial"] == "CS20261031E00038"
    assert notice["shareholder"] == "BlackRock, Inc."
    assert notice["percent"] == "6.76(L)"
    assert notice["holdings"] == "503,702,863(L)"
    assert notice["event_date"] == "2026-10-28"
    assert notice["reason"] == "1314(L)"
    assert notice["url"] == (
        "https://di.hkex.com.hk/di/NSForm2.aspx?fn=CS20261031E00038"
    )


def test_row_to_notice_rejects_headers_and_short_rows() -> None:
    assert row_to_notice({"cells": ["Form Serial Number"] * 8, "href": None}) is None
    assert row_to_notice({"cells": ["CS20261031E00038"], "href": None}) is None
    assert row_to_notice(None) is None


def test_reason_label_and_iso_date_fallbacks() -> None:
    assert reason_label("1201(L)") == "Sold (L)"
    assert reason_label("9999(L)") == "9999(L)"
    assert iso_date("28/10/2026") == "2026-10-28"
    assert iso_date("") is None
