"""Async HTTP webhook notifier with DNS-rebinding SSRF defense."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Any

import httpx

from app.adapters.http_safety import UnsafeOutboundTargetError, post_json_public
from app.domain.models import StoredNotificationConfig, TriggeredAlertCandidate
from app.domain.url_safety import mask_webhook_url

logger = logging.getLogger("vs.webhook")


def _build_message_text(stock_alerts: Sequence[TriggeredAlertCandidate]) -> str:
    lines = ["[ValueSingularity 哨兵雷达提醒]"]
    for alert in stock_alerts:
        source_label = "击球区" if alert.source_type == "watchlist_sentinel" else "否证红线"
        lines.append(f"- [{source_label}] {alert.detail} ({alert.trigger_date.isoformat()})")
    return "\n".join(lines)


def _format_webhook_payload(
    channel_type: str,
    stock_alerts: Sequence[TriggeredAlertCandidate],
) -> dict[str, Any]:
    text = _build_message_text(stock_alerts)
    if channel_type == "feishu":
        return {"msg_type": "text", "content": {"text": text}}
    if channel_type == "wecom":
        return {"msgtype": "text", "text": {"content": text}}
    return {
        "event": "value_singularity.alerts",
        "count": len(stock_alerts),
        "text": text,
        "alerts": [
            {
                "source_type": alert.source_type,
                "code": alert.code,
                "stock_name": alert.stock_name,
                "trigger_date": alert.trigger_date.isoformat(),
                "rule_signature": alert.rule_signature,
                "matched_conditions": list(alert.matched_conditions),
                "detail": alert.detail,
                "current_price": alert.current_price,
                "current_pe_percentile": alert.current_pe_percentile,
                "current_dividend_yield_pct": alert.current_dividend_yield_pct,
            }
            for alert in stock_alerts
        ],
    }


class HttpxWebhookNotifier:
    def __init__(
        self,
        *,
        timeout_seconds: float = 5.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._timeout_seconds = timeout_seconds
        self._transport = transport

    async def send_alerts(
        self,
        config: StoredNotificationConfig,
        stock_alerts: Sequence[TriggeredAlertCandidate],
    ) -> bool:
        if not stock_alerts or not config.webhook_enabled or not config.webhook_url:
            return False

        masked = mask_webhook_url(config.webhook_url)
        payload = _format_webhook_payload(config.channel_type, stock_alerts)
        try:
            response = await post_json_public(
                config.webhook_url,
                json_body=payload,
                timeout_seconds=self._timeout_seconds,
                transport=self._transport,
                label="Webhook URL",
            )
        except UnsafeOutboundTargetError as exc:
            logger.warning("Webhook SSRF 校验拒绝发送 (%s): %s", masked, exc)
            return False
        except (httpx.HTTPError, httpx.InvalidURL, UnicodeError, OSError, ValueError) as exc:
            logger.warning("Webhook 发送异常 (%s): %s", masked, exc.__class__.__name__)
            return False

        if not (200 <= response.status_code < 300):
            logger.warning(
                "Webhook 返回非成功状态码 (%s): status=%d",
                masked,
                response.status_code,
            )
            return False
        return True
