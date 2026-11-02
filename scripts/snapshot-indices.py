# /// script
# requires-python = ">=3.10"
# dependencies = ["xlrd>=2.0.1", "openpyxl>=3.1", "pyyaml>=6.0"]
# ///
"""Refresh the CSI A500 and S&P 500 constituent snapshots.

Run from the repository root:

    uv run scripts/snapshot-indices.py

The generated YAML files are read by `occ indices sync`. They are internal
snapshots: record the source and do not redistribute the index data as a
licensed dataset.

Sources
-------
A500: China Securities Index (CSI) official constituent and weight workbooks.
SPX:  SPDR S&P 500 ETF Trust (SPY) daily holdings, published by State Street.
      S&P Dow Jones Indices does not expose a stable public constituent API;
      SPY holdings are the documented fallback (same precedent as HSI).
      Ticker -> exchange/CIK comes from the SEC's official
      `company_tickers_exchange.json`.
"""

from __future__ import annotations

import io
import json
import re
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import openpyxl
import xlrd
import yaml

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "config" / "indices"
UA = "OpenCorpCheck/0.1 (Bowen Xu; xubowenhaoren@gmail.com)"

A500_CONS = (
    "https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/"
    "autofile/cons/000510cons.xls"
)
A500_WEIGHT = (
    "https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/"
    "autofile/closeweight/000510closeweight.xls"
)
SPY_HOLDINGS = (
    "https://www.ssga.com/us/en/intermediary/library-content/products/"
    "fund-data/etfs/us/holdings-daily-us-en-spy.xlsx"
)
SEC_TICKERS = "https://www.sec.gov/files/company_tickers_exchange.json"

class Cik(str):
    """Force quotes so YAML/JS never reads a CIK with leading zeros as a number."""


class Ticker(str):
    """Force quotes: A-share tickers are numeric strings, not YAML numbers."""


def represent_quoted(dumper: yaml.SafeDumper, data: str):
    return dumper.represent_scalar("tag:yaml.org,2002:str", str(data), style="'")


yaml.add_representer(Cik, represent_quoted, Dumper=yaml.SafeDumper)
yaml.add_representer(Ticker, represent_quoted, Dumper=yaml.SafeDumper)

US_EXCHANGES = {
    "nasdaq": "NASDAQ",
    "nyse": "NYSE",
    "cboe": "CBOE",
    "nyse american": "AMEX",
    "nyse arca": "NYSE",
    "cboe bzx": "CBOE",
    "otc": "OTC",
}


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def a500_exchange(chinese: str, english: str) -> str:
    text = f"{chinese} {english}".lower()
    if "shenzhen" in text or "深圳" in text:
        return "SZSE"
    if "shanghai" in text or "上海" in text:
        return "SSE"
    if "beijing" in text or "北京" in text:
        return "BSE"
    raise ValueError(f"unknown A500 exchange: {chinese} / {english}")


def normalise_us_exchange(value: str | None) -> str:
    if not value:
        return "NYSE"
    return US_EXCHANGES.get(value.strip().lower(), value.strip().upper())


def sec_exchange_map(raw: bytes) -> dict[str, dict[str, object]]:
    payload = json.loads(raw)
    fields = payload["fields"]
    rows = payload["data"]
    lookup: dict[str, dict[str, object]] = {}
    for row in rows:
        record = dict(zip(fields, row, strict=True))
        ticker = str(record["ticker"]).upper()
        lookup[ticker] = record
        # BRK.B in holdings is BRK-B in the SEC file (and vice versa).
        lookup.setdefault(ticker.replace("-", "."), record)
    return lookup


def load_a500() -> dict:
    cons = xlrd.open_workbook(file_contents=fetch(A500_CONS)).sheet_by_index(0)
    weights = xlrd.open_workbook(file_contents=fetch(A500_WEIGHT)).sheet_by_index(0)

    weight_map: dict[str, float] = {}
    weight_date = ""
    for row in range(1, weights.nrows):
        ticker = str(weights.cell_value(row, 4)).strip().zfill(6)
        if not ticker:
            continue
        weight_date = str(weights.cell_value(row, 0)).strip()
        weight_map[ticker] = float(weights.cell_value(row, 9))

    constituents = []
    as_of = ""
    for row in range(1, cons.nrows):
        as_of = str(cons.cell_value(row, 0)).strip()
        ticker = str(cons.cell_value(row, 4)).strip().zfill(6)
        constituent = {
            "ticker": Ticker(ticker),
            "name": str(cons.cell_value(row, 5)).strip(),
            "name_en": str(cons.cell_value(row, 6)).strip(),
            "exchange": a500_exchange(
                str(cons.cell_value(row, 7)), str(cons.cell_value(row, 8))
            ),
            "primary": True,
        }
        weight = weight_map.get(ticker)
        if weight is not None:
            constituent["weight"] = round(weight, 6)
        constituents.append(constituent)

    constituents.sort(key=lambda entry: entry["ticker"])
    return {
        "index": {
            "code": "A500",
            "name": "CSI A500 (中证A500)",
            "market": "A",
            "as_of": format_yymmdd(as_of),
            "weights_as_of": format_yymmdd(weight_date),
            "fetched_at": now(),
            "securities": len(constituents),
            "companies": len(constituents),
            "source": {
                "name": "China Securities Index Co., Ltd. (CSI)",
                "url": "https://www.csindex.com.cn/zh-CN/indices/index-detail/000510",
                "license": (
                    "CSI index data — internal snapshot for demo/research; "
                    "no bulk redistribution"
                ),
                "files": [A500_CONS, A500_WEIGHT],
            },
        },
        "constituents": constituents,
    }


def load_spx() -> dict:
    workbook = openpyxl.load_workbook(
        io.BytesIO(fetch(SPY_HOLDINGS)), read_only=True, data_only=True
    )
    sheet = workbook["holdings"]
    rows = list(sheet.iter_rows(values_only=True))

    header_at = next(
        index
        for index, row in enumerate(rows)
        if row and row[0] == "Name" and row[1] == "Ticker"
    )
    as_of = ""
    for row in rows[:header_at]:
        if row and row[0] == "Holdings:" and row[1]:
            as_of = str(row[1]).replace("As of ", "").strip()

    sec = sec_exchange_map(fetch(SEC_TICKERS))

    records: list[dict] = []
    for row in rows[header_at + 1 :]:
        if not row or not row[1]:
            continue
        ticker = str(row[1]).strip().upper()
        if not re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,9}", ticker):
            continue
        name = str(row[0]).strip()
        sec_record = sec.get(ticker)
        cik = None
        exchange = "NYSE"
        if sec_record:
            cik = Cik(str(sec_record["cik"]).zfill(10))
            exchange = normalise_us_exchange(str(sec_record["exchange"]))
            # Prefer the SEC's mixed-case legal name over SPY's ALL CAPS.
            name = str(sec_record["name"]).strip() or name
        records.append(
            {
                "ticker": Ticker(ticker),
                "name": name,
                "exchange": exchange,
                "primary": True,
                "weight": round(float(row[4]), 6),
                **({"cik": cik} if cik else {}),
            }
        )

    # Share classes share one CIK; only the heaviest class becomes the stub
    # company, the rest are secondary tickers of the same company.
    by_cik: dict[str, list[dict]] = {}
    for record in records:
        if record.get("cik"):
            by_cik.setdefault(record["cik"], []).append(record)
    for group in by_cik.values():
        group.sort(key=lambda entry: entry["weight"], reverse=True)
        # The index membership is company-level; sum the share-class weights so
        # every row of the same issuer reports the same total.
        total = round(sum(entry["weight"] for entry in group), 6)
        for entry in group:
            entry["weight"] = total
        for entry in group[1:]:
            entry["primary"] = False
    records.sort(key=lambda entry: (not entry["primary"], entry["ticker"]))

    return {
        "index": {
            "code": "SPX",
            "name": "S&P 500",
            "market": "US",
            "as_of": format_us_date(as_of),
            "fetched_at": now(),
            "securities": len(records),
            "companies": len({record.get("cik") or record["ticker"] for record in records}),
            "source": {
                "name": (
                    "State Street Global Advisors — SPDR S&P 500 ETF Trust "
                    "(SPY) daily holdings"
                ),
                "url": SPY_HOLDINGS,
                "license": (
                    "Fund holdings snapshot for internal demo/research; S&P 500 "
                    "is a trademark of S&P Dow Jones Indices; no bulk redistribution"
                ),
                "files": [SPY_HOLDINGS, SEC_TICKERS],
                "note": (
                    "S&P DJI does not publish a stable public constituent API; "
                    "SPY holdings are the documented fallback (same as HSI)."
                ),
            },
        },
        "constituents": records,
    }


def format_yymmdd(value: str) -> str:
    value = value.strip()
    if re.fullmatch(r"\d{8}", value):
        return f"{value[:4]}-{value[4:6]}-{value[6:]}"
    return value


def format_us_date(value: str) -> str:
    # SPY prints "29-Oct-2026".
    try:
        return datetime.strptime(value, "%d-%b-%Y").date().isoformat()
    except ValueError:
        return value


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def write_yaml(path: Path, payload: dict) -> None:
    text = yaml.safe_dump(
        payload,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=1000,
    )
    header = (
        "# Generated by scripts/snapshot-indices.py — do not edit by hand.\n"
        "# Refresh by re-running the script; the file records source and license.\n\n"
    )
    path.write_text(header + text, encoding="utf-8")
    print(f"wrote {path} ({len(payload['constituents'])} constituents)")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write_yaml(OUT_DIR / "a500.yaml", load_a500())
    write_yaml(OUT_DIR / "sp500.yaml", load_spx())


if __name__ == "__main__":
    main()
