from __future__ import annotations

from datetime import datetime

from fastapi.testclient import TestClient


def test_overview_matches_contract(client: TestClient) -> None:
    response = client.get("/api/market/overview")
    assert response.status_code == 200

    body = response.json()
    assert body["indices"], "指数列表不能为空"
    assert body["hot_industries"], "行业资金流不能为空"
    assert 0 <= body["temperature"]["score"] <= 100
    assert body["temperature"]["level"] in {"cold", "cool", "neutral", "warm", "hot"}
    assert datetime.fromisoformat(body["generated_at"])
    assert {"code", "name", "price", "change_pct"} <= body["indices"][0].keys()


def test_overview_is_ordered_by_inflow(client: TestClient) -> None:
    flows = client.get("/api/market/overview").json()["hot_industries"]
    inflows = [flow["net_inflow"] for flow in flows]
    assert inflows == sorted(inflows, reverse=True)
