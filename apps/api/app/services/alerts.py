"""Sentinel alert scanning and notification preference orchestration."""

from __future__ import annotations

import logging
from datetime import date
from uuid import UUID

from app.domain.engines import evaluate_user_alerts
from app.domain.errors import NotificationConfigError
from app.domain.models import (
    AlertDeliveryItem,
    AlertScanSummary,
    JournalAction,
    NotificationPreferences,
    NotificationPreferencesUpdate,
    StoredNotificationConfig,
    TriggeredAlertCandidate,
    UserEventCreate,
)
from app.domain.ports import (
    AlertRepository,
    JournalRepository,
    SettingsRepository,
    StockSnapshotRepository,
    WatchlistRepository,
    WebhookNotifierPort,
)
from app.domain.url_safety import mask_webhook_url

logger = logging.getLogger("vs.alerts")


def _to_public_preferences(config: StoredNotificationConfig) -> NotificationPreferences:
    configured = bool(config.webhook_url)
    return NotificationPreferences(
        in_app_enabled=config.in_app_enabled,
        webhook_enabled=config.webhook_enabled,
        channel_type=config.channel_type,
        webhook_url_configured=configured,
        webhook_url_masked=mask_webhook_url(config.webhook_url) if configured else None,
    )


def _max_date(dates: list[date]) -> date | None:
    return max(dates) if dates else None


class AlertScanService:
    def __init__(
        self,
        *,
        watchlist_repo: WatchlistRepository,
        journal_repo: JournalRepository,
        snapshot_repo: StockSnapshotRepository,
        settings_repo: SettingsRepository,
        alert_repo: AlertRepository,
        webhook_notifier: WebhookNotifierPort | None = None,
    ) -> None:
        self._watchlist_repo = watchlist_repo
        self._journal_repo = journal_repo
        self._snapshot_repo = snapshot_repo
        self._settings_repo = settings_repo
        self._alert_repo = alert_repo
        self._webhook_notifier = webhook_notifier

    async def get_preferences(self, user_id: UUID) -> NotificationPreferences:
        config = await self._settings_repo.get_notification_config(user_id)
        return _to_public_preferences(config)

    async def update_preferences(
        self,
        user_id: UUID,
        payload: NotificationPreferencesUpdate,
    ) -> NotificationPreferences:
        existing = await self._settings_repo.get_notification_config(user_id)
        if payload.webhook_url is None:
            resolved_url = existing.webhook_url
        elif payload.webhook_url == "":
            resolved_url = None
        else:
            resolved_url = payload.webhook_url

        if payload.webhook_enabled and not resolved_url:
            raise NotificationConfigError("启用 Webhook 推送前请先配置有效的公网 Webhook URL")

        updated = StoredNotificationConfig(
            in_app_enabled=payload.in_app_enabled,
            webhook_enabled=payload.webhook_enabled,
            channel_type=payload.channel_type,
            webhook_url=resolved_url,
        )
        saved = await self._settings_repo.save_notification_config(user_id, updated)
        return _to_public_preferences(saved)

    async def list_alerts(self, user_id: UUID, *, limit: int = 50) -> list[AlertDeliveryItem]:
        return await self._alert_repo.list_alerts(user_id, limit=limit)

    async def scan_user(self, user_id: UUID) -> AlertScanSummary:
        watchlist = await self._watchlist_repo.list(user_id)
        journal_entries = await self._journal_repo.list_holding_lifecycle_entries(user_id)

        target_codes = list(
            dict.fromkeys(
                [item.code for item in watchlist if item.alert_enabled]
                + [
                    entry.code
                    for entry in journal_entries
                    if entry.action in {JournalAction.BUY, JournalAction.ADD}
                ]
            )
        )
        snapshots_by_code = (
            await self._snapshot_repo.get_snapshots_for_compare(target_codes)
            if target_codes
            else {}
        )
        as_of = _max_date([snap.as_of for snap in snapshots_by_code.values()])

        evaluation = evaluate_user_alerts(
            user_id,
            watchlist,
            journal_entries,
            snapshots_by_code,
        )
        if not evaluation.candidates:
            return AlertScanSummary(
                as_of=as_of,
                users_scanned=1,
                evaluated_rules=evaluation.evaluated_rules,
            )

        config = await self._settings_repo.get_notification_config(user_id)
        webhook_active = bool(config.webhook_enabled and config.webhook_url)
        if not config.in_app_enabled and not webhook_active:
            return AlertScanSummary(
                as_of=as_of,
                users_scanned=1,
                evaluated_rules=evaluation.evaluated_rules,
                matched_count=len(evaluation.candidates),
            )

        initial_channel = config.channel_type if webhook_active else "in_app"
        initial_status = "pending" if webhook_active else "recorded"

        inserted_pairs: list[tuple[TriggeredAlertCandidate, AlertDeliveryItem]] = []
        for candidate in evaluation.candidates:
            audit_event = (
                UserEventCreate(
                    type="alert_triggered",
                    code=candidate.code,
                    meta={
                        "source_type": candidate.source_type,
                        "rule_signature": candidate.rule_signature,
                        "detail": candidate.detail[:500],
                    },
                )
                if config.in_app_enabled
                else None
            )
            delivery, inserted = await self._alert_repo.insert_alert_if_new(
                candidate,
                channel=initial_channel,
                status=initial_status,
                audit_event=audit_event,
            )
            if inserted and delivery is not None:
                inserted_pairs.append((candidate, delivery))

        deliveries = [delivery for _, delivery in inserted_pairs]
        webhook_sent_count = 0
        webhook_failed_count = 0

        if inserted_pairs and webhook_active:
            if self._webhook_notifier is not None:
                try:
                    ok = await self._webhook_notifier.send_alerts(
                        config, [candidate for candidate, _ in inserted_pairs]
                    )
                except Exception as exc:
                    logger.warning(
                        "Webhook 通知器执行异常 user_id=%s: %s",
                        user_id,
                        exc.__class__.__name__,
                    )
                    ok = False
                except BaseException:
                    logger.warning("Webhook 发送任务被中断 user_id=%s", user_id)
                    raise
            else:
                ok = False

            final_status = "sent" if ok else "webhook_failed"
            updated_deliveries: list[AlertDeliveryItem] = []
            for _, delivery in inserted_pairs:
                updated_item = await self._alert_repo.update_delivery_status(
                    delivery.id,
                    channel=config.channel_type,
                    status=final_status,
                )
                updated_deliveries.append(updated_item if updated_item is not None else delivery)
            deliveries = updated_deliveries

            if ok:
                webhook_sent_count = len(inserted_pairs)
            else:
                webhook_failed_count = len(inserted_pairs)

        return AlertScanSummary(
            as_of=as_of,
            users_scanned=1,
            evaluated_rules=evaluation.evaluated_rules,
            matched_count=len(evaluation.candidates),
            newly_triggered_count=len(deliveries),
            webhook_sent_count=webhook_sent_count,
            webhook_failed_count=webhook_failed_count,
            deliveries=deliveries,
        )

    async def scan_all_users(self) -> AlertScanSummary:
        user_ids = await self._alert_repo.list_users_with_alert_targets()
        if not user_ids:
            return AlertScanSummary(users_scanned=0)

        dates: list[date] = []
        users_scanned = 0
        evaluated_rules = 0
        matched_count = 0
        newly_triggered_count = 0
        webhook_sent_count = 0
        webhook_failed_count = 0
        deliveries: list[AlertDeliveryItem] = []

        for user_id in user_ids:
            try:
                summary = await self.scan_user(user_id)
            except Exception as exc:
                logger.warning(
                    "用户哨兵扫描异常已跳过 user_id=%s: %s",
                    user_id,
                    exc.__class__.__name__,
                )
                continue
            users_scanned += 1
            if summary.as_of is not None:
                dates.append(summary.as_of)
            evaluated_rules += summary.evaluated_rules
            matched_count += summary.matched_count
            newly_triggered_count += summary.newly_triggered_count
            webhook_sent_count += summary.webhook_sent_count
            webhook_failed_count += summary.webhook_failed_count
            deliveries.extend(summary.deliveries)

        return AlertScanSummary(
            as_of=_max_date(dates),
            users_scanned=users_scanned,
            evaluated_rules=evaluated_rules,
            matched_count=matched_count,
            newly_triggered_count=newly_triggered_count,
            webhook_sent_count=webhook_sent_count,
            webhook_failed_count=webhook_failed_count,
            deliveries=deliveries,
        )


__all__ = ["AlertScanService", "NotificationConfigError"]
