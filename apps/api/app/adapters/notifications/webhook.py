"""Async HTTP webhook notifier with DNS-rebinding SSRF defense."""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
from collections.abc import Sequence
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from app.domain.models import StoredNotificationConfig, TriggeredAlertCandidate
from app.domain.url_safety import is_public_ip, mask_webhook_url, validate_public_webhook_url

logger = logging.getLogger("vs.webhook")
# Prevent httpx/httpcore INFO logs from printing unmasked URLs with secret query tokens.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


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


async def _resolve_public_ips(hostname: str, port: int) -> list[str]:
    # Resolve at delivery time and fail closed unless every returned IP is globally routable.
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, hostname, port, type=socket.SOCK_STREAM)
    except OSError:
        return []

    if not infos:
        return []

    verified_ips: list[str] = []
    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            return []
        raw_ip = str(sockaddr[0])
        if not is_public_ip(raw_ip):
            return []
        if raw_ip not in verified_ips:
            verified_ips.append(raw_ip)
    return verified_ips


def _build_pinned_request_target(
    safe_url: str,
    pinned_ip: str,
    ascii_hostname: str,
) -> tuple[str, str]:
    parsed = urlsplit(safe_url)
    scheme = parsed.scheme.lower()
    default_port = 443 if scheme == "https" else 80
    port = parsed.port
    port_suffix = f":{port}" if port is not None and port != default_port else ""

    ip_obj = ipaddress.ip_address(pinned_ip)
    if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped is not None:
        pinned_host = str(ip_obj.ipv4_mapped)
    elif isinstance(ip_obj, ipaddress.IPv6Address):
        pinned_host = f"[{pinned_ip}]"
    else:
        pinned_host = pinned_ip

    target_url = urlunsplit((scheme, f"{pinned_host}{port_suffix}", parsed.path, parsed.query, ""))

    try:
        is_orig_ipv6 = isinstance(ipaddress.ip_address(ascii_hostname), ipaddress.IPv6Address)
    except ValueError:
        is_orig_ipv6 = False
    orig_host = f"[{ascii_hostname}]" if is_orig_ipv6 else ascii_hostname
    host_header = f"{orig_host}{port_suffix}"
    return target_url, host_header


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

        try:
            safe_url = validate_public_webhook_url(config.webhook_url)
        except ValueError as exc:
            logger.warning("Webhook URL 校验失败: %s", exc)
            return False

        masked = mask_webhook_url(safe_url)
        try:
            parsed = urlsplit(safe_url)
            scheme = parsed.scheme.lower()
            hostname = (parsed.hostname or "").rstrip(".")
            if not hostname:
                logger.warning("Webhook 目标缺少主机名 (%s)", masked)
                return False
            ascii_hostname = hostname.encode("idna").decode("ascii").lower()
            default_port = 443 if scheme == "https" else 80
            port = parsed.port if parsed.port is not None else default_port
        except (UnicodeError, ValueError) as exc:
            logger.warning("Webhook URL 解析失败 (%s): %s", masked, exc.__class__.__name__)
            return False

        resolved_ips = await _resolve_public_ips(ascii_hostname, port)
        if not resolved_ips:
            logger.warning("Webhook 目标解析为非公网 IP 或解析失败，已拒绝发送 (%s)", masked)
            return False

        payload = _format_webhook_payload(config.channel_type, stock_alerts)
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout_seconds,
                follow_redirects=False,
                trust_env=False,
                transport=self._transport,
            ) as client:
                if self._transport is None:
                    # Pin live TCP connections to the verified IP to eliminate DNS-rebinding TOCTOU.
                    target_url, host_header = _build_pinned_request_target(
                        safe_url, resolved_ips[0], ascii_hostname
                    )
                    extensions = {"sni_hostname": ascii_hostname} if scheme == "https" else None
                    response = await client.post(
                        target_url,
                        json=payload,
                        headers={"Host": host_header},
                        extensions=extensions,
                    )
                else:
                    response = await client.post(safe_url, json=payload)
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
