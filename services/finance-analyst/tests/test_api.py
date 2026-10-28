from __future__ import annotations

from fastapi.testclient import TestClient

from occ_finance_analyst.main import app

client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["browser"] in {"starting", "ready"}
    assert body["settings"]["max_concurrency"] >= 1


def test_pages_endpoint() -> None:
    response = client.get("/v1/f10/pages/US")
    assert response.status_code == 200
    body = response.json()
    assert body["pages"]["财务分析"] == "cwfx"
    assert "default" in body["presets"]


def test_unknown_market_is_422() -> None:
    response = client.post("/v1/f10/scrape", json={"market": "JP", "code": "7203"})
    assert response.status_code == 422


def test_unknown_page_is_422_without_browser() -> None:
    response = client.post(
        "/v1/f10/scrape",
        json={"market": "US", "code": "AAPL", "pages": ["nope"]},
    )
    assert response.status_code == 422
    assert "unknown page" in response.json()["detail"]


def test_code_pattern_rejects_paths() -> None:
    response = client.post(
        "/v1/f10/scrape",
        json={"market": "US", "code": "../etc/passwd", "pages": ["cwfx"]},
    )
    assert response.status_code == 422
