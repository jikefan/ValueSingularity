"""SQLAlchemy tables — user data and precomputed read models.

Market facts (daily bars, financial statements) do NOT live here: they are
Parquet files queried offline by DuckDB. See docs/data-architecture.md.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    Index,
    Numeric,
    SmallInteger,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

# JSONB on PostgreSQL, JSON on non-PostgreSQL dialects.
JSONType = JSON().with_variant(JSONB(), "postgresql")


class WatchlistItem(Base):
    __tablename__ = "watchlist"

    code: Mapped[str] = mapped_column(String(6), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    industry: Mapped[str | None] = mapped_column(String(64))
    note: Mapped[str | None] = mapped_column(Text)
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class JournalEntry(Base):
    __tablename__ = "journal"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(6), nullable=False, index=True)
    name: Mapped[str | None] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    # 强制 checklist：写不出理由与否证条件，就不许记录
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    falsify_condition: Mapped[str] = mapped_column(Text, nullable=False)
    max_drawdown: Mapped[float | None] = mapped_column(Numeric(6, 2))
    emotion: Mapped[str | None] = mapped_column(String(32))
    price: Mapped[float | None] = mapped_column(Numeric(12, 3))
    snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_journal_code_created_at", "code", "created_at"),)


class UserEvent(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    code: Mapped[str | None] = mapped_column(String(6))
    meta: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSONType, nullable=False)


class StockSnapshot(Base):
    """Precomputed per-stock card served straight to the UI."""

    __tablename__ = "stock_snapshot"

    code: Mapped[str] = mapped_column(String(6), primary_key=True)
    as_of: Mapped[Any] = mapped_column(Date, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONType, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class MarketSnapshot(Base):
    """Single-row market overview (temperature, indices, industry flows)."""

    __tablename__ = "market_snapshot"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, default=1)
    as_of: Mapped[Any] = mapped_column(Date, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONType, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (CheckConstraint("id = 1", name="single_row"),)
