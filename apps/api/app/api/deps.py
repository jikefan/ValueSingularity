"""Dependency wiring. One place decides which adapter backs each service."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.email.smtp import SmtpEmailAdapter, UnconfiguredEmailSender
from app.adapters.llm.openai_compatible import OpenAiCompatibleLlmAdapter
from app.adapters.notifications.webhook import HttpxWebhookNotifier
from app.adapters.postgres.ai import PostgresAiRepository
from app.adapters.postgres.alert import PostgresAlertRepository, PostgresSettingsRepository
from app.adapters.postgres.event import PostgresEventRepository
from app.adapters.postgres.journal import PostgresJournalRepository
from app.adapters.postgres.market import PostgresMarketRepository, PostgresStockMetaRepository
from app.adapters.postgres.snapshot import PostgresStockSnapshotRepository
from app.adapters.postgres.user import (
    PostgresEmailVerificationRepository,
    PostgresRefreshTokenRepository,
    PostgresUserRepository,
)
from app.adapters.postgres.watchlist import PostgresWatchlistRepository
from app.adapters.security.password import Argon2PasswordHasher
from app.adapters.security.token import JwtTokenCodec
from app.db.session import DatabaseUnavailableError, check_db_health, dispose_db, get_db
from app.domain.errors import EmailNotConfiguredError
from app.domain.models import AuthenticatedUser
from app.domain.ports import EmailSenderPort, LlmCompanionPort, WebhookNotifierPort
from app.services.ai import AiPartnerService
from app.services.alerts import AlertScanService
from app.services.auth import AuthService, InactiveUserError, InvalidAccessTokenError
from app.services.event import EventService
from app.services.journal import JournalService
from app.services.market import MarketService
from app.services.stock import StockService
from app.services.watchlist import WatchlistService
from app.settings import settings

bearer_scheme = HTTPBearer(auto_error=False)
DbSessionDep = Annotated[AsyncSession, Depends(get_db)]


def get_market_service(session: DbSessionDep) -> MarketService:
    return MarketService(PostgresMarketRepository(session))


@lru_cache
def get_password_hasher() -> Argon2PasswordHasher:
    return Argon2PasswordHasher()


@lru_cache
def get_token_codec() -> JwtTokenCodec:
    return JwtTokenCodec(
        secret=settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
        access_ttl_minutes=settings.access_token_ttl_minutes,
    )


def get_email_sender() -> EmailSenderPort:
    if settings.smtp_configured:
        assert settings.smtp_host is not None
        assert settings.smtp_username is not None
        assert settings.smtp_password is not None
        try:
            return SmtpEmailAdapter(
                host=settings.smtp_host,
                port=settings.smtp_port,
                username=settings.smtp_username,
                password=settings.smtp_password,
                from_email=settings.smtp_from_email or settings.smtp_username,
                from_name=settings.smtp_from_name,
                use_ssl=settings.smtp_use_ssl,
                timeout_seconds=settings.smtp_timeout_seconds,
            )
        except EmailNotConfiguredError:
            return UnconfiguredEmailSender()
    return UnconfiguredEmailSender()


EmailSenderDep = Annotated[EmailSenderPort, Depends(get_email_sender)]


def get_auth_service(
    session: DbSessionDep,
    email_sender: EmailSenderDep,
) -> AuthService:
    return AuthService(
        users=PostgresUserRepository(session),
        refresh_tokens=PostgresRefreshTokenRepository(session),
        hasher=get_password_hasher(),
        tokens=get_token_codec(),
        refresh_ttl_days=settings.refresh_token_ttl_days,
        email_codes=PostgresEmailVerificationRepository(session),
        email_sender=email_sender,
        otp_secret=settings.jwt_secret,
        require_email_verification=settings.effective_require_email_verification,
        smtp_configured=settings.smtp_configured,
    )


def get_watchlist_service(session: DbSessionDep) -> WatchlistService:
    return WatchlistService(PostgresWatchlistRepository(session))


def get_stock_service(session: DbSessionDep) -> StockService:
    return StockService(
        PostgresStockMetaRepository(session),
        PostgresStockSnapshotRepository(session),
    )


def get_journal_service(session: DbSessionDep) -> JournalService:
    return JournalService(
        repository=PostgresJournalRepository(session),
        stock_meta=PostgresStockMetaRepository(session),
        snapshot_repo=PostgresStockSnapshotRepository(session),
        market_repo=PostgresMarketRepository(session),
    )


def get_event_service(session: DbSessionDep) -> EventService:
    return EventService(PostgresEventRepository(session))


@lru_cache
def get_webhook_notifier() -> WebhookNotifierPort:
    return HttpxWebhookNotifier()


WebhookNotifierDep = Annotated[WebhookNotifierPort, Depends(get_webhook_notifier)]


def get_alert_service(
    session: DbSessionDep,
    webhook_notifier: WebhookNotifierDep,
) -> AlertScanService:
    return AlertScanService(
        watchlist_repo=PostgresWatchlistRepository(session),
        journal_repo=PostgresJournalRepository(session),
        snapshot_repo=PostgresStockSnapshotRepository(session),
        settings_repo=PostgresSettingsRepository(session),
        alert_repo=PostgresAlertRepository(session),
        webhook_notifier=webhook_notifier,
    )


@lru_cache
def get_llm_companion() -> LlmCompanionPort:
    return OpenAiCompatibleLlmAdapter()


LlmCompanionDep = Annotated[LlmCompanionPort, Depends(get_llm_companion)]


def get_ai_partner_service(
    session: DbSessionDep,
    llm_companion: LlmCompanionDep,
) -> AiPartnerService:
    return AiPartnerService(
        ai_repo=PostgresAiRepository(session),
        stock_meta=PostgresStockMetaRepository(session),
        snapshot_repo=PostgresStockSnapshotRepository(session),
        event_repo=PostgresEventRepository(session),
        llm_client=llm_companion,
        platform_llm_base_url=settings.llm_base_url,
        platform_llm_api_key=settings.llm_api_key,
        platform_llm_model=settings.llm_model,
        llm_timeout_seconds=settings.llm_timeout_seconds,
    )


AiPartnerServiceDep = Annotated[AiPartnerService, Depends(get_ai_partner_service)]
AlertServiceDep = Annotated[AlertScanService, Depends(get_alert_service)]
MarketServiceDep = Annotated[MarketService, Depends(get_market_service)]
AuthServiceDep = Annotated[AuthService, Depends(get_auth_service)]
WatchlistServiceDep = Annotated[WatchlistService, Depends(get_watchlist_service)]
StockServiceDep = Annotated[StockService, Depends(get_stock_service)]
JournalServiceDep = Annotated[JournalService, Depends(get_journal_service)]
EventServiceDep = Annotated[EventService, Depends(get_event_service)]


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    auth_service: AuthServiceDep,
) -> AuthenticatedUser:
    if credentials is None or credentials.scheme.lower() != "bearer" or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="请先登录",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return await auth_service.authenticate_access_token(credentials.credentials)
    except InactiveUserError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="账号已停用",
        ) from exc
    except InvalidAccessTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="登录已失效，请重新登录",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


CurrentUserDep = Annotated[AuthenticatedUser, Depends(get_current_user)]


async def verify_db(session: DbSessionDep) -> None:
    await check_db_health(session)


async def close_db_pool() -> None:
    await dispose_db()


__all__ = [
    "AiPartnerServiceDep",
    "AlertServiceDep",
    "AuthServiceDep",
    "CurrentUserDep",
    "DatabaseUnavailableError",
    "DbSessionDep",
    "EmailSenderDep",
    "EventServiceDep",
    "JournalServiceDep",
    "LlmCompanionDep",
    "MarketServiceDep",
    "StockServiceDep",
    "WatchlistServiceDep",
    "bearer_scheme",
    "close_db_pool",
    "get_ai_partner_service",
    "get_alert_service",
    "get_auth_service",
    "get_current_user",
    "get_db",
    "get_email_sender",
    "get_event_service",
    "get_journal_service",
    "get_llm_companion",
    "get_market_service",
    "get_password_hasher",
    "get_stock_service",
    "get_token_codec",
    "get_watchlist_service",
    "get_webhook_notifier",
    "verify_db",
]
