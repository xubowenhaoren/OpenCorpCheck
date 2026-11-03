"""Pure helpers for the HKEXnews adapter (the Playwright flow is live-tested)."""

from __future__ import annotations

from occ_finance_analyst.hkexnews import _total_records


def test_total_records_from_result_page() -> None:
    body = "Disclosure of Interests\nTotal records found: 316\nRelease Time"
    assert _total_records(body) == 316
    assert _total_records("Total records found: 1,204\n") == 1204


def test_total_records_absent() -> None:
    assert _total_records("No matching records") is None
