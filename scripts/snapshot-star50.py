# /// script
# requires-python = ">=3.10"
# dependencies = ["xlrd>=2.0.1", "pyyaml>=6.0"]
# ///
"""Refresh the CSI STAR 50 (科创50, 000688) constituent snapshot.

Run from the repository root:

    uv run scripts/snapshot-star50.py

The generated YAML is read by the worker (`--universe star50`). It is an
internal snapshot: record the source and `as_of`, and do not redistribute the
index data as a licensed dataset.

Sources
-------
Constituents: China Securities Index (CSI) official constituent workbook for
              000688 (``000688cons.xls``).
Weights:      CSI official close-weight workbook
              (``000688closeweight.xls``); published on a different date, so
              the snapshot records ``weights_as_of`` separately.

Both are fetched from the same host the A500 snapshot script uses. Tickers are
written as quoted strings; never hand-edit them.
"""

from __future__ import annotations

import argparse
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import xlrd
import yaml

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "config" / "indices"
UA = "OpenCorpCheck/0.1 (Bowen Xu; xubowenhaoren@gmail.com)"

BASE = (
    "https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/"
    "autofile"
)
CONS_URL = f"{BASE}/cons/000688cons.xls"
WEIGHT_URL = f"{BASE}/closeweight/000688closeweight.xls"
INDEX_PAGE = "https://www.csindex.com.cn/#/indices/family/detail?indexCode=000688"

EXCHANGES = {
    "上海证券交易所": "SSE",
    "Shanghai Stock Exchange": "SSE",
    "深圳证券交易所": "SZSE",
    "Shenzhen Stock Exchange": "SZSE",
}


class Ticker(str):
    """Force quotes: A-share tickers are numeric strings, not YAML numbers."""


def represent_quoted(dumper: yaml.SafeDumper, data: str):
    return dumper.represent_scalar("tag:yaml.org,2002:str", str(data), style="'")


yaml.add_representer(Ticker, represent_quoted, Dumper=yaml.SafeDumper)


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def read_workbook(raw: bytes) -> xlrd.sheet.Sheet:
    book = xlrd.open_workbook(file_contents=raw)
    return book.sheet_by_index(0)


def parse_cons(raw: bytes) -> tuple[str, list[dict[str, object]]]:
    sheet = read_workbook(raw)
    header = [str(sheet.cell_value(0, c)).strip() for c in range(sheet.ncols)]
    date_col = idx_by_header(header, "日期")
    code_col = idx_by_header(header, "成份券代码")
    zh_col = next(
        index
        for index, name in enumerate(header)
        if "成份券名称" in name and "英文" not in name
    )
    en_col = next(
        index
        for index, name in enumerate(header)
        if "成份券英文名称" in name
    )
    exchange_col = next(
        index
        for index, name in enumerate(header)
        if "交易所" in name and "英文" not in name
    )

    rows: list[dict[str, object]] = []
    as_of = ""
    for row in range(1, sheet.nrows):
        ticker = str(sheet.cell_value(row, code_col)).strip()
        if not ticker:
            continue
        date = str(sheet.cell_value(row, date_col)).strip()
        as_of = as_of or date
        exchange = EXCHANGES.get(str(sheet.cell_value(row, exchange_col)).strip())
        if not exchange:
            raise ValueError(
                f"unknown exchange for {ticker}: {sheet.cell_value(row, exchange_col)}"
            )
        rows.append(
            {
                "ticker": Ticker(ticker),
                "name": str(sheet.cell_value(row, zh_col)).strip(),
                "name_en": str(sheet.cell_value(row, en_col)).strip(),
                "exchange": exchange,
                "primary": True,
            }
        )
    return format_date(as_of), rows


def idx_by_header(header: list[str], needle: str) -> int:
    for index, name in enumerate(header):
        if needle in name:
            return index
    raise KeyError(needle)


def parse_weights(raw: bytes) -> tuple[str, dict[str, float]]:
    sheet = read_workbook(raw)
    header = [str(sheet.cell_value(0, c)).strip() for c in range(sheet.ncols)]
    code_col = idx_by_header(header, "成份券代码")
    weight_col = next(
        index for index, name in enumerate(header) if "权重" in name
    )
    date_col = idx_by_header(header, "日期")
    as_of = ""
    weights: dict[str, float] = {}
    for row in range(1, sheet.nrows):
        ticker = str(sheet.cell_value(row, code_col)).strip()
        if not ticker:
            continue
        as_of = as_of or str(sheet.cell_value(row, date_col)).strip()
        weights[ticker] = round(float(sheet.cell_value(row, weight_col)), 4)
    return format_date(as_of), weights


def format_date(raw: str) -> str:
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) != 8:
        raise ValueError(f"unexpected CSI date {raw!r}")
    return f"{digits[0:4]}-{digits[4:6]}-{digits[6:8]}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cons",
        help="Use a local constituent workbook instead of downloading",
    )
    parser.add_argument(
        "--weights",
        help="Use a local close-weight workbook instead of downloading",
    )
    parser.add_argument("--out", type=Path, default=OUT_DIR / "star50.yaml")
    args = parser.parse_args()

    cons_bytes = Path(args.cons).read_bytes() if args.cons else fetch(CONS_URL)
    as_of, constituents = parse_cons(cons_bytes)
    try:
        weight_bytes = (
            Path(args.weights).read_bytes() if args.weights else fetch(WEIGHT_URL)
        )
        weights_as_of, weights = parse_weights(weight_bytes)
    except Exception as error:  # weights are optional; constituents are not
        print(f"warning: STAR 50 weights unavailable: {error}")
        weights_as_of, weights = None, {}

    if len(constituents) != 50:
        raise SystemExit(f"expected 50 STAR 50 constituents, got {len(constituents)}")
    tickers = [str(row["ticker"]) for row in constituents]
    if len(set(tickers)) != 50:
        raise SystemExit("duplicate STAR 50 tickers")
    if weights and set(weights) != set(tickers):
        raise SystemExit("constituent and weight tickers disagree")

    for row in constituents:
        weight = weights.get(str(row["ticker"]))
        if weight is not None:
            row["weight"] = weight

    document = {
        "index": {
            "code": "STAR50",
            "name": "STAR 50 (科创50)",
            "market": "A",
            "as_of": as_of,
            **({"weights_as_of": weights_as_of} if weights_as_of else {}),
            "fetched_at": datetime.now(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
            "securities": len(constituents),
            "companies": len(constituents),
            "source": {
                "name": "CSI STAR 50 official constituent + close-weight workbooks (000688)",
                "url": INDEX_PAGE,
                "license": "Internal snapshot - no bulk redistribution",
            },
        },
        "constituents": constituents,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=args.out.parent, delete=False
    ) as handle:
        yaml.safe_dump(
            document,
            handle,
            allow_unicode=True,
            sort_keys=False,
            default_flow_style=False,
        )
        tmp = Path(handle.name)
    tmp.replace(args.out)
    args.out.chmod(0o644)
    print(f"wrote {args.out} ({len(constituents)} constituents, as_of {as_of})")


if __name__ == "__main__":
    main()
