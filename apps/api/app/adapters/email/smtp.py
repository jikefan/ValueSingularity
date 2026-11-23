"""SMTP email verification adapter with TLS enforcement and header-injection protection."""

from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr

from email_validator import EmailNotValidError, validate_email

from app.domain.errors import EmailDeliveryError, EmailNotConfiguredError
from app.domain.models import EmailCodePurpose

logger = logging.getLogger("vs.email")

_PURPOSE_COPY: dict[EmailCodePurpose, tuple[str, str]] = {
    "register": ("注册账号", "您正在注册 ValueSingularity 价值奇点账号"),
    "reset_password": ("重置密码", "您正在申请重置 ValueSingularity 价值奇点账号登录密码"),
    "verify_email": ("验证邮箱", "您正在验证 ValueSingularity 价值奇点账号绑定邮箱"),
    "delete_account": ("账号注销确认", "您正在申请永久注销 ValueSingularity 价值奇点账号"),
}


def _has_control_chars(value: str) -> bool:
    return any(ch in ("\r", "\n", "\x00") or ord(ch) < 32 or ord(ch) == 127 for ch in value)


def _validate_header_text(value: str, *, label: str) -> str:
    if _has_control_chars(value):
        raise ValueError(f"{label}不能包含换行符或控制字符")
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{label}不能为空")
    return cleaned


def _validate_email_addr(value: str, *, label: str) -> str:
    cleaned = _validate_header_text(value, label=label)
    if any(ch.isspace() for ch in cleaned) or any(ch in cleaned for ch in (",", ";", "<", ">")):
        raise ValueError(f"{label}格式无效")
    try:
        validate_email(cleaned, check_deliverability=False)
    except EmailNotValidError as exc:
        raise ValueError(f"{label}格式无效") from exc
    return cleaned


def _mask_email(email: str) -> str:
    local, _, domain = email.partition("@")
    if not domain:
        return "***"
    prefix = local[:1] if local else "*"
    return f"{prefix}***@{domain}"


class UnconfiguredEmailSender:
    async def ensure_configured(self) -> None:
        raise EmailNotConfiguredError()

    async def send_verification_code(
        self,
        *,
        to_email: str,
        code: str,
        purpose: EmailCodePurpose,
        expires_minutes: int,
    ) -> None:
        del to_email, code, purpose, expires_minutes
        raise EmailNotConfiguredError()


class SmtpEmailAdapter:
    def __init__(
        self,
        *,
        host: str,
        port: int,
        username: str,
        password: str,
        from_email: str,
        from_name: str = "ValueSingularity 价值奇点",
        use_ssl: bool = True,
        timeout_seconds: float = 15.0,
    ) -> None:
        try:
            safe_host = _validate_header_text(host, label="SMTP 主机")
            if any(ch.isspace() for ch in safe_host):
                raise ValueError("SMTP 主机不能包含空白字符")
            if port < 1 or port > 65535:
                raise ValueError("SMTP 端口无效")
            safe_username = _validate_header_text(username, label="SMTP 用户名")
            if _has_control_chars(password) or not password.strip():
                raise ValueError("SMTP 密码无效")
            safe_from_email = _validate_email_addr(from_email, label="发件人邮箱")
            safe_from_name = _validate_header_text(from_name, label="发件人名称")
            if timeout_seconds <= 0:
                raise ValueError("SMTP 超时时间必须大于 0")
        except ValueError as exc:
            raise EmailNotConfiguredError("邮件发送服务配置无效，请检查 SMTP 参数") from exc

        self._host = safe_host
        self._port = port
        self._username = safe_username
        self._password = password
        self._from_email = safe_from_email
        self._from_name = safe_from_name
        self._use_ssl = use_ssl
        self._timeout_seconds = timeout_seconds

    async def ensure_configured(self) -> None:
        try:
            safe_host = _validate_header_text(self._host, label="SMTP 主机")
            if any(ch.isspace() for ch in safe_host):
                raise ValueError("SMTP 主机不能包含空白字符")
            if self._port < 1 or self._port > 65535:
                raise ValueError("SMTP 端口无效")
            _validate_header_text(self._username, label="SMTP 用户名")
            if _has_control_chars(self._password) or not self._password.strip():
                raise ValueError("SMTP 密码无效")
            _validate_email_addr(self._from_email, label="发件人邮箱")
            _validate_header_text(self._from_name, label="发件人名称")
            if self._timeout_seconds <= 0:
                raise ValueError("SMTP 超时时间必须大于 0")
        except ValueError as exc:
            raise EmailNotConfiguredError("邮件发送服务配置无效，请检查 SMTP 参数") from exc

    async def send_verification_code(
        self,
        *,
        to_email: str,
        code: str,
        purpose: EmailCodePurpose,
        expires_minutes: int,
    ) -> None:
        safe_host = self._host
        safe_to = to_email

        def _send_sync(
            host: str,
            from_email: str,
            from_name: str,
            recipient: str,
        ) -> None:
            title, intro = _PURPOSE_COPY[purpose]
            msg = EmailMessage()
            msg["Subject"] = f"【ValueSingularity 价值奇点】{title}验证码"
            msg["From"] = formataddr((from_name, from_email))
            msg["To"] = recipient
            body = (
                f"{intro}，本次操作的 6 位邮箱验证码为：\n\n"
                f"{code}\n\n"
                f"验证码将在 {expires_minutes} 分钟后失效，请勿向他人泄露。"
                "如非本人操作，请忽略本邮件。"
            )
            msg.set_content(body, subtype="plain", charset="utf-8")

            ssl_context = ssl.create_default_context()
            if self._use_ssl:
                with smtplib.SMTP_SSL(
                    host,
                    self._port,
                    timeout=self._timeout_seconds,
                    context=ssl_context,
                ) as client:
                    client.login(self._username, self._password)
                    client.send_message(msg)
            else:
                with smtplib.SMTP(
                    host,
                    self._port,
                    timeout=self._timeout_seconds,
                ) as client:
                    client.ehlo()
                    client.starttls(context=ssl_context)
                    client.ehlo()
                    client.login(self._username, self._password)
                    client.send_message(msg)

        try:
            safe_host = _validate_header_text(self._host, label="SMTP 主机")
            if any(ch.isspace() for ch in safe_host):
                raise ValueError("SMTP 主机不能包含空白字符")
            safe_to = _validate_email_addr(to_email, label="收件人邮箱")
            safe_from_email = _validate_email_addr(self._from_email, label="发件人邮箱")
            safe_from_name = _validate_header_text(self._from_name, label="发件人名称")
            if not code or not code.isascii() or not code.isdigit() or len(code) != 6:
                raise ValueError("验证码格式无效")
            if expires_minutes < 1:
                raise ValueError("验证码有效期必须大于 0 分钟")

            await asyncio.to_thread(
                _send_sync,
                safe_host,
                safe_from_email,
                safe_from_name,
                safe_to,
            )
        except (
            ValueError,
            UnicodeEncodeError,
            smtplib.SMTPException,
            OSError,
            TimeoutError,
            ssl.SSLError,
        ) as exc:
            logger.warning(
                "SMTP 邮件发送失败 (host=%s, to=%s, purpose=%s): %s",
                safe_host,
                _mask_email(safe_to),
                purpose,
                exc.__class__.__name__,
            )
            raise EmailDeliveryError() from exc

        logger.info(
            "SMTP 验证码邮件发送成功 (to=%s, purpose=%s)",
            _mask_email(safe_to),
            purpose,
        )
