"""Deterministic PDF extraction tests (no network, no binary fixture)."""

from __future__ import annotations

from occ_finance_analyst.pdf import MAX_TEXT_CHARS, PdfError, extract_pdf


def _minimal_pdf(text: str = "Hello PDF") -> bytes:
    """Build a one-page PDF with a Type1 font and no dependencies."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
            b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
        ),
        None,  # content stream, filled below
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    stream = f"BT /F1 12 Tf 20 200 Td ({text}) Tj ET".encode("latin1")
    objects[3] = (
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n"
        + stream
        + b"\nendstream"
    )
    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets[1:]:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n"
    ).encode()
    return bytes(out)


def test_extracts_page_text_with_provenance() -> None:
    result = extract_pdf(_minimal_pdf("Hello OpenCorpCheck"))
    assert result["page_count"] == 1
    assert result["truncated"] is False
    assert result["pages"][0]["page"] == 1
    assert "Hello OpenCorpCheck" in result["pages"][0]["text"]


def test_rejects_non_pdf_bytes() -> None:
    try:
        extract_pdf(b"<html>not a pdf</html>")
    except PdfError as exc:
        assert "not a PDF" in str(exc)
    else:  # pragma: no cover - the assertion is the point
        raise AssertionError("expected PdfError")


def test_reports_page_cap() -> None:
    result = extract_pdf(_minimal_pdf(), max_pages=1)
    assert result["page_count"] == 1
    assert result["truncated"] is False
    assert MAX_TEXT_CHARS >= 1
