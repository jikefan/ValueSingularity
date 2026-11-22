"""PostgreSQL repositories for notification settings and deduplicated alert deliveries."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AlertDelivery, JournalEntry, Setting, StockMeta, User, UserEvent
from app.db.models import WatchlistItem as WatchlistRow
from app.db.session import DatabaseUnavailableError
from app.domain.models import (
    AlertDeliveryItem,
    AlertSourceType,
    StoredNotificationConfig,
    TriggeredAlertCandidate,
    UserEventCreate,
)

_NOTIFICATION_PREFS_KEY = "notification_prefs"


def _as_optional_float(val: object) -> float | None:
    if isinstance(val, int | float) and not isinstance(val, bool):
        return float(val)
    return None


def _to_alert_item(row: AlertDelivery, *, stock_name: str | None = None) -> AlertDeliveryItem:
    payload = row.payload if isinstance(row.payload, dict) else {}
    raw_conditions = payload.get("matched_conditions")
    matched_conditions = (
        [str(item) for item in raw_conditions] if isinstance(raw_conditions, list) else []
    )
    resolved_name = payload.get("stock_name")
    final_name = (
        str(resolved_name) if isinstance(resolved_name, str) and resolved_name else stock_name
    )
    detail_raw = payload.get("detail")
    detail = str(detail_raw) if isinstance(detail_raw, str) else ""
    source_type: AlertSourceType = (
        "journal_falsify" if row.source_type == "journal_falsify" else "watchlist_sentinel"
    )

    return AlertDeliveryItem(
        id=row.id,
        source_type=source_type,
        code=row.code,
        stock_name=final_name,
        trigger_date=row.trigger_date,
        rule_signature=row.rule_signature,
        matched_conditions=matched_conditions,
        detail=detail,
        current_price=_as_optional_float(payload.get("current_price")),
        current_pe_percentile=_as_optional_float(payload.get("current_pe_percentile")),
        current_dividend_yield_pct=_as_optional_float(payload.get("current_dividend_yield_pct")),
        channel=row.channel,
        status=row.status,
        created_at=row.created_at,
    )


class PostgresSettingsRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_notification_config(self, user_id: UUID) -> StoredNotificationConfig:
        stmt = select(Setting).where(
            Setting.user_id == user_id,
            Setting.key == _NOTIFICATION_PREFS_KEY,
        )
        try:
            row = await self._session.scalar(stmt)
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc

        if row is None or not isinstance(row.value, dict):
            return StoredNotificationConfig()
        return StoredNotificationConfig.model_validate(row.value)

    async def save_notification_config(
        self, user_id: UUID, config: StoredNotificationConfig
    ) -> StoredNotificationConfig:
        value_json = config.model_dump(mode="json")
        stmt = (
            pg_insert(Setting)
            .values(
                user_id=user_id,
                key=_NOTIFICATION_PREFS_KEY,
                value=value_json,
            )
            .on_conflict_do_update(
                index_elements=["user_id", "key"],
                set_={"value": value_json},
            )
        )
        try:
            await self._session.execute(stmt)
            await self._session.commit()
        except SQLAlchemyError as exc:
            await self._session.rollback()
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc
        return config


class PostgresAlertRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list_alerts(self, user_id: UUID, *, limit: int = 50) -> list[AlertDeliveryItem]:
        bounded_limit = max(1, min(limit, 200))
        stmt = (
            select(AlertDelivery, StockMeta.name)
            .outerjoin(StockMeta, StockMeta.code == AlertDelivery.code)
            .where(AlertDelivery.user_id == user_id)
            .order_by(AlertDelivery.created_at.desc(), AlertDelivery.id.desc())
            .limit(bounded_limit)
        )
        try:
            rows = (await self._session.execute(stmt)).all()
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc
        return [_to_alert_item(row, stock_name=meta_name) for row, meta_name in rows]

    async def insert_alert_if_new(
        self,
        candidate: TriggeredAlertCandidate,
        *,
        channel: str,
        status: str,
        audit_event: UserEventCreate | None = None,
    ) -> tuple[AlertDeliveryItem | None, bool]:
        payload_json: dict[str, Any] = {
            "stock_name": candidate.stock_name,
            "matched_conditions": list(candidate.matched_conditions),
            "detail": candidate.detail,
            "current_price": candidate.current_price,
            "current_pe_percentile": candidate.current_pe_percentile,
            "current_dividend_yield_pct": candidate.current_dividend_yield_pct,
        }
        stmt = (
            pg_insert(AlertDelivery)
            .values(
                user_id=candidate.user_id,
                source_type=candidate.source_type,
                code=candidate.code,
                trigger_date=candidate.trigger_date,
                rule_signature=candidate.rule_signature[:64],
                payload=payload_json,
                channel=channel[:24],
                status=status[:16],
                created_at=datetime.now(UTC),
            )
            .on_conflict_do_nothing(
                index_elements=[
                    "user_id",
                    "source_type",
                    "code",
                    "trigger_date",
                    "rule_signature",
                ]
            )
            .returning(AlertDelivery)
        )
        try:
            inserted = (await self._session.scalars(stmt)).first()
            if inserted is None:
                await self._session.rollback()
                return None, False

            if audit_event is not None:
                meta_json: dict[str, Any] | None = (
                    dict(audit_event.meta) if audit_event.meta is not None else None
                )
                self._session.add(
                    UserEvent(
                        user_id=candidate.user_id,
                        type=audit_event.type,
                        code=audit_event.code,
                        meta=meta_json,
                    )
                )
            await self._session.commit()
            await self._session.refresh(inserted)
        except SQLAlchemyError as exc:
            await self._session.rollback()
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc

        return _to_alert_item(inserted, stock_name=candidate.stock_name), True

    async def update_delivery_status(
        self,
        delivery_id: int,
        *,
        channel: str,
        status: str,
    ) -> AlertDeliveryItem | None:
        stmt = (
            update(AlertDelivery)
            .where(AlertDelivery.id == delivery_id)
            .values(channel=channel[:24], status=status[:16])
            .returning(AlertDelivery)
        )
        try:
            row = (await self._session.scalars(stmt)).first()
            await self._session.commit()
        except SQLAlchemyError as exc:
            await self._session.rollback()
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc

        return _to_alert_item(row) if row is not None else None

    async def list_users_with_alert_targets(self) -> list[UUID]:
        watchlist_users = select(WatchlistRow.user_id).where(WatchlistRow.alert_enabled.is_(True))
        holding_users = select(JournalEntry.user_id).where(JournalEntry.action.in_(["buy", "add"]))
        stmt = (
            select(User.id)
            .where(
                User.is_active.is_(True),
                or_(User.id.in_(watchlist_users), User.id.in_(holding_users)),
            )
            .order_by(User.created_at.asc(), User.id.asc())
        )
        try:
            return list((await self._session.scalars(stmt)).all())
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc
