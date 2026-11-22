from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.deps import get_db
from app.db.base import Base
from app.db.models import RefreshToken as RefreshTokenRow
from app.db.models import User as UserRow
from app.main import create_app
from app.settings import settings


async def test_register_login_me_flow(db_client: AsyncClient) -> None:
    reg = await db_client.post(
        "/api/auth/register",
        json={
            "email": "alice@example.com",
            "password": "strong-password-123",
            "display_name": "Alice",
        },
    )
    assert reg.status_code == 201
    reg_body = reg.json()
    assert reg_body["access_token"]
    assert reg_body["token_type"] == "bearer"
    assert reg_body["expires_in"] > 0
    assert reg_body["user"]["email"] == "alice@example.com"
    assert reg_body["user"]["display_name"] == "Alice"
    assert reg_body["user"]["plan_tier"] == "free"
    reg_cookie = reg.headers.get("set-cookie", "").lower()
    assert "vs_refresh_token=" in reg_cookie
    assert "httponly" in reg_cookie
    assert "path=/api/auth" in reg_cookie
    assert db_client.cookies.get("vs_refresh_token")

    dup = await db_client.post(
        "/api/auth/register",
        json={
            "email": "ALICE@example.com",
            "password": "strong-password-123",
            "display_name": "Alice Dup",
        },
    )
    assert dup.status_code == 409

    bad_login = await db_client.post(
        "/api/auth/login",
        json={"email": "alice@example.com", "password": "wrong-password"},
    )
    assert bad_login.status_code == 401

    login = await db_client.post(
        "/api/auth/login",
        json={"email": "alice@example.com", "password": "strong-password-123"},
    )
    assert login.status_code == 200
    login_body = login.json()
    assert login_body["access_token"]
    assert login_body["user"]["id"] == reg_body["user"]["id"]
    assert "httponly" in login.headers.get("set-cookie", "").lower()

    assert (await db_client.get("/api/auth/me")).status_code == 401
    assert (
        await db_client.get(
            "/api/auth/me",
            headers={"Authorization": "Bearer invalid.jwt.token"},
        )
    ).status_code == 401

    me = await db_client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {login_body['access_token']}"},
    )
    assert me.status_code == 200
    me_body = me.json()
    assert me_body["id"] == reg_body["user"]["id"]
    assert me_body["email"] == "alice@example.com"
    assert me_body["display_name"] == "Alice"
    assert me_body["plan_tier"] == "free"


async def test_refresh_rotation_and_replay_detection(db_client: AsyncClient) -> None:
    reg = await db_client.post(
        "/api/auth/register",
        json={
            "email": "rotate@example.com",
            "password": "strong-password-123",
            "display_name": "Rotate",
        },
    )
    assert reg.status_code == 201
    cookie_1 = db_client.cookies.get("vs_refresh_token")
    assert cookie_1

    refreshed = await db_client.post("/api/auth/refresh")
    assert refreshed.status_code == 200
    assert refreshed.json()["access_token"]
    cookie_2 = db_client.cookies.get("vs_refresh_token")
    assert cookie_2
    assert cookie_2 != cookie_1

    db_client.cookies.clear()
    db_client.cookies.set("vs_refresh_token", cookie_1, path="/api/auth")
    replay = await db_client.post("/api/auth/refresh")
    assert replay.status_code == 401
    assert "max-age=0" in replay.headers.get("set-cookie", "").lower()

    db_client.cookies.clear()
    db_client.cookies.set("vs_refresh_token", cookie_2, path="/api/auth")
    revoked_successor = await db_client.post("/api/auth/refresh")
    assert revoked_successor.status_code == 401


async def test_logout_revokes_and_clears_cookie(db_client: AsyncClient) -> None:
    reg = await db_client.post(
        "/api/auth/register",
        json={
            "email": "logout@example.com",
            "password": "strong-password-123",
            "display_name": "Logout",
        },
    )
    assert reg.status_code == 201
    old_cookie = db_client.cookies.get("vs_refresh_token")
    assert old_cookie

    logout_resp = await db_client.post("/api/auth/logout")
    assert logout_resp.status_code == 204
    assert db_client.cookies.get("vs_refresh_token") is None

    no_cookie_refresh = await db_client.post("/api/auth/refresh")
    assert no_cookie_refresh.status_code == 401
    assert "max-age=0" in no_cookie_refresh.headers.get("set-cookie", "").lower()

    db_client.cookies.clear()
    db_client.cookies.set("vs_refresh_token", old_cookie, path="/api/auth")
    reused_refresh = await db_client.post("/api/auth/refresh")
    assert reused_refresh.status_code == 401


async def test_concurrent_refresh_rotation_is_atomic_and_revokes_replay() -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    concurrency = 5
    engine = create_async_engine(settings.test_database_url, pool_size=concurrency, max_overflow=0)
    app = create_app()
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        async with AsyncExitStack() as stack:
            warm_sessions = [
                await stack.enter_async_context(testing_session()) for _ in range(concurrency)
            ]
            await asyncio.gather(*(session.execute(text("SELECT 1")) for session in warm_sessions))

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "race@example.com",
                    "password": "strong-password-123",
                    "display_name": "Race",
                },
            )
            assert reg.status_code == 201
            user_id = UUID(reg.json()["user"]["id"])
            initial_cookie = reg.cookies.get(settings.refresh_cookie_name)
            assert initial_cookie

        async def fire_refresh() -> Response:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as req_client:
                return await req_client.post(
                    "/api/auth/refresh",
                    headers={"Cookie": f"{settings.refresh_cookie_name}={initial_cookie}"},
                )

        responses = await asyncio.gather(*(fire_refresh() for _ in range(concurrency)))
        succeeded = [resp for resp in responses if resp.status_code == 200]
        rejected = [resp for resp in responses if resp.status_code == 401]

        assert len(succeeded) == 1
        assert len(rejected) == concurrency - 1

        async with testing_session() as verify_session:
            token_rows = (
                await verify_session.scalars(
                    select(RefreshTokenRow).where(RefreshTokenRow.user_id == user_id)
                )
            ).all()
        assert len(token_rows) == 2
        assert all(row.revoked_at is not None for row in token_rows)

        winner_cookie = succeeded[0].cookies.get(settings.refresh_cookie_name)
        assert winner_cookie
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            post_replay = await client.post(
                "/api/auth/refresh",
                headers={"Cookie": f"{settings.refresh_cookie_name}={winner_cookie}"},
            )
            assert post_replay.status_code == 401
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_refresh_rejects_expired_token_and_inactive_user() -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    engine = create_async_engine(settings.test_database_url)
    app = create_app()
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            reg_expired = await client.post(
                "/api/auth/register",
                json={
                    "email": "expired@example.com",
                    "password": "strong-password-123",
                    "display_name": "Expired",
                },
            )
            assert reg_expired.status_code == 201
            expired_user_id = UUID(reg_expired.json()["user"]["id"])
            expired_cookie = reg_expired.cookies.get(settings.refresh_cookie_name)
            assert expired_cookie

            reg_inactive = await client.post(
                "/api/auth/register",
                json={
                    "email": "inactive@example.com",
                    "password": "strong-password-123",
                    "display_name": "Inactive",
                },
            )
            assert reg_inactive.status_code == 201
            inactive_user_id = UUID(reg_inactive.json()["user"]["id"])
            inactive_cookie = reg_inactive.cookies.get(settings.refresh_cookie_name)
            assert inactive_cookie

        async with testing_session() as session:
            await session.execute(
                update(RefreshTokenRow)
                .where(RefreshTokenRow.user_id == expired_user_id)
                .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
            )
            await session.execute(
                update(UserRow).where(UserRow.id == inactive_user_id).values(is_active=False)
            )
            await session.commit()

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            expired_resp = await client.post(
                "/api/auth/refresh",
                headers={"Cookie": f"{settings.refresh_cookie_name}={expired_cookie}"},
            )
            assert expired_resp.status_code == 401
            assert "max-age=0" in expired_resp.headers.get("set-cookie", "").lower()

            inactive_resp = await client.post(
                "/api/auth/refresh",
                headers={"Cookie": f"{settings.refresh_cookie_name}={inactive_cookie}"},
            )
            assert inactive_resp.status_code == 403
            assert "max-age=0" in inactive_resp.headers.get("set-cookie", "").lower()

        async with testing_session() as verify_session:
            inactive_token = await verify_session.scalar(
                select(RefreshTokenRow).where(RefreshTokenRow.user_id == inactive_user_id)
            )
            assert inactive_token is not None
            assert inactive_token.revoked_at is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
