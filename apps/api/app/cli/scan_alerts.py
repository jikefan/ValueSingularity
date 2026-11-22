"""Idempotent sentinel alert scanner CLI (`python -m app.cli.scan_alerts`)."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from collections.abc import Sequence
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.notifications.webhook import HttpxWebhookNotifier
from app.adapters.postgres.alert import PostgresAlertRepository, PostgresSettingsRepository
from app.adapters.postgres.journal import PostgresJournalRepository
from app.adapters.postgres.snapshot import PostgresStockSnapshotRepository
from app.adapters.postgres.watchlist import PostgresWatchlistRepository
from app.db.session import AsyncSessionLocal, dispose_db
from app.domain.models import AlertScanSummary
from app.domain.ports import WebhookNotifierPort
from app.services.alerts import AlertScanService

logger = logging.getLogger("vs.cli.scan_alerts")


def build_alert_scan_service(
    session: AsyncSession,
    *,
    webhook_notifier: WebhookNotifierPort | None = None,
) -> AlertScanService:
    resolved_notifier = webhook_notifier if webhook_notifier is not None else HttpxWebhookNotifier()
    return AlertScanService(
        watchlist_repo=PostgresWatchlistRepository(session),
        journal_repo=PostgresJournalRepository(session),
        snapshot_repo=PostgresStockSnapshotRepository(session),
        settings_repo=PostgresSettingsRepository(session),
        alert_repo=PostgresAlertRepository(session),
        webhook_notifier=resolved_notifier,
    )


async def run_alert_scan(
    session: AsyncSession,
    *,
    user_id: UUID | None = None,
    webhook_notifier: WebhookNotifierPort | None = None,
) -> AlertScanSummary:
    service = build_alert_scan_service(session, webhook_notifier=webhook_notifier)
    if user_id is not None:
        return await service.scan_user(user_id)
    return await service.scan_all_users()


async def _run_cli_scan(user_id: UUID | None) -> AlertScanSummary:
    try:
        async with AsyncSessionLocal() as session:
            return await run_alert_scan(session, user_id=user_id)
    finally:
        await dispose_db()


def main(argv: Sequence[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser(
        description="Evaluate watchlist strike-zone and journal falsify sentinel alerts."
    )
    parser.add_argument(
        "--user-id",
        dest="user_id",
        default=None,
        help="Optional user UUID to scan only a single tenant.",
    )
    args = parser.parse_args(argv)

    target_user_id: UUID | None = None
    if args.user_id is not None:
        try:
            target_user_id = UUID(args.user_id)
        except ValueError as exc:
            logger.error("无效参数 --user-id=%s: %s", args.user_id, exc)
            return 2

    try:
        summary = asyncio.run(_run_cli_scan(target_user_id))
    except Exception:
        logger.exception("哨兵雷达扫描异常退出")
        return 1

    logger.info(
        "哨兵扫描完成: as_of=%s users=%d rules=%d matched=%d new=%d sent=%d failed=%d",
        summary.as_of.isoformat() if summary.as_of is not None else "N/A",
        summary.users_scanned,
        summary.evaluated_rules,
        summary.matched_count,
        summary.newly_triggered_count,
        summary.webhook_sent_count,
        summary.webhook_failed_count,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
