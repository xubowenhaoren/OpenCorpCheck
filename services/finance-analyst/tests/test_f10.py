from __future__ import annotations

from occ_finance_analyst.f10 import (
    _error_page,
    _looks_rendered,
    _normalize_tables,
    _safe_label,
)


def test_normalize_tables_keeps_structure() -> None:
    raw = [
        {
            "caption": "主要指标",
            "headers": ["指标", "2025"],
            "rows": [["营收", "100"], ["净利润", "20"]],
        },
        {"caption": "", "headers": [], "rows": [["single"]]},
        {"caption": "", "headers": [], "rows": []},
    ]
    tables = _normalize_tables(raw)
    assert len(tables) == 1
    assert tables[0]["caption"] == "主要指标"
    assert tables[0]["headers"] == ["指标", "2025"]
    assert tables[0]["rows"][1] == ["净利润", "20"]


def test_normalize_tables_caps_cells() -> None:
    raw = [
        {
            "caption": "",
            "headers": ["h"],
            "rows": [["x" * 5000]],
        }
    ]
    tables = _normalize_tables(raw)
    assert len(tables[0]["rows"][0][0]) == 4000


def test_safe_label_falls_back_to_hash() -> None:
    assert _safe_label("US", "cwfx") == "财务分析"
    assert _safe_label("US", "unknown") == "unknown"


def test_looks_rendered_rejects_shell() -> None:
    shell_tables = [
        {"caption": "", "headers": [], "rows": [["a"]]},
        {"caption": "", "headers": [], "rows": [["b"]]},
    ]
    assert not _looks_rendered("核心必读 公司概况 财务分析", shell_tables)


def test_looks_rendered_accepts_text_or_data_table() -> None:
    assert _looks_rendered("x" * 500, [])
    assert _looks_rendered(
        "short",
        [{"caption": "", "headers": [], "rows": [["1"], ["2"], ["3"]]}],
    )


def test_error_page_is_well_formed() -> None:
    page = _error_page("A", "600519", "cwfx", "财务分析", "boom")
    assert page["error"] == "boom"
    assert page["text"] == ""
    assert page["url"].endswith("code=SH600519#/cwfx")
