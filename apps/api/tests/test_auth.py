from __future__ import annotations

from httpx import AsyncClient


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
