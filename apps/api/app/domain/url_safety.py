"""URL safety validation and secret masking for outbound webhooks (stdlib only)."""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import urlsplit

_FORBIDDEN_HOST_SUFFIXES = (".localhost", ".local", ".internal", ".arpa")
_NUMERIC_LABEL_RE = re.compile(r"^(?:0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$", re.ASCII)
_UTS46_DOT_CHARS = frozenset({"\u3002", "\uff0e", "\uff61", "\ufe52", "\u2024"})


def is_public_ip(raw_ip: str) -> bool:
    """Return True only when raw_ip is a globally routable public IP address."""
    if not raw_ip or "%" in raw_ip:
        return False
    try:
        ip = ipaddress.ip_address(raw_ip)
    except ValueError:
        return False

    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return is_public_ip(str(ip.ipv4_mapped))

    return (
        ip.is_global
        and not ip.is_private
        and not ip.is_loopback
        and not ip.is_link_local
        and not getattr(ip, "is_site_local", False)
        and not ip.is_multicast
        and not ip.is_reserved
        and not ip.is_unspecified
    )


def validate_public_http_url(raw_url: str, *, label: str = "URL") -> str:
    """Validate that a URL targets a public HTTP(S) endpoint without SSRF vectors."""
    if not raw_url:
        raise ValueError(f"{label} 不能为空")

    if any(ch == "\x00" or ch.isspace() or ord(ch) < 32 or ord(ch) == 127 for ch in raw_url):
        raise ValueError(f"{label} 不能包含空字符、空白或控制字符")

    try:
        parsed = urlsplit(raw_url)
        _ = parsed.port
    except ValueError as exc:
        raise ValueError(f"{label} 格式无效: {exc}") from exc

    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise ValueError(f"{label} 仅支持 http 或 https 协议")

    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
        raise ValueError(f"{label} 不能包含内嵌用户名或密码")

    raw_host = (parsed.hostname or "").lower()
    if not raw_host:
        raise ValueError(f"{label} 缺少主机名")

    if "%" in raw_host:
        raise ValueError(f"{label} 主机名格式无效")

    if any(ch in _UTS46_DOT_CHARS for ch in raw_host) or not raw_host.isascii():
        raise ValueError(f"{label} 主机名仅支持 ASCII 域名、Punycode 或公网 IP")

    if raw_host.endswith(".."):
        raise ValueError(f"{label} 主机名格式无效")

    host = raw_host.rstrip(".")
    if not host:
        raise ValueError(f"{label} 缺少主机名")

    if host == "localhost" or host.endswith(_FORBIDDEN_HOST_SUFFIXES):
        raise ValueError(f"{label} 不能指向本机或内网域名")

    try:
        ipaddress.ip_address(host)
        is_ip_literal = True
    except ValueError:
        is_ip_literal = False

    if is_ip_literal:
        if not is_public_ip(host):
            raise ValueError(f"{label} 不能指向内网、回环或保留 IP 地址")
        return raw_url

    try:
        ascii_host = host.encode("idna").decode("ascii").lower()
        _ = ascii_host.encode("ascii").decode("idna")
    except UnicodeError as exc:
        raise ValueError(f"{label} 主机名格式或 Punycode 无效") from exc

    if ascii_host == "localhost" or ascii_host.endswith(_FORBIDDEN_HOST_SUFFIXES):
        raise ValueError(f"{label} 不能指向本机或内网域名")

    labels = ascii_host.split(".")
    if len(labels) < 2 or any(not label_part for label_part in labels):
        raise ValueError(f"{label} 必须包含有效的公网域名或公网 IP")

    if all(_NUMERIC_LABEL_RE.fullmatch(label_part) for label_part in labels):
        raise ValueError(f"{label} 不支持非标准数字 IP 主机名")

    return raw_url


def validate_public_webhook_url(raw_url: str) -> str:
    """Validate that a webhook URL targets a public HTTP(S) endpoint without SSRF vectors."""
    return validate_public_http_url(raw_url, label="Webhook URL")


def mask_secret(secret: str | None) -> str | None:
    """Mask an API key or secret token while retaining at most a known prefix and last 4 chars."""
    if secret is None:
        return None
    cleaned = secret.strip()
    if not cleaned:
        return None
    if len(cleaned) <= 4:
        return "****"
    if cleaned.startswith("sk-"):
        if len(cleaned) <= 7:
            return "sk-****"
        return f"sk-****{cleaned[-4:]}"
    if len(cleaned) < 8:
        return "****"
    return f"****{cleaned[-4:]}"


def mask_webhook_url(url: str | None) -> str | None:
    """Mask webhook URL path/query tokens while preserving scheme, host, and last 4 characters."""
    if url is None:
        return None
    cleaned = url.strip()
    if not cleaned:
        return None

    try:
        parsed = urlsplit(cleaned)
    except ValueError:
        return f"****{cleaned[-4:]}" if len(cleaned) > 4 else "****"

    scheme = parsed.scheme.lower() or "https"
    netloc = parsed.netloc
    if not netloc:
        return f"****{cleaned[-4:]}" if len(cleaned) > 4 else "****"

    tail = (
        f"{parsed.path}"
        f"{f'?{parsed.query}' if parsed.query else ''}"
        f"{f'#{parsed.fragment}' if parsed.fragment else ''}"
    )
    if len(tail) > 4:
        return f"{scheme}://{netloc}/****{tail[-4:]}"
    return f"{scheme}://{netloc}/****"
