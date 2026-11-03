"""Request/response models for the sidecar HTTP API."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Market = Literal["A", "HK", "US"]


class ScrapeRequest(BaseModel):
    market: Market = Field(description="A, HK or US")
    code: str = Field(
        min_length=1,
        max_length=20,
        pattern=r"^[A-Za-z0-9.\-]+$",
        description="600519, 00700, AAPL, BRK.B",
    )
    pages: list[str] | None = Field(
        default=None,
        description="Page hashes, e.g. ['cwfx','gsgk']. Overrides preset.",
    )
    preset: str | None = Field(
        default=None,
        description="Preset name for the market; defaults to 'default'.",
    )
    force: bool = Field(default=False, description="Bypass the in-process result cache.")
    capture_xhr: bool = Field(
        default=True,
        description="Capture JSON XHR/fetch responses from eastmoney hosts.",
    )
    timeout_ms: int = Field(default=30000, ge=5000, le=120000)


class TableData(BaseModel):
    caption: str = ""
    headers: list[str] = Field(default_factory=list)
    rows: list[list[str]] = Field(default_factory=list)


class XhrCapture(BaseModel):
    # ``data`` is serialized as ``json`` (the wire key callers expect);
    # naming the field ``json`` would shadow ``BaseModel.json``.
    model_config = ConfigDict(populate_by_name=True)

    url: str
    status: int | None = None
    content_type: str = ""
    data: Any = Field(default=None, alias="json", serialization_alias="json")
    text: str | None = None
    truncated: bool = False


class PageResult(BaseModel):
    label: str
    page: str
    url: str
    final_url: str | None = None
    http_status: int | None = None
    text: str = ""
    text_chars: int = 0
    truncated: bool = False
    tables: list[TableData] = Field(default_factory=list)
    table_count: int = 0
    html_sha256: str | None = None
    storage_key: str | None = None
    xhr: list[XhrCapture] | None = None
    warnings: list[str] = Field(default_factory=list)
    attempts: int = 0
    elapsed_ms: int = 0
    error: str | None = None


class ScrapeMeta(BaseModel):
    market: Market
    code: str
    normalized_code: str
    fetched_at: str
    elapsed_ms: int
    pages_requested: int
    pages_ok: int
    concurrency: int
    rate_per_sec: float


class ScrapeResponse(BaseModel):
    meta: ScrapeMeta
    pages: list[PageResult] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    browser: Literal["starting", "ready", "closed"] = "starting"
    version: str
    settings: dict[str, Any] = Field(default_factory=dict)


class PagesResponse(BaseModel):
    market: Market
    pages: dict[str, str]
    presets: dict[str, list[str]]


class DionRequest(BaseModel):
    code: str = Field(
        min_length=1,
        max_length=5,
        pattern=r"^\d{1,5}$",
        description="HKEX stock code, e.g. 00700",
    )
    days: int = Field(default=365, ge=1, le=3650)
    max_pages: int = Field(default=10, ge=1, le=20)


class DionNotice(BaseModel):
    serial: str
    shareholder: str
    reason_code: str | None = None
    reason: str | None = None
    shares: str | None = None
    avg_price: str | None = None
    holdings: str | None = None
    percent: str | None = None
    event_date: str | None = None
    url: str | None = None


class DionResponse(BaseModel):
    code: str
    name: str | None = None
    from_date: str
    to_date: str
    total_records: int = 0
    pages: int = 0
    truncated: bool = False
    notices: list[DionNotice] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
