"""Shared SSRF-safe outbound HTTP helpers with DNS resolution & TCP IP pinning."""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from app.domain.url_safety import is_public_ip, validate_public_http_url

# Prevent httpx/httpcore INFO logs from printing secret query tokens or auth headers.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

_MAX_RESPONSE_BYTES = 1_048_576


def _is_ip_literal(hostname: str) -> bool:
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return True


class UnsafeOutboundTargetError(ValueError):
    """Raised when an outbound URL fails SSRF validation or public-IP DNS checks."""


@dataclass(frozen=True, slots=True)
class PinnedPublicTarget:
    safe_url: str
    scheme: str
    ascii_hostname: str
    pinned_ip: str
    target_url: str
    host_header: str


async def resolve_public_ips(hostname: str, port: int) -> list[str]:
    """Resolve hostname at delivery time and fail closed if any returned IP is non-public."""
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


def build_pinned_request_target(
    safe_url: str,
    pinned_ip: str,
    ascii_hostname: str,
) -> tuple[str, str]:
    """Rewrite a validated URL to connect directly to pinned_ip while preserving Host."""
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


async def prepare_pinned_public_target(raw_url: str, *, label: str = "URL") -> PinnedPublicTarget:
    """Validate URL syntax, enforce public DNS resolution, and compute pinned TCP target."""
    try:
        safe_url = validate_public_http_url(raw_url, label=label)
        parsed = urlsplit(safe_url)
        scheme = parsed.scheme.lower()
        hostname = (parsed.hostname or "").rstrip(".")
        if not hostname:
            raise UnsafeOutboundTargetError(f"{label} 缺少主机名")
        ascii_hostname = hostname.encode("idna").decode("ascii").lower()
        default_port = 443 if scheme == "https" else 80
        port = parsed.port if parsed.port is not None else default_port
    except (UnicodeError, ValueError) as exc:
        raise UnsafeOutboundTargetError(str(exc)) from exc

    resolved_ips = await resolve_public_ips(ascii_hostname, port)
    if not resolved_ips:
        raise UnsafeOutboundTargetError(f"{label} 解析为非公网 IP 或 DNS 解析失败")

    pinned_ip = resolved_ips[0]
    target_url, host_header = build_pinned_request_target(safe_url, pinned_ip, ascii_hostname)
    return PinnedPublicTarget(
        safe_url=safe_url,
        scheme=scheme,
        ascii_hostname=ascii_hostname,
        pinned_ip=pinned_ip,
        target_url=target_url,
        host_header=host_header,
    )


async def post_json_public(
    raw_url: str,
    *,
    json_body: dict[str, Any],
    headers: dict[str, str] | None = None,
    timeout_seconds: float = 10.0,
    transport: httpx.AsyncBaseTransport | None = None,
    label: str = "URL",
) -> httpx.Response:
    """POST JSON payload to an SSRF-verified public HTTP(S) target with pinned TCP IP."""
    target = await prepare_pinned_public_target(raw_url, label=label)
    merged_headers = dict(headers or {})
    if transport is None:
        post_url = target.target_url
        merged_headers["Host"] = target.host_header
        extensions: dict[str, Any] | None = (
            {"sni_hostname": target.ascii_hostname}
            if target.scheme == "https" and not _is_ip_literal(target.ascii_hostname)
            else None
        )
    else:
        post_url = target.safe_url
        extensions = None

    async with (
        httpx.AsyncClient(
            timeout=timeout_seconds,
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        ) as client,
        client.stream(
            "POST",
            post_url,
            json=json_body,
            headers=merged_headers,
            extensions=extensions,
        ) as response,
    ):
        raw_cl = response.headers.get("content-length")
        if raw_cl is not None:
            try:
                cl_val = int(raw_cl)
            except ValueError:
                cl_val = None
            if cl_val is not None and cl_val > _MAX_RESPONSE_BYTES:
                raise ValueError(
                    f"{label} 响应体过大 ({cl_val} 字节，上限 {_MAX_RESPONSE_BYTES} 字节)"
                )

        chunks = bytearray()
        async for chunk in response.aiter_bytes():
            if (
                response.num_bytes_downloaded > _MAX_RESPONSE_BYTES
                or len(chunks) + len(chunk) > _MAX_RESPONSE_BYTES
            ):
                raise ValueError(f"{label} 响应体超过最大限制 ({_MAX_RESPONSE_BYTES} 字节)")
            chunks.extend(chunk)

        filtered_headers = httpx.Headers(
            [
                (k, v)
                for k, v in response.headers.raw
                if k.lower() not in {b"content-encoding", b"content-length"}
            ]
        )
        return httpx.Response(
            status_code=response.status_code,
            headers=filtered_headers,
            content=bytes(chunks),
            request=response.request,
        )
