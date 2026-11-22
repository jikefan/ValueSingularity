"""Dependency wiring. One place decides which adapter backs each service."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.memory.market import MemoryMarketRepository
from app.adapters.postgres.user import PostgresRefreshTokenRepository, PostgresUserRepository
from app.adapters.postgres.watchlist import PostgresWatchlistRepository
from app.adapters.security.password import Argon2PasswordHasher
from app.adapters.security.token import JwtTokenCodec
from app.db.session import DatabaseUnavailableError, check_db_health, dispose_db, get_db
from app.domain.models import AuthenticatedUser
from app.services.auth import AuthService, InvalidAccessTokenError
from app.services.market import MarketService
from app.services.watchlist import WatchlistService
from app.settings import settings

bearer_scheme = HTTPBearer(auto_error=False)
DbSessionDep = Annotated[AsyncSession, Depends(get_db)]


@lru_cache
def get_market_service() -> MarketService:
    return MarketService(MemoryMarketRepository())


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


def get_auth_service(session: DbSessionDep) -> AuthService:
    return AuthService(
        users=PostgresUserRepository(session),
        refresh_tokens=PostgresRefreshTokenRepository(session),
        hasher=get_password_hasher(),
        tokens=get_token_codec(),
        refresh_ttl_days=settings.refresh_token_ttl_days,
    )


def get_watchlist_service(session: DbSessionDep) -> WatchlistService:
    return WatchlistService(PostgresWatchlistRepository(session))


MarketServiceDep = Annotated[MarketService, Depends(get_market_service)]
AuthServiceDep = Annotated[AuthService, Depends(get_auth_service)]
WatchlistServiceDep = Annotated[WatchlistService, Depends(get_watchlist_service)]


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
    "AuthServiceDep",
    "CurrentUserDep",
    "DatabaseUnavailableError",
    "DbSessionDep",
    "MarketServiceDep",
    "WatchlistServiceDep",
    "bearer_scheme",
    "close_db_pool",
    "get_auth_service",
    "get_current_user",
    "get_db",
    "get_market_service",
    "get_password_hasher",
    "get_token_codec",
    "get_watchlist_service",
    "verify_db",
]
