from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import smtplib
import time
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import jwt
import pytest
from httpx import ASGITransport, AsyncClient, Response
from pydantic import ValidationError
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.email.smtp import SmtpEmailAdapter
from app.adapters.postgres.user import (
    PostgresEmailVerificationRepository,
    PostgresRefreshTokenRepository,
)
from app.adapters.security.token import JwtTokenCodec
from app.api.deps import get_db, get_email_sender, get_password_hasher
from app.db.base import Base
from app.db.models import EmailVerificationCode as EmailCodeRow
from app.db.models import JournalEntry, Setting, UserEvent, WatchlistItem
from app.db.models import RefreshToken as RefreshTokenRow
from app.db.models import User as UserRow
from app.domain.errors import EmailDeliveryError, EmailNotConfiguredError, UserNotFoundError
from app.domain.models import AuthenticatedUser, EmailCodePurpose, PlanTier
from app.main import _redact_validation_input, create_app
from app.settings import Settings, settings


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


class _FakeEmailSender:
    def __init__(self, *, active_sessions: list[AsyncSession] | None = None) -> None:
        self.sent: list[dict[str, Any]] = []
        self.fail = False
        self.fail_exc: BaseException | None = None
        self.delay_seconds = 0.0
        self.tx_states: list[bool] = []
        self._active_sessions = active_sessions

    async def ensure_configured(self) -> None:
        return None

    async def send_verification_code(
        self,
        *,
        to_email: str,
        code: str,
        purpose: EmailCodePurpose,
        expires_minutes: int,
    ) -> None:
        if self._active_sessions:
            self.tx_states.append(self._active_sessions[-1].in_transaction())
        if self.delay_seconds > 0:
            await asyncio.sleep(self.delay_seconds)
        if self.fail_exc is not None:
            raise self.fail_exc
        if self.fail:
            raise EmailDeliveryError()
        self.sent.append(
            {
                "to_email": to_email,
                "code": code,
                "purpose": purpose,
                "expires_minutes": expires_minutes,
            }
        )


async def test_auth_config_and_unconfigured_smtp_behavior(
    db_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = await db_client.get("/api/auth/config")
    assert cfg.status_code == 200
    assert cfg.json()["email_verification_required"] is False
    assert cfg.json()["smtp_configured"] is False

    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(settings, "smtp_username", "mailer@example.com")
    monkeypatch.setattr(settings, "smtp_password", "synthetic-smtp-token")
    cfg_smtp = await db_client.get("/api/auth/config")
    assert cfg_smtp.status_code == 200
    assert cfg_smtp.json()["smtp_configured"] is True
    assert cfg_smtp.json()["email_verification_required"] is True

    monkeypatch.setattr(settings, "auth_require_email_verification", False)
    cfg_override = await db_client.get("/api/auth/config")
    assert cfg_override.status_code == 200
    assert cfg_override.json()["smtp_configured"] is True
    assert cfg_override.json()["email_verification_required"] is False

    reg = await db_client.post(
        "/api/auth/register",
        json={
            "email": "existing-unconfigured@example.com",
            "password": "strong-password-123",
            "display_name": "Existing",
        },
    )
    assert reg.status_code == 201

    unconfigured_send = await db_client.post(
        "/api/auth/email-codes",
        json={"email": "new-user@example.com", "purpose": "register"},
    )
    assert unconfigured_send.status_code == 503

    unconfigured_existing_reg = await db_client.post(
        "/api/auth/email-codes",
        json={"email": "existing-unconfigured@example.com", "purpose": "register"},
    )
    assert unconfigured_existing_reg.status_code == 503

    unconfigured_reset_unknown = await db_client.post(
        "/api/auth/email-codes",
        json={"email": "unknown-unconfigured@example.com", "purpose": "reset_password"},
    )
    assert unconfigured_reset_unknown.status_code == 503

    unconfigured_reset_known = await db_client.post(
        "/api/auth/email-codes",
        json={"email": "existing-unconfigured@example.com", "purpose": "reset_password"},
    )
    assert unconfigured_reset_known.status_code == 503


async def test_jwt_token_version_claim_validation() -> None:
    codec = JwtTokenCodec(
        secret="unit-test-secret-with-at-least-32-chars",
        algorithm="HS256",
        access_ttl_minutes=15,
    )
    user = AuthenticatedUser(
        id=UUID("11111111-1111-1111-1111-111111111111"),
        plan_tier=PlanTier.PRO,
        token_version=3,
    )
    token, _ = await codec.issue_access_token(user)
    decoded = await codec.decode_access_token(token)
    assert decoded is not None
    assert decoded.id == user.id
    assert decoded.plan_tier == PlanTier.PRO
    assert decoded.token_version == 3

    for bad_tv in (None, True, False, "1", 0, -1):
        payload: dict[str, Any] = {
            "sub": str(user.id),
            "tier": "free",
            "type": "access",
            "exp": int((datetime.now(UTC) + timedelta(minutes=5)).timestamp()),
        }
        if bad_tv is not None:
            payload["tv"] = bad_tv
        bad_token = jwt.encode(
            payload,
            "unit-test-secret-with-at-least-32-chars",
            algorithm="HS256",
        )
        assert await codec.decode_access_token(bad_token) is None


async def test_smtp_adapter_tls_utf8_injection_rejection_and_log_hygiene(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    captured_ssl: list[dict[str, Any]] = []
    captured_plain: list[dict[str, Any]] = []

    class _FakeSmtpSsl:
        def __init__(self, host: str, port: int, *, timeout: float, context: Any) -> None:
            captured_ssl.append(
                {
                    "host": host,
                    "port": port,
                    "timeout": timeout,
                    "has_context": context is not None,
                }
            )

        def __enter__(self) -> _FakeSmtpSsl:
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def login(self, username: str, password: str) -> None:
            captured_ssl[-1]["login"] = (username, password)

        def send_message(self, msg: Any) -> None:
            captured_ssl[-1]["subject"] = str(msg["Subject"])
            captured_ssl[-1]["to"] = str(msg["To"])
            captured_ssl[-1]["from"] = str(msg["From"])
            captured_ssl[-1]["body"] = msg.get_content()

    class _FakeSmtpPlain:
        def __init__(self, host: str, port: int, *, timeout: float) -> None:
            captured_plain.append({"host": host, "port": port, "timeout": timeout})

        def __enter__(self) -> _FakeSmtpPlain:
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def ehlo(self) -> None:
            captured_plain[-1]["ehlo"] = captured_plain[-1].get("ehlo", 0) + 1

        def starttls(self, *, context: Any) -> None:
            captured_plain[-1]["starttls"] = context is not None

        def login(self, username: str, password: str) -> None:
            captured_plain[-1]["login"] = (username, password)

        def send_message(self, msg: Any) -> None:
            captured_plain[-1]["subject"] = str(msg["Subject"])

    monkeypatch.setattr(smtplib, "SMTP_SSL", _FakeSmtpSsl)
    monkeypatch.setattr(smtplib, "SMTP", _FakeSmtpPlain)

    adapter = SmtpEmailAdapter(
        host="smtp.example.com",
        port=465,
        username="mailer@example.com",
        password="synthetic-smtp-secret-xyz",
        from_email="mailer@example.com",
        from_name="ValueSingularity 价值奇点",
        use_ssl=True,
        timeout_seconds=12.5,
    )

    for bad_recipient in (
        "victim@example.com\r\nBcc: evil@example.com",
        "victim@example.com\nSubject: Hijack",
        "victim@example.com\x00",
        "a@example.com, b@example.com",
        "<victim@example.com>",
    ):
        with pytest.raises(EmailDeliveryError):
            await adapter.send_verification_code(
                to_email=bad_recipient,
                code="123456",
                purpose="register",
                expires_minutes=10,
            )
    assert captured_ssl == []

    with pytest.raises(EmailNotConfiguredError):
        SmtpEmailAdapter(
            host="smtp.example.com",
            port=465,
            username="mailer@example.com",
            password="synthetic-smtp-secret-xyz",
            from_email="mailer@example.com",
            from_name="Injected\r\nBcc: evil@example.com",
        )
    assert captured_ssl == []

    with caplog.at_level(logging.INFO):
        await adapter.send_verification_code(
            to_email="recipient@example.com",
            code="654321",
            purpose="register",
            expires_minutes=10,
        )

    assert len(captured_ssl) == 1
    assert captured_ssl[0]["timeout"] == 12.5
    assert captured_ssl[0]["has_context"] is True
    assert "ValueSingularity 价值奇点" in captured_ssl[0]["subject"]
    assert "654321" in captured_ssl[0]["body"]
    assert "synthetic-smtp-secret-xyz" not in caplog.text
    assert "654321" not in caplog.text
    assert "recipient@example.com" not in caplog.text

    starttls_adapter = SmtpEmailAdapter(
        host="smtp.example.com",
        port=587,
        username="mailer@example.com",
        password="synthetic-smtp-secret-xyz",
        from_email="mailer@example.com",
        use_ssl=False,
        timeout_seconds=8.0,
    )
    await starttls_adapter.send_verification_code(
        to_email="recipient@example.com",
        code="112233",
        purpose="reset_password",
        expires_minutes=10,
    )
    assert len(captured_plain) == 1
    assert captured_plain[0]["starttls"] is True
    assert captured_plain[0]["ehlo"] == 2

    class _FailingSmtpSsl(_FakeSmtpSsl):
        def send_message(self, msg: Any) -> None:
            raise smtplib.SMTPException("auth failed for synthetic-smtp-secret-xyz")

    monkeypatch.setattr(smtplib, "SMTP_SSL", _FailingSmtpSsl)
    caplog.clear()
    with caplog.at_level(logging.WARNING), pytest.raises(EmailDeliveryError):
        await adapter.send_verification_code(
            to_email="recipient@example.com",
            code="778899",
            purpose="verify_email",
            expires_minutes=10,
        )
    assert "synthetic-smtp-secret-xyz" not in caplog.text
    assert "778899" not in caplog.text
    assert "recipient@example.com" not in caplog.text


async def test_email_verification_closure_otp_limits_and_smtp_rollback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(settings, "smtp_username", "mailer@example.com")
    monkeypatch.setattr(settings, "smtp_password", "synthetic-smtp-secret")
    monkeypatch.setattr(settings, "auth_require_email_verification", True)

    engine = create_async_engine(settings.test_database_url)
    app = create_app()
    active_sessions: list[AsyncSession] = []
    fake_sender = _FakeEmailSender(active_sessions=active_sessions)

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                active_sessions.append(session)
                try:
                    yield session
                finally:
                    active_sessions.pop()

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_email_sender] = lambda: fake_sender

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            no_code_reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "otp-user@example.com",
                    "password": "strong-password-123",
                    "display_name": "OtpUser",
                },
            )
            assert no_code_reg.status_code == 400

            bad_fmt_reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "otp-user@example.com",
                    "password": "strong-password-123",
                    "display_name": "OtpUser",
                    "verification_code": "123",
                },
            )
            assert bad_fmt_reg.status_code == 422
            assert "strong-password-123" not in bad_fmt_reg.text

            fake_sender.fail = True
            failed_send = await client.post(
                "/api/auth/email-codes",
                json={"email": "otp-user@example.com", "purpose": "register"},
            )
            assert failed_send.status_code == 503
            assert fake_sender.tx_states == [False]

            async with testing_session() as check_session:
                pending_count = await check_session.scalar(
                    select(func.count(EmailCodeRow.id)).where(
                        EmailCodeRow.email == "otp-user@example.com"
                    )
                )
                assert pending_count == 0

            fake_sender.fail = False
            sent_resp = await client.post(
                "/api/auth/email-codes",
                json={"email": "OTP-User@example.com", "purpose": "register"},
            )
            assert sent_resp.status_code == 200
            assert len(fake_sender.sent) == 1
            assert fake_sender.tx_states == [False, False]
            issued_code = fake_sender.sent[-1]["code"]
            assert len(issued_code) == 6
            assert issued_code.isdigit()

            async with testing_session() as check_session:
                code_row = await check_session.scalar(
                    select(EmailCodeRow).where(EmailCodeRow.email == "otp-user@example.com")
                )
                assert code_row is not None
                assert code_row.code_hash != issued_code
                expected_hash = hmac.new(
                    settings.jwt_secret.encode("utf-8"),
                    f"otp-user@example.com:register:{issued_code}".encode(),
                    hashlib.sha256,
                ).hexdigest()
                assert hmac.compare_digest(code_row.code_hash, expected_hash)

            cooldown_resp = await client.post(
                "/api/auth/email-codes",
                json={"email": "otp-user@example.com", "purpose": "register"},
            )
            assert cooldown_resp.status_code == 429
            assert int(cooldown_resp.headers["retry-after"]) >= 1

            wrong_code_reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "otp-user@example.com",
                    "password": "strong-password-123",
                    "display_name": "OtpUser",
                    "verification_code": "000000" if issued_code != "000000" else "999999",
                },
            )
            assert wrong_code_reg.status_code == 400

            ok_reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "otp-user@example.com",
                    "password": "strong-password-123",
                    "display_name": "OtpUser",
                    "verification_code": issued_code,
                },
            )
            assert ok_reg.status_code == 201
            assert ok_reg.json()["user"]["email_verified"] is True

            dup_send = await client.post(
                "/api/auth/email-codes",
                json={"email": "otp-user@example.com", "purpose": "register"},
            )
            assert dup_send.status_code == 409

            for attempt in range(5):
                _ = attempt
                bad_attempt = await client.post(
                    "/api/auth/email-codes",
                    json={"email": "lockout@example.com", "purpose": "register"},
                )
                if bad_attempt.status_code == 200:
                    break
            lock_code = fake_sender.sent[-1]["code"]
            wrong_code = "000000" if lock_code != "000000" else "111111"
            for _ in range(5):
                resp = await client.post(
                    "/api/auth/register",
                    json={
                        "email": "lockout@example.com",
                        "password": "strong-password-123",
                        "display_name": "Lockout",
                        "verification_code": wrong_code,
                    },
                )
                assert resp.status_code == 400
            locked_even_correct = await client.post(
                "/api/auth/register",
                json={
                    "email": "lockout@example.com",
                    "password": "strong-password-123",
                    "display_name": "Lockout",
                    "verification_code": lock_code,
                },
            )
            assert locked_even_correct.status_code == 400

        now = datetime.now(UTC)
        async with testing_session() as sess_a, testing_session() as sess_b:
            repo_a = PostgresEmailVerificationRepository(sess_a)
            repo_b = PostgresEmailVerificationRepository(sess_b)
            race_hash = hmac.new(
                settings.jwt_secret.encode("utf-8"),
                b"race-otp@example.com:register:246810",
                hashlib.sha256,
            ).hexdigest()
            await repo_b.try_issue_code(
                email="race-otp@example.com",
                purpose="register",
                code_hash=race_hash,
                expires_at=now + timedelta(minutes=10),
                created_at=now,
                cooldown_seconds=60,
                hourly_limit=10,
            )
            cached = await sess_a.scalar(
                select(EmailCodeRow.created_at).where(EmailCodeRow.email == "race-otp@example.com")
            )
            assert cached is not None
            assert (
                await repo_b.verify_and_consume(
                    email="race-otp@example.com",
                    purpose="register",
                    code_hash=race_hash,
                    now=now + timedelta(seconds=1),
                )
                is True
            )
            assert (
                await repo_a.verify_and_consume(
                    email="race-otp@example.com",
                    purpose="register",
                    code_hash=race_hash,
                    now=now + timedelta(seconds=2),
                )
                is False
            )

            expired_hash = hmac.new(
                settings.jwt_secret.encode("utf-8"),
                b"expired-otp@example.com:register:135790",
                hashlib.sha256,
            ).hexdigest()
            await repo_b.try_issue_code(
                email="expired-otp@example.com",
                purpose="register",
                code_hash=expired_hash,
                expires_at=now - timedelta(seconds=1),
                created_at=now - timedelta(minutes=11),
                cooldown_seconds=60,
                hourly_limit=10,
            )
            assert (
                await repo_b.verify_and_consume(
                    email="expired-otp@example.com",
                    purpose="register",
                    code_hash=expired_hash,
                    now=now,
                )
                is False
            )

            old_hash = hmac.new(
                settings.jwt_secret.encode("utf-8"),
                b"superseded@example.com:register:111222",
                hashlib.sha256,
            ).hexdigest()
            new_hash = hmac.new(
                settings.jwt_secret.encode("utf-8"),
                b"superseded@example.com:register:333444",
                hashlib.sha256,
            ).hexdigest()
            await repo_b.try_issue_code(
                email="superseded@example.com",
                purpose="register",
                code_hash=old_hash,
                expires_at=now + timedelta(minutes=8),
                created_at=now - timedelta(minutes=2),
                cooldown_seconds=60,
                hourly_limit=10,
            )
            await repo_b.try_issue_code(
                email="superseded@example.com",
                purpose="register",
                code_hash=new_hash,
                expires_at=now + timedelta(minutes=10),
                created_at=now,
                cooldown_seconds=60,
                hourly_limit=10,
            )
            assert (
                await repo_b.verify_and_consume(
                    email="superseded@example.com",
                    purpose="register",
                    code_hash=new_hash,
                    now=now + timedelta(seconds=5),
                )
                is True
            )
            assert (
                await repo_b.verify_and_consume(
                    email="superseded@example.com",
                    purpose="register",
                    code_hash=old_hash,
                    now=now + timedelta(seconds=6),
                )
                is False
            )

        async with testing_session() as rate_session:
            for idx in range(10):
                rate_session.add(
                    EmailCodeRow(
                        email="hourly-cap@example.com",
                        purpose="register",
                        code_hash="a" * 64,
                        expires_at=now + timedelta(minutes=10),
                        created_at=now - timedelta(minutes=50 - idx * 3),
                    )
                )
            await rate_session.commit()

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            hourly_limited = await client.post(
                "/api/auth/email-codes",
                json={"email": "hourly-cap@example.com", "purpose": "register"},
            )
            assert hourly_limited.status_code == 429
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_account_closure_flows_reset_change_profile_verify_delete_and_redaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    engine = create_async_engine(settings.test_database_url)
    app = create_app()
    fake_sender = _FakeEmailSender()

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_email_sender] = lambda: fake_sender

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "closure@example.com",
                    "password": "initial-password-123",
                    "display_name": "Initial User",
                },
            )
            assert reg.status_code == 201
            reg_body = reg.json()
            assert reg_body["user"]["email_verified"] is False
            user_id = UUID(reg_body["user"]["id"])
            token_1 = reg_body["access_token"]
            cookie_1 = reg.cookies.get(settings.refresh_cookie_name)
            assert cookie_1

            bad_profile = await client.patch(
                "/api/auth/me",
                headers={"Authorization": f"Bearer {token_1}"},
                json={"display_name": "   "},
            )
            assert bad_profile.status_code == 422

            patched_profile = await client.patch(
                "/api/auth/me",
                headers={"Authorization": f"Bearer {token_1}"},
                json={"display_name": "  Updated Name  "},
            )
            assert patched_profile.status_code == 200
            assert patched_profile.json()["display_name"] == "Updated Name"

            bad_me_purpose = await client.post(
                "/api/auth/me/email-codes",
                headers={"Authorization": f"Bearer {token_1}"},
                json={"purpose": "register"},
            )
            assert bad_me_purpose.status_code == 422

            send_verify = await client.post(
                "/api/auth/me/email-codes",
                headers={"Authorization": f"Bearer {token_1}"},
                json={"purpose": "verify_email"},
            )
            assert send_verify.status_code == 200
            verify_code = fake_sender.sent[-1]["code"]
            verified_me = await client.post(
                "/api/auth/verify-email",
                headers={"Authorization": f"Bearer {token_1}"},
                json={"verification_code": verify_code},
            )
            assert verified_me.status_code == 200
            assert verified_me.json()["email_verified"] is True

            bad_change_422 = await client.post(
                "/api/auth/password/change",
                headers={"Authorization": f"Bearer {token_1}"},
                json={
                    "current_password": "secret-current-pw-leak-check",
                    "new_password": "pw999",
                },
            )
            assert bad_change_422.status_code == 422
            assert "secret-current-pw-leak-check" not in bad_change_422.text
            assert "pw999" not in bad_change_422.text
            assert bad_change_422.json()["detail"][0]["input"] == "[REDACTED]"
            assert _redact_validation_input({"smtp_password": "smtp-raw-secret"}) == {
                "smtp_password": "[REDACTED]"
            }

            wrong_current = await client.post(
                "/api/auth/password/change",
                headers={"Authorization": f"Bearer {token_1}"},
                json={
                    "current_password": "wrong-current-password",
                    "new_password": "new-password-456",
                },
            )
            assert wrong_current.status_code == 400

            same_pw = await client.post(
                "/api/auth/password/change",
                headers={"Authorization": f"Bearer {token_1}"},
                json={
                    "current_password": "initial-password-123",
                    "new_password": "initial-password-123",
                },
            )
            assert same_pw.status_code == 400

            changed = await client.post(
                "/api/auth/password/change",
                headers={"Authorization": f"Bearer {token_1}"},
                json={
                    "current_password": "initial-password-123",
                    "new_password": "changed-password-456",
                },
            )
            assert changed.status_code == 200
            token_2 = changed.json()["access_token"]
            cookie_2 = changed.cookies.get(settings.refresh_cookie_name)
            assert token_2 and cookie_2 and cookie_2 != cookie_1

            assert (
                await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token_1}"})
            ).status_code == 401
            assert (
                await client.post(
                    "/api/auth/refresh",
                    headers={"Cookie": f"{settings.refresh_cookie_name}={cookie_1}"},
                )
            ).status_code == 401
            assert (
                await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token_2}"})
            ).status_code == 200

            unknown_reset = await client.post(
                "/api/auth/email-codes",
                json={"email": "nobody@example.com", "purpose": "reset_password"},
            )
            assert unknown_reset.status_code == 200
            sent_count_before_known = len(fake_sender.sent)

            inactive_reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "inactive-reset@example.com",
                    "password": "strong-password-123",
                    "display_name": "InactiveReset",
                },
            )
            assert inactive_reg.status_code == 201
            inactive_id = UUID(inactive_reg.json()["user"]["id"])
            async with testing_session() as sess:
                await sess.execute(
                    update(UserRow).where(UserRow.id == inactive_id).values(is_active=False)
                )
                await sess.commit()

            inactive_reset = await client.post(
                "/api/auth/email-codes",
                json={"email": "inactive-reset@example.com", "purpose": "reset_password"},
            )
            assert inactive_reset.status_code == 200
            assert inactive_reset.json() == unknown_reset.json()
            assert len(fake_sender.sent) == sent_count_before_known

            known_reset = await client.post(
                "/api/auth/email-codes",
                json={"email": "closure@example.com", "purpose": "reset_password"},
            )
            assert known_reset.status_code == 200
            assert known_reset.json() == unknown_reset.json()
            assert len(fake_sender.sent) == sent_count_before_known + 1
            reset_code = fake_sender.sent[-1]["code"]

            reset_422 = await client.post(
                "/api/auth/password/reset",
                json={
                    "email": "closure@example.com",
                    "verification_code": "bad",
                    "new_password": "secret-reset-pw-leak-check",
                },
            )
            assert reset_422.status_code == 422
            assert "secret-reset-pw-leak-check" not in reset_422.text

            reset_confirm = await client.post(
                "/api/auth/password/reset",
                json={
                    "email": "closure@example.com",
                    "verification_code": reset_code,
                    "new_password": "reset-password-789",
                },
            )
            assert reset_confirm.status_code == 204
            assert "max-age=0" in reset_confirm.headers.get("set-cookie", "").lower()

            unverified_reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "unverified-reset@example.com",
                    "password": "initial-password-123",
                    "display_name": "UnverifiedReset",
                },
            )
            assert unverified_reg.status_code == 201
            assert unverified_reg.json()["user"]["email_verified"] is False
            await client.post(
                "/api/auth/email-codes",
                json={"email": "unverified-reset@example.com", "purpose": "reset_password"},
            )
            unverified_reset_code = fake_sender.sent[-1]["code"]
            assert (
                await client.post(
                    "/api/auth/password/reset",
                    json={
                        "email": "unverified-reset@example.com",
                        "verification_code": unverified_reset_code,
                        "new_password": "reset-password-999",
                    },
                )
            ).status_code == 204
            unverified_relogin = await client.post(
                "/api/auth/login",
                json={"email": "unverified-reset@example.com", "password": "reset-password-999"},
            )
            assert unverified_relogin.status_code == 200
            assert unverified_relogin.json()["user"]["email_verified"] is True

            assert (
                await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token_2}"})
            ).status_code == 401
            assert (
                await client.post(
                    "/api/auth/refresh",
                    headers={"Cookie": f"{settings.refresh_cookie_name}={cookie_2}"},
                )
            ).status_code == 401

            relogin = await client.post(
                "/api/auth/login",
                json={"email": "closure@example.com", "password": "reset-password-789"},
            )
            assert relogin.status_code == 200
            token_3 = relogin.json()["access_token"]
            cookie_3 = relogin.cookies.get(settings.refresh_cookie_name)
            assert cookie_3

            async with testing_session() as seed_session:
                seed_session.add(WatchlistItem(user_id=user_id, code="600519", name="贵州茅台"))
                seed_session.add(
                    JournalEntry(
                        user_id=user_id,
                        code="600519",
                        name="贵州茅台",
                        action="buy",
                        reason="现金流充沛",
                        falsify_condition="连续两年自由现金流转负",
                    )
                )
                seed_session.add(UserEvent(user_id=user_id, type="login", code=None))
                seed_session.add(
                    Setting(
                        user_id=user_id,
                        key="ai_prefs",
                        value={"prefer_rule_only": True},
                    )
                )
                await seed_session.commit()

            monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
            monkeypatch.setattr(settings, "smtp_username", "mailer@example.com")
            monkeypatch.setattr(settings, "smtp_password", "synthetic-smtp-secret")
            monkeypatch.setattr(settings, "auth_require_email_verification", True)

            delete_422 = await client.post(
                "/api/auth/me/delete",
                headers={"Authorization": f"Bearer {token_3}"},
                json={
                    "password": "secret-delete-pw-leak-check",
                    "verification_code": "bad",
                },
            )
            assert delete_422.status_code == 422
            assert "secret-delete-pw-leak-check" not in delete_422.text

            wrong_pw_delete = await client.post(
                "/api/auth/me/delete",
                headers={"Authorization": f"Bearer {token_3}"},
                json={"password": "wrong-password-xyz"},
            )
            assert wrong_pw_delete.status_code == 400

            missing_otp_delete = await client.post(
                "/api/auth/me/delete",
                headers={"Authorization": f"Bearer {token_3}"},
                json={"password": "reset-password-789"},
            )
            assert missing_otp_delete.status_code == 400

            send_delete_code = await client.post(
                "/api/auth/me/email-codes",
                headers={"Authorization": f"Bearer {token_3}"},
                json={"purpose": "delete_account"},
            )
            assert send_delete_code.status_code == 200
            delete_code = fake_sender.sent[-1]["code"]

            deleted = await client.post(
                "/api/auth/me/delete",
                headers={"Authorization": f"Bearer {token_3}"},
                json={
                    "password": "reset-password-789",
                    "verification_code": delete_code,
                },
            )
            assert deleted.status_code == 204
            assert "max-age=0" in deleted.headers.get("set-cookie", "").lower()

            assert (
                await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token_3}"})
            ).status_code == 401
            assert (
                await client.post(
                    "/api/auth/refresh",
                    headers={"Cookie": f"{settings.refresh_cookie_name}={cookie_3}"},
                )
            ).status_code == 401

        async with testing_session() as verify_session:
            assert await verify_session.get(UserRow, user_id) is None
            assert (
                await verify_session.scalar(
                    select(func.count(RefreshTokenRow.id)).where(RefreshTokenRow.user_id == user_id)
                )
                == 0
            )
            assert (
                await verify_session.scalar(
                    select(func.count(WatchlistItem.code)).where(WatchlistItem.user_id == user_id)
                )
                == 0
            )
            assert (
                await verify_session.scalar(
                    select(func.count(JournalEntry.id)).where(JournalEntry.user_id == user_id)
                )
                == 0
            )
            assert (
                await verify_session.scalar(
                    select(func.count(UserEvent.id)).where(UserEvent.user_id == user_id)
                )
                == 0
            )
            assert (
                await verify_session.scalar(
                    select(func.count(Setting.key)).where(Setting.user_id == user_id)
                )
                == 0
            )
            assert (
                await verify_session.scalar(
                    select(func.count(EmailCodeRow.id)).where(
                        EmailCodeRow.email == "closure@example.com"
                    )
                )
                == 0
            )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_settings_smtp_validation_and_runtime_fallback(
    db_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, auth_require_email_verification=True)

    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            smtp_host="smtp.example.com",
            smtp_username="ses-apikey-user",
            smtp_password="synthetic-smtp-password",
        )

    valid_ses = Settings(
        _env_file=None,
        smtp_host="smtp.example.com",
        smtp_username="ses-apikey-user",
        smtp_password="synthetic-smtp-password",
        smtp_from_email="noreply@example.com",
    )
    assert valid_ses.smtp_configured is True

    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            smtp_host="   ",
            smtp_username="mailer@example.com",
            smtp_password="synthetic-smtp-password",
        )

    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            smtp_host="smtp.example.com",
            smtp_username="mailer@example.com",
            smtp_password="synthetic-smtp-password",
            smtp_from_name="   ",
        )

    app = create_app()
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(settings, "smtp_username", "ses-apikey-no-at")
    monkeypatch.setattr(settings, "smtp_password", "synthetic-smtp-password")
    monkeypatch.setattr(settings, "smtp_from_email", None)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as raw_client:
        fallback_resp = await raw_client.post(
            "/api/auth/email-codes",
            json={"email": "fallback@example.com", "purpose": "register"},
        )
        assert fallback_resp.status_code == 503
    del db_client


async def test_reset_password_anti_enumeration_parity_and_delivery_error_suppression(
    caplog: pytest.LogCaptureFixture,
) -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    engine = create_async_engine(settings.test_database_url)
    app = create_app()
    fake_sender = _FakeEmailSender()

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_email_sender] = lambda: fake_sender

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            active_reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "active-parity@example.com",
                    "password": "strong-password-123",
                    "display_name": "ActiveParity",
                },
            )
            assert active_reg.status_code == 201

            inactive_reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "inactive-parity@example.com",
                    "password": "strong-password-123",
                    "display_name": "InactiveParity",
                },
            )
            assert inactive_reg.status_code == 201
            inactive_id = UUID(inactive_reg.json()["user"]["id"])

            async with testing_session() as sess:
                await sess.execute(
                    update(UserRow).where(UserRow.id == inactive_id).values(is_active=False)
                )
                await sess.commit()

            fake_sender.delay_seconds = 0.05
            t0 = time.monotonic()
            r_unknown_1 = await client.post(
                "/api/auth/email-codes",
                json={"email": "unknown-parity@example.com", "purpose": "reset_password"},
            )
            dt_unknown = time.monotonic() - t0

            t1 = time.monotonic()
            r_active_1 = await client.post(
                "/api/auth/email-codes",
                json={"email": "active-parity@example.com", "purpose": "reset_password"},
            )
            dt_active = time.monotonic() - t1

            r_inactive_1 = await client.post(
                "/api/auth/email-codes",
                json={"email": "inactive-parity@example.com", "purpose": "reset_password"},
            )
            fake_sender.delay_seconds = 0.0

            assert r_unknown_1.status_code == 200
            assert r_active_1.status_code == 200
            assert r_inactive_1.status_code == 200
            assert r_unknown_1.json() == r_active_1.json() == r_inactive_1.json()
            assert abs(dt_active - dt_unknown) < 0.15

            r_unknown_2 = await client.post(
                "/api/auth/email-codes",
                json={"email": "unknown-parity@example.com", "purpose": "reset_password"},
            )
            r_active_2 = await client.post(
                "/api/auth/email-codes",
                json={"email": "active-parity@example.com", "purpose": "reset_password"},
            )
            assert r_unknown_2.status_code == 429
            assert r_active_2.status_code == 429
            assert int(r_unknown_2.headers["retry-after"]) >= 1
            assert int(r_active_2.headers["retry-after"]) >= 1

            now = datetime.now(UTC)
            async with testing_session() as seed_sess:
                for addr in ("cap-unknown@example.com", "active-parity@example.com"):
                    for idx in range(10):
                        seed_sess.add(
                            EmailCodeRow(
                                email=addr,
                                purpose="reset_password",
                                code_hash="b" * 64,
                                expires_at=now + timedelta(minutes=10),
                                created_at=now - timedelta(minutes=50 - idx * 3),
                            )
                        )
                await seed_sess.commit()

            cap_unknown = await client.post(
                "/api/auth/email-codes",
                json={"email": "cap-unknown@example.com", "purpose": "reset_password"},
            )
            cap_active = await client.post(
                "/api/auth/email-codes",
                json={"email": "active-parity@example.com", "purpose": "reset_password"},
            )
            assert cap_unknown.status_code == 429
            assert cap_active.status_code == 429

            delivery_reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "delivery-fail@example.com",
                    "password": "strong-password-123",
                    "display_name": "DeliveryFail",
                },
            )
            assert delivery_reg.status_code == 201
            fake_sender.fail = True
            caplog.clear()
            with caplog.at_level(logging.WARNING):
                delivery_resp = await client.post(
                    "/api/auth/email-codes",
                    json={"email": "delivery-fail@example.com", "purpose": "reset_password"},
                )
            assert delivery_resp.status_code == 200
            assert "delivery-fail@example.com" not in caplog.text
            assert "EmailDeliveryError" in caplog.text
            async with testing_session() as check_sess:
                assert (
                    await check_sess.scalar(
                        select(func.count(EmailCodeRow.id)).where(
                            EmailCodeRow.email == "delivery-fail@example.com"
                        )
                    )
                    == 0
                )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_concurrent_burst_otp_issuance_and_cancel_cleanup() -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    concurrency = 5
    engine = create_async_engine(settings.test_database_url, pool_size=concurrency, max_overflow=0)
    app = create_app()
    fake_sender = _FakeEmailSender()

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
        async with AsyncExitStack() as stack:
            warm_sessions = [
                await stack.enter_async_context(testing_session()) for _ in range(concurrency)
            ]
            await asyncio.gather(*(s.execute(text("SELECT 1")) for s in warm_sessions))

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_email_sender] = lambda: fake_sender

        async def fire_otp() -> Response:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                return await client.post(
                    "/api/auth/email-codes",
                    json={"email": "burst-otp@example.com", "purpose": "register"},
                )

        responses = await asyncio.gather(*(fire_otp() for _ in range(concurrency)))
        assert sum(1 for r in responses if r.status_code == 200) == 1
        assert sum(1 for r in responses if r.status_code == 429) == concurrency - 1
        assert len(fake_sender.sent) == 1

        async with testing_session() as check_sess:
            assert (
                await check_sess.scalar(
                    select(func.count(EmailCodeRow.id)).where(
                        EmailCodeRow.email == "burst-otp@example.com"
                    )
                )
                == 1
            )

        fake_sender.fail_exc = asyncio.CancelledError()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            with pytest.raises(asyncio.CancelledError):
                await client.post(
                    "/api/auth/email-codes",
                    json={"email": "cancel-otp@example.com", "purpose": "register"},
                )

        async with testing_session() as check_sess:
            assert (
                await check_sess.scalar(
                    select(func.count(EmailCodeRow.id)).where(
                        EmailCodeRow.email == "cancel-otp@example.com"
                    )
                )
                == 0
            )

        fake_sender.fail_exc = None
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            retry_resp = await client.post(
                "/api/auth/email-codes",
                json={"email": "cancel-otp@example.com", "purpose": "register"},
            )
            assert retry_resp.status_code == 200
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_multi_device_session_family_isolation_and_concurrent_auth_lifecycle() -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    engine = create_async_engine(settings.test_database_url, pool_size=6, max_overflow=0)
    app = create_app()
    fake_sender = _FakeEmailSender()

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_email_sender] = lambda: fake_sender

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "multidev@example.com",
                    "password": "strong-password-123",
                    "display_name": "MultiDev",
                },
            )
            assert reg.status_code == 201
            cookie_d1_a = reg.cookies.get(settings.refresh_cookie_name)
            assert cookie_d1_a

            login_d2 = await client.post(
                "/api/auth/login",
                json={"email": "multidev@example.com", "password": "strong-password-123"},
            )
            assert login_d2.status_code == 200
            token_d2 = login_d2.json()["access_token"]
            cookie_d2_a = login_d2.cookies.get(settings.refresh_cookie_name)
            assert cookie_d2_a

            login_d3 = await client.post(
                "/api/auth/login",
                json={"email": "multidev@example.com", "password": "strong-password-123"},
            )
            assert login_d3.status_code == 200
            cookie_d3_logout = login_d3.cookies.get(settings.refresh_cookie_name)
            assert cookie_d3_logout

            logout_d3 = await client.post(
                "/api/auth/logout",
                headers={"Cookie": f"{settings.refresh_cookie_name}={cookie_d3_logout}"},
            )
            assert logout_d3.status_code == 204
            stale_logout_refresh = await client.post(
                "/api/auth/refresh",
                headers={"Cookie": f"{settings.refresh_cookie_name}={cookie_d3_logout}"},
            )
            assert stale_logout_refresh.status_code == 401

            rot_d1 = await client.post(
                "/api/auth/refresh",
                headers={"Cookie": f"{settings.refresh_cookie_name}={cookie_d1_a}"},
            )
            assert rot_d1.status_code == 200
            cookie_d1_b = rot_d1.cookies.get(settings.refresh_cookie_name)
            assert cookie_d1_b

            replay_d1 = await client.post(
                "/api/auth/refresh",
                headers={"Cookie": f"{settings.refresh_cookie_name}={cookie_d1_a}"},
            )
            assert replay_d1.status_code == 401
            assert (
                await client.post(
                    "/api/auth/refresh",
                    headers={"Cookie": f"{settings.refresh_cookie_name}={cookie_d1_b}"},
                )
            ).status_code == 401

            rot_d2 = await client.post(
                "/api/auth/refresh",
                headers={"Cookie": f"{settings.refresh_cookie_name}={cookie_d2_a}"},
            )
            assert rot_d2.status_code == 200
            cookie_d2_b = rot_d2.cookies.get(settings.refresh_cookie_name)
            assert cookie_d2_b

            changed = await client.post(
                "/api/auth/password/change",
                headers={"Authorization": f"Bearer {token_d2}"},
                json={
                    "current_password": "strong-password-123",
                    "new_password": "changed-password-456",
                },
            )
            assert changed.status_code == 200
            cookie_changed = changed.cookies.get(settings.refresh_cookie_name)
            token_changed = changed.json()["access_token"]
            assert cookie_changed

            stale_pw_refresh = await client.post(
                "/api/auth/refresh",
                headers={"Cookie": f"{settings.refresh_cookie_name}={cookie_d2_b}"},
            )
            assert stale_pw_refresh.status_code == 401

            still_valid_after_stale = await client.post(
                "/api/auth/refresh",
                headers={"Cookie": f"{settings.refresh_cookie_name}={cookie_changed}"},
            )
            assert still_valid_after_stale.status_code == 200
            cookie_race_chg = still_valid_after_stale.cookies.get(settings.refresh_cookie_name)
            assert cookie_race_chg

        async with (
            AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c1,
            AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c2,
        ):
            r_refresh, r_chg = await asyncio.gather(
                c1.post(
                    "/api/auth/refresh",
                    headers={"Cookie": f"{settings.refresh_cookie_name}={cookie_race_chg}"},
                ),
                c2.post(
                    "/api/auth/password/change",
                    headers={"Authorization": f"Bearer {token_changed}"},
                    json={
                        "current_password": "changed-password-456",
                        "new_password": "raced-password-789",
                    },
                ),
            )
            assert r_chg.status_code == 200
            assert r_refresh.status_code in (200, 401)
            cookie_after_chg_race = r_chg.cookies.get(settings.refresh_cookie_name)
            assert cookie_after_chg_race
            if r_refresh.status_code == 200:
                rotated_cookie = r_refresh.cookies.get(settings.refresh_cookie_name)
                assert rotated_cookie
                assert (
                    await c1.post(
                        "/api/auth/refresh",
                        headers={"Cookie": f"{settings.refresh_cookie_name}={rotated_cookie}"},
                    )
                ).status_code == 401
            post_chg_valid = await c2.post(
                "/api/auth/refresh",
                headers={"Cookie": f"{settings.refresh_cookie_name}={cookie_after_chg_race}"},
            )
            assert post_chg_valid.status_code == 200
            cookie_before_reset = post_chg_valid.cookies.get(settings.refresh_cookie_name)
            assert cookie_before_reset

            send_rst = await c1.post(
                "/api/auth/email-codes",
                json={"email": "multidev@example.com", "purpose": "reset_password"},
            )
            assert send_rst.status_code == 200
            rst_code = fake_sender.sent[-1]["code"]
            r_ref2, r_rst = await asyncio.gather(
                c1.post(
                    "/api/auth/refresh",
                    headers={"Cookie": f"{settings.refresh_cookie_name}={cookie_before_reset}"},
                ),
                c2.post(
                    "/api/auth/password/reset",
                    json={
                        "email": "multidev@example.com",
                        "verification_code": rst_code,
                        "new_password": "reset-password-000",
                    },
                ),
            )
            assert r_rst.status_code == 204
            assert r_ref2.status_code in (200, 401)
            if r_ref2.status_code == 200:
                r_ref2_cookie = r_ref2.cookies.get(settings.refresh_cookie_name)
                assert r_ref2_cookie
                assert (
                    await c1.post(
                        "/api/auth/refresh",
                        headers={"Cookie": f"{settings.refresh_cookie_name}={r_ref2_cookie}"},
                    )
                ).status_code == 401

            relogin = await c1.post(
                "/api/auth/login",
                json={"email": "multidev@example.com", "password": "reset-password-000"},
            )
            assert relogin.status_code == 200
            del_token = relogin.json()["access_token"]
            del_cookie = relogin.cookies.get(settings.refresh_cookie_name)
            assert del_cookie

            r_ref3, r_del = await asyncio.gather(
                c1.post(
                    "/api/auth/refresh",
                    headers={"Cookie": f"{settings.refresh_cookie_name}={del_cookie}"},
                ),
                c2.post(
                    "/api/auth/me/delete",
                    headers={"Authorization": f"Bearer {del_token}"},
                    json={"password": "reset-password-000"},
                ),
            )
            assert r_del.status_code == 204
            assert r_ref3.status_code in (200, 401)
            if r_ref3.status_code == 200:
                ref3_cookie = r_ref3.cookies.get(settings.refresh_cookie_name)
                assert ref3_cookie
                assert (
                    await c1.post(
                        "/api/auth/refresh",
                        headers={"Cookie": f"{settings.refresh_cookie_name}={ref3_cookie}"},
                    )
                ).status_code == 401

        async with testing_session() as fk_session:
            token_repo = PostgresRefreshTokenRepository(fk_session)
            with pytest.raises(UserNotFoundError):
                await token_repo.create(
                    user_id=UUID("99999999-9999-9999-9999-999999999999"),
                    token_hash="f" * 64,
                    expires_at=datetime.now(UTC) + timedelta(days=1),
                    user_agent=None,
                )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_phone_only_delete_already_verified_guard_inactive_jwt_403_and_raw_422_redaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    engine = create_async_engine(settings.test_database_url)
    app = create_app()
    fake_sender = _FakeEmailSender()

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_email_sender] = lambda: fake_sender

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            form_422 = await client.post(
                "/api/auth/login",
                data={"email": "a@example.com", "password": "raw-form-secret-xyz"},
            )
            assert form_422.status_code == 422
            assert "raw-form-secret-xyz" not in form_422.text
            assert form_422.json()["detail"][0]["input"] == "[REDACTED]"

            raw_json_422 = await client.post(
                "/api/auth/register",
                json=["raw-array-secret-abc"],
            )
            assert raw_json_422.status_code == 422
            assert "raw-array-secret-abc" not in raw_json_422.text
            assert raw_json_422.json()["detail"][0]["input"] == "[REDACTED]"

            reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "guard@example.com",
                    "password": "strong-password-123",
                    "display_name": "GuardUser",
                },
            )
            assert reg.status_code == 201
            token = reg.json()["access_token"]
            guard_id = UUID(reg.json()["user"]["id"])

            send_verify = await client.post(
                "/api/auth/me/email-codes",
                headers={"Authorization": f"Bearer {token}"},
                json={"purpose": "verify_email"},
            )
            assert send_verify.status_code == 200
            verify_code = fake_sender.sent[-1]["code"]
            verified = await client.post(
                "/api/auth/verify-email",
                headers={"Authorization": f"Bearer {token}"},
                json={"verification_code": verify_code},
            )
            assert verified.status_code == 200

            sent_count = len(fake_sender.sent)
            repeat_send = await client.post(
                "/api/auth/me/email-codes",
                headers={"Authorization": f"Bearer {token}"},
                json={"purpose": "verify_email"},
            )
            assert repeat_send.status_code == 400
            assert "已完成验证" in repeat_send.json()["detail"]
            assert len(fake_sender.sent) == sent_count

            repeat_verify = await client.post(
                "/api/auth/verify-email",
                headers={"Authorization": f"Bearer {token}"},
                json={"verification_code": "123456"},
            )
            assert repeat_verify.status_code == 400
            assert "已完成验证" in repeat_verify.json()["detail"]

            async with testing_session() as sess:
                await sess.execute(
                    update(UserRow).where(UserRow.id == guard_id).values(is_active=False)
                )
                await sess.commit()

            inactive_me = await client.get(
                "/api/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert inactive_me.status_code == 403

            async with testing_session() as sess:
                await sess.execute(
                    update(UserRow)
                    .where(UserRow.id == guard_id)
                    .values(token_version=UserRow.token_version + 1)
                )
                await sess.commit()

            stale_tv_me = await client.get(
                "/api/auth/me",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert stale_tv_me.status_code == 401

            phone_user = await client.post(
                "/api/auth/register",
                json={
                    "email": "phone-placeholder@example.com",
                    "password": "phone-password-123",
                    "display_name": "PhoneOnly",
                },
            )
            assert phone_user.status_code == 201
            phone_id = UUID(phone_user.json()["user"]["id"])
            phone_token = phone_user.json()["access_token"]

            async with testing_session() as sess:
                await sess.execute(
                    update(UserRow)
                    .where(UserRow.id == phone_id)
                    .values(email=None, phone="+8613800138000")
                )
                await sess.commit()

            monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
            monkeypatch.setattr(settings, "smtp_username", "mailer@example.com")
            monkeypatch.setattr(settings, "smtp_password", "synthetic-smtp-secret")
            monkeypatch.setattr(settings, "auth_require_email_verification", True)

            del_phone = await client.post(
                "/api/auth/me/delete",
                headers={"Authorization": f"Bearer {phone_token}"},
                json={"password": "phone-password-123"},
            )
            assert del_phone.status_code == 204
            async with testing_session() as verify_sess:
                assert await verify_sess.get(UserRow, phone_id) is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_no_idle_in_transaction_during_argon2_or_auth_and_concurrent_login_delete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    engine = create_async_engine(settings.test_database_url)
    app = create_app()
    fake_sender = _FakeEmailSender()
    active_sessions: list[AsyncSession] = []

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                active_sessions.append(session)
                try:
                    yield session
                finally:
                    active_sessions.pop()

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_email_sender] = lambda: fake_sender

        real_hasher = get_password_hasher()
        tx_during_argon2: list[tuple[str, bool]] = []
        delete_user_on_next_verify: list[str] = []

        orig_hash = real_hasher.hash
        orig_verify = real_hasher.verify

        async def spy_hash(password: str) -> str:
            if active_sessions:
                tx_during_argon2.append(("hash", active_sessions[-1].in_transaction()))
            return await orig_hash(password)

        async def spy_verify(password: str, password_hash: str) -> bool:
            if active_sessions:
                tx_during_argon2.append(("verify", active_sessions[-1].in_transaction()))
            if delete_user_on_next_verify:
                target_email = delete_user_on_next_verify.pop()
                async with testing_session() as killer:
                    await killer.execute(
                        text("DELETE FROM users WHERE email = :email"),
                        {"email": target_email},
                    )
                    await killer.commit()
            return await orig_verify(password, password_hash)

        monkeypatch.setattr(real_hasher, "hash", spy_hash)
        monkeypatch.setattr(real_hasher, "verify", spy_verify)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "tx-idle@example.com",
                    "password": "strong-password-123",
                    "display_name": "TxIdle",
                },
            )
            assert reg.status_code == 201
            token = reg.json()["access_token"]

            login = await client.post(
                "/api/auth/login",
                json={"email": "tx-idle@example.com", "password": "strong-password-123"},
            )
            assert login.status_code == 200

            chg = await client.post(
                "/api/auth/password/change",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "current_password": "strong-password-123",
                    "new_password": "strong-password-456",
                },
            )
            assert chg.status_code == 200
            token_2 = chg.json()["access_token"]

            send_rst = await client.post(
                "/api/auth/email-codes",
                json={"email": "tx-idle@example.com", "purpose": "reset_password"},
            )
            assert send_rst.status_code == 200
            rst_code = fake_sender.sent[-1]["code"]
            rst = await client.post(
                "/api/auth/password/reset",
                json={
                    "email": "tx-idle@example.com",
                    "verification_code": rst_code,
                    "new_password": "strong-password-789",
                },
            )
            assert rst.status_code == 204

            login_2 = await client.post(
                "/api/auth/login",
                json={"email": "tx-idle@example.com", "password": "strong-password-789"},
            )
            assert login_2.status_code == 200
            token_3 = login_2.json()["access_token"]

            me_resp = await client.get(
                "/api/auth/me",
                headers={"Authorization": f"Bearer {token_3}"},
            )
            assert me_resp.status_code == 200
            assert token_2 != token_3

            delete_me = await client.post(
                "/api/auth/me/delete",
                headers={"Authorization": f"Bearer {token_3}"},
                json={"password": "strong-password-789"},
            )
            assert delete_me.status_code == 204

            assert tx_during_argon2
            assert all(in_tx is False for _, in_tx in tx_during_argon2)

            raced_reg = await client.post(
                "/api/auth/register",
                json={
                    "email": "deleted-during-login@example.com",
                    "password": "strong-password-123",
                    "display_name": "RacedLogin",
                },
            )
            assert raced_reg.status_code == 201
            delete_user_on_next_verify.append("deleted-during-login@example.com")
            raced_login = await client.post(
                "/api/auth/login",
                json={
                    "email": "deleted-during-login@example.com",
                    "password": "strong-password-123",
                },
            )
            assert raced_login.status_code == 401
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
