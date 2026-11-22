"""Async engine and session wiring using psycopg 3 and SQLAlchemy AsyncSession."""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.settings import settings

engine: AsyncEngine = create_async_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=5,
)

AsyncSessionLocal = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class DatabaseUnavailableError(Exception):
    pass


async def get_db() -> AsyncIterator[AsyncSession]:
    async with AsyncSessionLocal() as session:
        yield session


async def check_db_health(session: AsyncSession) -> None:
    try:
        await session.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        raise DatabaseUnavailableError(exc.__class__.__name__) from exc


async def dispose_db() -> None:
    await engine.dispose()
