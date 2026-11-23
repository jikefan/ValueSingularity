"""Application settings.

Environment variables use the ``VS_`` prefix (see .env.example).
"""

from pathlib import Path
from typing import Self

from email_validator import EmailNotValidError, validate_email
from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _has_control_chars(value: str) -> bool:
    return any(ch in ("\r", "\n", "\x00") or ord(ch) < 32 or ord(ch) == 127 for ch in value)


def _normalize_optional_smtp_value(
    value: str | None,
    *,
    label: str,
    reject_whitespace: bool = False,
    strip_value: bool = True,
) -> str | None:
    if value is None or value == "":
        return None
    if _has_control_chars(value):
        raise ValueError(f"{label}不能包含换行符或控制字符")
    if not value.strip():
        raise ValueError(f"{label}不能为空白字符")
    cleaned = value.strip() if strip_value else value
    if reject_whitespace and any(ch.isspace() for ch in cleaned):
        raise ValueError(f"{label}不能包含空白字符")
    return cleaned


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VS_", env_file=".env", extra="ignore")

    environment: str = "dev"
    database_url: str = "postgresql+psycopg://vs:vs@127.0.0.1:5432/vs"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    # When set, the API also serves a built SPA (single-process deployment).
    web_dist: Path | None = None
    # 集成测试库；为空则跳过涉及数据库的测试
    test_database_url: str | None = None

    data_dir: Path = _REPO_ROOT / "data/market"
    market_sync_timeout_seconds: float = Field(default=20.0, gt=0)
    market_sync_max_attempts: int = Field(default=3, ge=1)

    jwt_secret: str = "dev-insecure-change-me-in-production"
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 14
    refresh_cookie_name: str = "vs_refresh_token"
    cookie_secure: bool = False

    llm_base_url: str | None = None
    llm_api_key: str | None = None
    llm_model: str = "gpt-4o-mini"
    llm_timeout_seconds: float = Field(default=12.0, gt=0)

    smtp_host: str | None = None
    smtp_port: int = Field(default=465, ge=1, le=65535)
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from_email: str | None = None
    smtp_from_name: str = "ValueSingularity 价值奇点"
    smtp_use_ssl: bool = True
    smtp_timeout_seconds: float = Field(default=15.0, gt=0)
    auth_require_email_verification: bool | None = None

    @property
    def smtp_configured(self) -> bool:
        return bool(
            self.smtp_host
            and self.smtp_host.strip()
            and self.smtp_username
            and self.smtp_username.strip()
            and self.smtp_password
            and self.smtp_password.strip()
            and self.smtp_from_name
            and self.smtp_from_name.strip()
        )

    @property
    def effective_require_email_verification(self) -> bool:
        if self.auth_require_email_verification is not None:
            return bool(self.auth_require_email_verification)
        return self.smtp_configured

    @field_validator("data_dir")
    @classmethod
    def _resolve_data_dir(cls, value: Path) -> Path:
        if not value.is_absolute():
            return (_REPO_ROOT / value).resolve()
        return value

    @field_validator("smtp_host")
    @classmethod
    def _validate_smtp_host(cls, value: str | None) -> str | None:
        return _normalize_optional_smtp_value(value, label="VS_SMTP_HOST", reject_whitespace=True)

    @field_validator("smtp_username")
    @classmethod
    def _validate_smtp_username(cls, value: str | None) -> str | None:
        return _normalize_optional_smtp_value(value, label="VS_SMTP_USERNAME")

    @field_validator("smtp_password")
    @classmethod
    def _validate_smtp_password(cls, value: str | None) -> str | None:
        return _normalize_optional_smtp_value(value, label="VS_SMTP_PASSWORD", strip_value=False)

    @field_validator("smtp_from_email")
    @classmethod
    def _validate_smtp_from_email(cls, value: str | None) -> str | None:
        cleaned = _normalize_optional_smtp_value(
            value, label="VS_SMTP_FROM_EMAIL", reject_whitespace=True
        )
        if cleaned is not None:
            try:
                validate_email(cleaned, check_deliverability=False)
            except EmailNotValidError as exc:
                raise ValueError("VS_SMTP_FROM_EMAIL 格式无效") from exc
        return cleaned

    @field_validator("smtp_from_name")
    @classmethod
    def _validate_smtp_from_name(cls, value: str) -> str:
        if _has_control_chars(value) or not value.strip():
            raise ValueError("VS_SMTP_FROM_NAME 不能为空或包含控制字符")
        return value.strip()

    @model_validator(mode="after")
    def _validate_prod_and_smtp_config(self) -> Self:
        if self.environment != "dev" and (
            self.jwt_secret == "dev-insecure-change-me-in-production" or len(self.jwt_secret) < 32
        ):
            raise ValueError("生产环境必须配置至少 32 字符的 VS_JWT_SECRET")
        if self.auth_require_email_verification is True and not self.smtp_configured:
            raise ValueError(
                "启用 VS_AUTH_REQUIRE_EMAIL_VERIFICATION=true 时必须完整配置 SMTP 参数"
            )
        if self.smtp_configured:
            effective_from_email = (self.smtp_from_email or self.smtp_username or "").strip()
            try:
                validate_email(effective_from_email, check_deliverability=False)
            except EmailNotValidError as exc:
                raise ValueError(
                    "发件人邮箱（VS_SMTP_FROM_EMAIL 或 VS_SMTP_USERNAME）格式无效"
                ) from exc
        return self


settings = Settings()
