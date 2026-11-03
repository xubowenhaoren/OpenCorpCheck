"""Deterministic PDF text/table extraction for official filings.

The TypeScript worker fetches the PDF bytes (so the adapter owns politeness and
raw caching) and posts them here. ``pdfplumber`` decodes embedded CJK fonts and
extracts tables with page provenance; no LLM is involved.

Caps keep a 400-page annual report from turning into an embedding job:
``max_pages`` defaults to 80, each page keeps at most 20k characters and 20
tables, and every table keeps at most 200 rows. Truncation is reported, never
silent.
"""

from __future__ import annotations

import io
import logging
from typing import Any

import pdfplumber

logger = logging.getLogger(__name__)

MAX_TEXT_CHARS = 20_000
MAX_TABLES = 20
MAX_TABLE_ROWS = 200
MAX_PAGES = 200


class PdfError(RuntimeError):
    """The bytes are not a readable PDF."""


def _clean(value: Any) -> str:
    return " ".join(str(value or "").split())


def extract_pdf(data: bytes, *, max_pages: int = 80) -> dict[str, Any]:
    """Return ``{page_count, pages:[{page,text,tables}],truncated,warnings}``."""
    if not data.startswith(b"%PDF-"):
        raise PdfError("input is not a PDF (missing %PDF- header)")
    max_pages = max(1, min(int(max_pages), MAX_PAGES))
    pages: list[dict[str, Any]] = []
    warnings: list[str] = []
    try:
        pdf = pdfplumber.open(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001 - surface a clean API error
        raise PdfError(f"cannot open PDF: {exc}") from exc
    with pdf:
        total = len(pdf.pages)
        limit = min(total, max_pages)
        if total > limit:
            warnings.append(
                f"page cap reached: extracted {limit}/{total} pages"
            )
        for index in range(limit):
            page = pdf.pages[index]
            text = ""
            tables: list[list[list[str]]] = []
            try:
                text = page.extract_text() or ""
                tables = page.extract_tables() or []
            except Exception as exc:  # noqa: BLE001 - one bad page is not fatal
                warnings.append(f"page {index + 1}: {type(exc).__name__}: {exc}")
            if len(text) > MAX_TEXT_CHARS:
                text = text[:MAX_TEXT_CHARS]
                warnings.append(
                    f"page {index + 1}: text truncated to {MAX_TEXT_CHARS} chars"
                )
            normalized: list[dict[str, Any]] = []
            for table in tables[:MAX_TABLES]:
                if len(table) > MAX_TABLE_ROWS:
                    warnings.append(
                        f"page {index + 1}: table rows truncated to {MAX_TABLE_ROWS}"
                    )
                rows = [
                    [_clean(cell) for cell in row]
                    for row in table[:MAX_TABLE_ROWS]
                ]
                rows = [row for row in rows if any(cell for cell in row)]
                if not rows:
                    continue
                header = rows[0]
                body = rows[1:]
                normalized.append({"headers": header, "rows": body})
            if len(tables) > MAX_TABLES:
                warnings.append(
                    f"page {index + 1}: kept {MAX_TABLES}/{len(tables)} tables"
                )
            pages.append(
                {
                    "page": index + 1,
                    "text": text,
                    "tables": normalized,
                }
            )
    return {
        "page_count": total,
        "pages": pages,
        "truncated": total > limit,
        "warnings": warnings,
    }
