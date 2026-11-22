from __future__ import annotations

from httpx import AsyncClient

from app.main import create_app


async def test_health_reports_ok(client: AsyncClient) -> None:
    response = await client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": "0.1.0"}


async def test_lifespan_disposes_cleanly() -> None:
    app = create_app()
    async with app.router.lifespan_context(app):
        pass
