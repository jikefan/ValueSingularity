"""Domain models — the API contract.

Every field here is part of the public contract; the web client mirrors these in
``apps/web/src/types/api.ts``. Keep them free of framework and storage details.
"""

from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

from app.domain.url_safety import validate_public_http_url, validate_public_webhook_url

FiniteFloat = Annotated[float, Field(allow_inf_nan=False)]
StockExchange = Literal["SH", "SZ", "BJ"]
_ASCII_STOCK_CODE_PATTERN = r"^[0-9]{6}$"
_INT64_MIN = -9_223_372_036_854_775_808
_INT64_MAX = 9_223_372_036_854_775_807


def _reject_nul(value: str, label: str = "文本") -> str:
    if "\x00" in value:
        raise ValueError(f"{label}不能包含空字符")
    return value


def _require_ascii_digits(value: str) -> str:
    if not value.isascii():
        raise ValueError("验证码必须为 6 位数字")
    return value


class TemperatureLevel(StrEnum):
    """A-share market temperature bucket, from cold to hot."""

    COLD = "cold"
    COOL = "cool"
    NEUTRAL = "neutral"
    WARM = "warm"
    HOT = "hot"


class PlanTier(StrEnum):
    """Subscription tier governing feature entitlements."""

    FREE = "free"
    PRO = "pro"
    AI_PLUS = "ai_plus"


class IndexQuote(BaseModel):
    code: str
    name: str
    price: FiniteFloat
    change_pct: FiniteFloat = Field(description="涨跌幅，百分数（-1.2 表示 -1.2%）")


class MarketTemperature(BaseModel):
    score: FiniteFloat = Field(ge=0, le=100, description="0=冰点，100=过热")
    level: TemperatureLevel
    pe_median: FiniteFloat = Field(description="全市场 PE 中位数")
    pe_percentile: FiniteFloat = Field(ge=0, le=100, description="历史分位，百分数")
    bond_yield: FiniteFloat = Field(description="十年国债收益率，百分数")
    equity_bond_spread: FiniteFloat = Field(description="股债性价比（EP - 国债收益率），百分数")
    comment: str


class IndustryFlow(BaseModel):
    name: str
    change_pct: FiniteFloat
    net_inflow: FiniteFloat = Field(description="净流入，单位：元")
    companies: int | None = Field(default=None, ge=0)


class StyleRegimeIndex(BaseModel):
    code: str
    name: str
    market: Literal["A", "US"] = "A"
    style: Literal["tech", "dividend", "broad"] = "broad"
    as_of: date | None = None
    close: FiniteFloat | None = None
    change_1d_pct: FiniteFloat | None = None
    change_5d_pct: FiniteFloat | None = None
    change_20d_pct: FiniteFloat | None = None
    drawdown_60d_pct: FiniteFloat | None = Field(
        default=None,
        description="相对近60个交易日高点回撤，百分数（<= 0 表示回撤幅度）",
    )


class CrossAssetMacroSnapshot(BaseModel):
    as_of: date | None = None
    us_bond_as_of: date | None = None
    us_2y_yield: FiniteFloat | None = None
    us_10y_yield: FiniteFloat | None = None
    us_10y_2y_spread: FiniteFloat | None = None
    cn_10y_yield: FiniteFloat | None = None
    us_cn_10y_spread: FiniteFloat | None = None
    us_2y_change_20d_bps: FiniteFloat | None = None
    us_10y_change_20d_bps: FiniteFloat | None = None
    us_cpi_yoy: FiniteFloat | None = None
    us_cpi_as_of: date | None = None
    us_real_yield_proxy_pct: FiniteFloat | None = None
    gold_price_cny: FiniteFloat | None = None
    gold_symbol: str | None = None
    gold_as_of: date | None = None
    gold_change_5d_pct: FiniteFloat | None = None
    gold_change_20d_pct: FiniteFloat | None = None
    gold_percentile_1y: FiniteFloat | None = Field(default=None, ge=0, le=100)
    gold_etf_tonnes: FiniteFloat | None = None
    gold_etf_delta_tonnes: FiniteFloat | None = None
    gold_etf_as_of: date | None = None
    style_indices: list[StyleRegimeIndex] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class MarketOverview(BaseModel):
    schema_version: int = 1
    as_of: date
    data_source: str = "akshare"
    generated_at: datetime
    indices: list[IndexQuote]
    benchmark_indices: list[IndexQuote] = Field(default_factory=list)
    temperature: MarketTemperature
    hot_industries: list[IndustryFlow]
    cross_asset: CrossAssetMacroSnapshot | None = None


class StockMetaRecord(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    name: str = Field(min_length=1, max_length=64)
    exchange: StockExchange
    industry_sw1: str | None = None
    industry_sw2: str | None = None
    list_date: date | None = None
    is_st: bool = False
    is_active: bool = True
    snapshot_available: bool = False


class StockDetail(StockMetaRecord):
    pass


class TradeCalendarEntry(BaseModel):
    trade_date: date
    is_open: bool = True


class IndexDailyRow(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    trade_date: date
    close: FiniteFloat
    change_pct: FiniteFloat
    pe_ttm: FiniteFloat | None = None
    pb: FiniteFloat | None = None
    turnover: FiniteFloat | None = None


class MacroRateRow(BaseModel):
    trade_date: date
    cn_10y_bond_yield: FiniteFloat
    market_pe_median: FiniteFloat = Field(gt=0)


class MarketFeedBundle(BaseModel):
    as_of: date
    data_source: str = "akshare"
    indices: list[IndexQuote]
    hot_industries: list[IndustryFlow]
    stock_list: list[StockMetaRecord]
    trade_calendar: list[TradeCalendarEntry]
    index_daily: list[IndexDailyRow]
    macro_rates: list[MacroRateRow]
    cross_asset: CrossAssetMacroSnapshot | None = None


class SyncSummary(BaseModel):
    as_of: date
    data_source: str
    stock_count: int = Field(ge=0)
    trade_calendar_count: int = Field(ge=0)
    index_daily_count: int = Field(ge=0)
    macro_rate_count: int = Field(ge=0)
    temperature_score: FiniteFloat = Field(ge=0, le=100)
    temperature_level: TemperatureLevel


class Health(BaseModel):
    status: str
    version: str


class UserProfile(BaseModel):
    id: UUID
    email: str | None
    phone: str | None
    display_name: str
    email_verified: bool = False
    plan_tier: PlanTier
    plan_expires_at: datetime | None = None
    created_at: datetime


class UserAuthRecord(UserProfile):
    password_hash: str
    is_active: bool
    email_verified_at: datetime | None = None
    token_version: int = 1


class AuthenticatedUser(BaseModel):
    id: UUID
    plan_tier: PlanTier
    token_version: int = 1


EmailCodePurpose = Literal["register", "reset_password", "verify_email", "delete_account"]
PublicEmailCodePurpose = Literal["register", "reset_password"]
AuthenticatedEmailCodePurpose = Literal["verify_email", "delete_account"]


class AuthConfigResponse(BaseModel):
    email_verification_required: bool
    smtp_configured: bool
    code_ttl_minutes: int = 10
    code_cooldown_seconds: int = 60


class EmailCodeSendRequest(BaseModel):
    email: EmailStr
    purpose: PublicEmailCodePurpose


class AuthenticatedEmailCodeRequest(BaseModel):
    purpose: AuthenticatedEmailCodePurpose


class EmailCodeSendResponse(BaseModel):
    sent: bool = True
    expires_in_seconds: int = Field(ge=1)
    cooldown_seconds: int = Field(ge=1)
    message: str


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=64)
    verification_code: str | None = Field(default=None, pattern=r"^\d{6}$")

    @field_validator("password")
    @classmethod
    def _validate_password_no_nul(cls, value: str) -> str:
        return _reject_nul(value, "密码")

    @field_validator("display_name")
    @classmethod
    def _strip_display_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("昵称不能为空")
        return _reject_nul(cleaned, "昵称")

    @field_validator("verification_code")
    @classmethod
    def _validate_verification_code(cls, value: str | None) -> str | None:
        return _require_ascii_digits(value) if value is not None else None


class VerifyEmailRequest(BaseModel):
    verification_code: str = Field(pattern=r"^\d{6}$")

    @field_validator("verification_code")
    @classmethod
    def _validate_verification_code(cls, value: str) -> str:
        return _require_ascii_digits(value)


class PasswordResetConfirmRequest(BaseModel):
    email: EmailStr
    verification_code: str = Field(pattern=r"^\d{6}$")
    new_password: str = Field(min_length=8, max_length=128)

    @field_validator("verification_code")
    @classmethod
    def _validate_verification_code(cls, value: str) -> str:
        return _require_ascii_digits(value)

    @field_validator("new_password")
    @classmethod
    def _validate_new_password_no_nul(cls, value: str) -> str:
        return _reject_nul(value, "新密码")


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)

    @field_validator("current_password")
    @classmethod
    def _validate_current_password_no_nul(cls, value: str) -> str:
        return _reject_nul(value, "当前密码")

    @field_validator("new_password")
    @classmethod
    def _validate_new_password_no_nul(cls, value: str) -> str:
        return _reject_nul(value, "新密码")


class UserProfileUpdateRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=64)

    @field_validator("display_name", mode="before")
    @classmethod
    def _strip_display_name(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("display_name")
    @classmethod
    def _validate_display_name_no_nul(cls, value: str) -> str:
        return _reject_nul(value, "昵称")


class DeleteAccountRequest(BaseModel):
    password: str = Field(min_length=1, max_length=128)
    verification_code: str | None = Field(default=None, pattern=r"^\d{6}$")

    @field_validator("password")
    @classmethod
    def _validate_password_no_nul(cls, value: str) -> str:
        return _reject_nul(value, "密码")

    @field_validator("verification_code")
    @classmethod
    def _validate_verification_code(cls, value: str | None) -> str | None:
        return _require_ascii_digits(value) if value is not None else None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserProfile


class AuthSession(BaseModel):
    token: TokenResponse
    raw_refresh_token: str


class RefreshTokenRecord(BaseModel):
    id: UUID
    user_id: UUID
    family_id: UUID
    token_hash: str
    expires_at: datetime
    revoked_at: datetime | None
    revoked_reason: str | None = None


class RefreshRotationStatus(StrEnum):
    ROTATED = "rotated"
    NOT_FOUND = "not_found"
    EXPIRED = "expired"
    REPLAYED = "replayed"
    INACTIVE = "inactive"


class RefreshRotationResult(BaseModel):
    status: RefreshRotationStatus
    user: UserAuthRecord | None = None


class PasswordResetStatus(StrEnum):
    UPDATED = "updated"
    INVALID_CODE = "invalid_code"
    INACTIVE = "inactive"


class PasswordChangeStatus(StrEnum):
    UPDATED = "updated"
    NOT_FOUND = "not_found"
    INACTIVE = "inactive"


class PasswordChangeResult(BaseModel):
    status: PasswordChangeStatus
    user: UserAuthRecord | None = None


class WatchlistItem(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    name: str
    industry: str | None = None
    note: str | None = None
    target_price: float | None = None
    target_pe_percentile: float | None = None
    target_dividend_yield: float | None = None
    alert_enabled: bool = False
    added_at: datetime
    updated_at: datetime


class WatchlistUpsert(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    name: str = Field(min_length=1, max_length=64)
    industry: str | None = Field(default=None, max_length=64)
    note: str | None = None
    target_price: float | None = Field(
        default=None, ge=0.001, le=999_999_999.999, allow_inf_nan=False
    )
    target_pe_percentile: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    target_dividend_yield: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    alert_enabled: bool = False

    @field_validator("name", mode="before")
    @classmethod
    def _strip_name(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("industry", mode="before")
    @classmethod
    def _strip_industry(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator("name", "industry", "note")
    @classmethod
    def _validate_no_nul(cls, value: str | None) -> str | None:
        return _reject_nul(value) if value is not None else None


class JournalAction(StrEnum):
    """Supported investment decision actions in the journal."""

    BUY = "buy"
    SELL = "sell"
    ADD = "add"
    TRIM = "trim"
    PASS = "pass"


class FalsifyRule(BaseModel):
    metric: str = Field(min_length=1, max_length=64)
    op: Literal["lt", "lte", "gt", "gte", "eq"]
    value: FiniteFloat
    periods: int = Field(default=1, ge=1, le=40)

    @field_validator("metric", mode="before")
    @classmethod
    def _strip_metric(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("metric")
    @classmethod
    def _validate_metric_no_nul(cls, value: str) -> str:
        return _reject_nul(value, "指标名称")


class JournalCreate(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    name: str | None = Field(default=None, max_length=64)
    action: JournalAction
    reason: str = Field(min_length=1, max_length=5000)
    falsify_condition: str = Field(min_length=1, max_length=5000)
    falsify_rules: list[FalsifyRule] | None = Field(default=None, max_length=20)
    max_drawdown: FiniteFloat | None = Field(default=None, ge=0, le=100)
    emotion: str | None = Field(default=None, max_length=32)
    price: FiniteFloat | None = Field(default=None, ge=0.001, le=999_999_999.999)
    benchmark_code: str = Field(default="000300", pattern=_ASCII_STOCK_CODE_PATTERN)
    benchmark_price: FiniteFloat | None = Field(default=None, ge=0.001, le=999_999_999.999)

    @field_validator("name", "emotion", mode="before")
    @classmethod
    def _strip_optional_text(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator("reason", "falsify_condition", mode="before")
    @classmethod
    def _strip_required_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("name", "reason", "falsify_condition", "emotion")
    @classmethod
    def _validate_no_nul(cls, value: str | None) -> str | None:
        return _reject_nul(value) if value is not None else None


class JournalTimeCapsule(BaseModel):
    as_of: date | None = None
    close: FiniteFloat | None = None
    pe_ttm: FiniteFloat | None = None
    pe_percentile_10y: FiniteFloat | None = None
    pb: FiniteFloat | None = None
    dividend_yield_pct: FiniteFloat | None = None
    implied_fcf_cagr_pct: FiniteFloat | None = None
    roe_5y_avg_pct: FiniteFloat | None = None
    ct_red_count: int | None = None
    ct_yellow_count: int | None = None
    total_score: int | None = None
    benchmark_code: str = "000300"
    benchmark_price: FiniteFloat | None = None
    benchmark_as_of: date | None = None


class JournalEntryItem(BaseModel):
    id: int
    code: str
    name: str | None = None
    action: JournalAction
    reason: str
    falsify_condition: str
    falsify_rules: list[FalsifyRule] | None = None
    max_drawdown: float | None = None
    emotion: str | None = None
    price: float | None = None
    benchmark_code: str
    benchmark_price: float | None = None
    snapshot: JournalTimeCapsule | None = None
    created_at: datetime


class JournalEntryComparison(BaseModel):
    id: int
    code: str
    name: str | None = None
    action: JournalAction
    emotion: str | None = None
    created_at: datetime
    entry_price: FiniteFloat | None = None
    current_price: FiniteFloat | None = None
    stock_return_pct: FiniteFloat | None = None
    entry_benchmark_price: FiniteFloat | None = None
    current_benchmark_price: FiniteFloat | None = None
    benchmark_return_pct: FiniteFloat | None = None
    excess_return_pct: FiniteFloat | None = None
    entry_pe_ttm: FiniteFloat | None = None
    current_pe_ttm: FiniteFloat | None = None
    entry_score: int | None = None
    current_score: int | None = None
    days_held: int = Field(ge=0)
    falsify_triggered: bool = False
    falsify_triggers: list[str] = Field(default_factory=list)


class EmotionLedgerRow(BaseModel):
    emotion: str
    total_count: int = Field(ge=0)
    comparable_count: int = Field(ge=0)
    win_count: int = Field(ge=0)
    win_rate_pct: FiniteFloat | None = None
    avg_stock_return_pct: FiniteFloat | None = None
    avg_excess_return_pct: FiniteFloat | None = None


class ActionLedgerRow(BaseModel):
    action: JournalAction
    total_count: int = Field(ge=0)
    comparable_count: int = Field(ge=0)
    win_count: int = Field(ge=0)
    win_rate_pct: FiniteFloat | None = None
    avg_stock_return_pct: FiniteFloat | None = None
    avg_excess_return_pct: FiniteFloat | None = None


class DecisionLedgerReport(BaseModel):
    total_entries: int = Field(ge=0)
    comparable_count: int = Field(ge=0)
    win_count: int = Field(ge=0)
    win_rate_pct: FiniteFloat | None = None
    avg_stock_return_pct: FiniteFloat | None = None
    avg_excess_return_pct: FiniteFloat | None = None
    pass_count: int = Field(ge=0)
    pass_avoided_loss_count: int = Field(ge=0)
    current_benchmark_code: str = "000300"
    current_benchmark_price: FiniteFloat | None = None
    benchmark_as_of: date | None = None
    by_emotion: list[EmotionLedgerRow]
    by_action: list[ActionLedgerRow]
    items: list[JournalEntryComparison]


AlertSourceType = Literal["watchlist_sentinel", "journal_falsify"]
WebhookChannel = Literal["feishu", "wecom", "custom"]


class NotificationPreferences(BaseModel):
    in_app_enabled: bool = True
    webhook_enabled: bool = False
    channel_type: WebhookChannel = "feishu"
    webhook_url_configured: bool = False
    webhook_url_masked: str | None = None


class StoredNotificationConfig(BaseModel):
    in_app_enabled: bool = True
    webhook_enabled: bool = False
    channel_type: WebhookChannel = "feishu"
    webhook_url: str | None = None


class NotificationPreferencesUpdate(BaseModel):
    in_app_enabled: bool = True
    webhook_enabled: bool = False
    channel_type: WebhookChannel = "feishu"
    webhook_url: str | None = Field(default=None, max_length=500)

    @field_validator("webhook_url", mode="before")
    @classmethod
    def _clean_webhook_url(cls, value: object) -> object:
        if value is None or not isinstance(value, str):
            return value
        if any(ch == "\x00" or ord(ch) < 32 or ord(ch) == 127 for ch in value):
            raise ValueError("Webhook URL 不能包含空字符或控制字符")
        return value.strip()

    @field_validator("webhook_url")
    @classmethod
    def _validate_webhook_url(cls, value: str | None) -> str | None:
        if value is None or value == "":
            return value
        return validate_public_webhook_url(value)

    @model_validator(mode="after")
    def _reject_clearing_url_when_enabled(self) -> Self:
        if self.webhook_enabled and self.webhook_url == "":
            raise ValueError("启用 Webhook 推送时不能同时清空 Webhook URL")
        return self


class TriggeredAlertCandidate(BaseModel):
    user_id: UUID
    source_type: AlertSourceType
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    stock_name: str | None = None
    trigger_date: date
    rule_signature: str = Field(min_length=1, max_length=64)
    matched_conditions: list[str]
    detail: str
    current_price: FiniteFloat | None = None
    current_pe_percentile: FiniteFloat | None = None
    current_dividend_yield_pct: FiniteFloat | None = None


class AlertDeliveryItem(BaseModel):
    id: int
    source_type: AlertSourceType
    code: str
    stock_name: str | None = None
    trigger_date: date
    rule_signature: str
    matched_conditions: list[str]
    detail: str
    current_price: FiniteFloat | None = None
    current_pe_percentile: FiniteFloat | None = None
    current_dividend_yield_pct: FiniteFloat | None = None
    channel: str
    status: str
    created_at: datetime


class AlertScanSummary(BaseModel):
    as_of: date | None = None
    users_scanned: int = Field(default=1, ge=0)
    evaluated_rules: int = Field(default=0, ge=0)
    matched_count: int = Field(default=0, ge=0)
    newly_triggered_count: int = Field(default=0, ge=0)
    webhook_sent_count: int = Field(default=0, ge=0)
    webhook_failed_count: int = Field(default=0, ge=0)
    deliveries: list[AlertDeliveryItem] = Field(default_factory=list)


EventMetaValue = str | int | FiniteFloat | bool | None


class UserEventCreate(BaseModel):
    type: str = Field(min_length=1, max_length=32)
    code: str | None = Field(default=None, pattern=_ASCII_STOCK_CODE_PATTERN)
    meta: dict[str, EventMetaValue] | None = Field(default=None, max_length=20)

    @field_validator("type", mode="before")
    @classmethod
    def _strip_type(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("type")
    @classmethod
    def _validate_type_no_nul(cls, value: str) -> str:
        return _reject_nul(value, "事件类型")

    @field_validator("meta")
    @classmethod
    def _validate_meta(
        cls, value: dict[str, EventMetaValue] | None
    ) -> dict[str, EventMetaValue] | None:
        if value is None:
            return None
        if len(value) > 20:
            raise ValueError("meta 最多包含 20 个字段")
        for key, item in value.items():
            if not key.strip() or len(key) > 64 or "\x00" in key:
                raise ValueError("meta 键名须为 1–64 个非空字符且不能包含空字符")
            if isinstance(item, bool):
                continue
            if isinstance(item, int) and (item < _INT64_MIN or item > _INT64_MAX):
                raise ValueError("meta 整数值超出 64 位范围")
            if isinstance(item, str) and (len(item) > 500 or "\x00" in item):
                raise ValueError("meta 字符串值不能超过 500 个字符且不能包含空字符")
        return value


class UserEventItem(BaseModel):
    id: int
    type: str
    code: str | None = None
    meta: dict[str, EventMetaValue] | None = None
    ts: datetime


SignalLight = Literal["green", "yellow", "red", "na"]


class StockDailyBar(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    trade_date: date
    open: FiniteFloat
    high: FiniteFloat
    low: FiniteFloat
    close: FiniteFloat
    volume: FiniteFloat | None = None
    amount: FiniteFloat | None = None
    outstanding_share: FiniteFloat | None = None
    turnover: FiniteFloat | None = None
    total_mv_yuan: FiniteFloat | None = None
    pe_ttm: FiniteFloat | None = None
    pb: FiniteFloat | None = None
    pcf: FiniteFloat | None = None


class StockAnnualReport(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    report_year: int = Field(ge=1990, le=2100)
    report_date: date
    notice_date: date | None = None
    update_date: date | None = None
    audit_opinion: str | None = None
    revenue_yuan: FiniteFloat | None = None
    operate_cost_yuan: FiniteFloat | None = None
    net_profit_yuan: FiniteFloat | None = None
    deduct_net_profit_yuan: FiniteFloat | None = None
    research_expense_yuan: FiniteFloat | None = None
    interest_expense_yuan: FiniteFloat | None = None
    finance_expense_yuan: FiniteFloat | None = None
    total_assets_yuan: FiniteFloat | None = None
    total_liabilities_yuan: FiniteFloat | None = None
    total_equity_yuan: FiniteFloat | None = None
    parent_equity_yuan: FiniteFloat | None = None
    monetary_funds_yuan: FiniteFloat | None = None
    trade_fin_assets_yuan: FiniteFloat | None = None
    short_loan_yuan: FiniteFloat | None = None
    noncurrent_liab_1y_yuan: FiniteFloat | None = None
    long_loan_yuan: FiniteFloat | None = None
    bond_payable_yuan: FiniteFloat | None = None
    short_bond_payable_yuan: FiniteFloat | None = None
    lease_liab_yuan: FiniteFloat | None = None
    cip_yuan: FiniteFloat | None = None
    fixed_asset_yuan: FiniteFloat | None = None
    accounts_receivable_yuan: FiniteFloat | None = None
    note_accounts_rece_yuan: FiniteFloat | None = None
    inventory_yuan: FiniteFloat | None = None
    goodwill_yuan: FiniteFloat | None = None
    share_capital_yuan: FiniteFloat | None = None
    ocf_yuan: FiniteFloat | None = None
    capex_yuan: FiniteFloat | None = None
    accept_invest_cash_yuan: FiniteFloat | None = None
    subsidiary_accept_invest_yuan: FiniteFloat | None = None
    cash_dividend_paid_yuan: FiniteFloat | None = None
    operate_profit_yuan: FiniteFloat | None = None
    sale_expense_yuan: FiniteFloat | None = None
    manage_expense_yuan: FiniteFloat | None = None
    operate_tax_add_yuan: FiniteFloat | None = None
    invest_income_yuan: FiniteFloat | None = None
    invest_joint_income_yuan: FiniteFloat | None = None
    fair_value_change_yuan: FiniteFloat | None = None
    other_income_yuan: FiniteFloat | None = None
    asset_disposal_yuan: FiniteFloat | None = None
    impairment_net_yuan: FiniteFloat | None = None
    nonbusiness_net_yuan: FiniteFloat | None = None
    long_equity_invest_yuan: FiniteFloat | None = None
    invest_property_and_other_fin_yuan: FiniteFloat | None = None


class StockDividendRecord(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    report_date: date
    report_year: int = Field(ge=1990, le=2100)
    ex_dividend_date: date | None = None
    notice_date: date | None = None
    plan_progress: str
    cash_per_10_shares: FiniteFloat = Field(ge=0)
    total_shares: FiniteFloat = Field(gt=0)
    dividend_cash_total_yuan: FiniteFloat = Field(ge=0)
    dividend_yield_pct: FiniteFloat | None = None


class StockRepurchaseRecord(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    event_date: date
    year: int = Field(ge=1990, le=2100)
    start_date: date | None = None
    progress: str
    repurchased_amount_yuan: FiniteFloat = Field(ge=0)
    repurchased_shares: FiniteFloat | None = None


class StockPledgeSnapshot(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    trade_date: date
    pledge_ratio_pct: FiniteFloat = Field(ge=0)
    pledge_shares: FiniteFloat | None = None
    pledge_market_cap_yuan: FiniteFloat | None = None


class StockEquityFinancingRecord(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    year: int = Field(ge=1990, le=2100)
    event_date: date
    source: Literal["cash_flow", "add_stock"]
    financing_type: str
    amount_yuan: FiniteFloat = Field(ge=0)


class StockFactBundle(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    as_of: date
    data_source: str = "akshare"
    daily_bars: list[StockDailyBar]
    annual_reports: list[StockAnnualReport]
    dividends: list[StockDividendRecord]
    repurchases: list[StockRepurchaseRecord]
    pledge: StockPledgeSnapshot | None = None
    equity_financings: list[StockEquityFinancingRecord]
    profile_industry_sw1: str | None = None
    profile_industry_sw2: str | None = None
    profile_list_date: date | None = None


class CtRuleEvidence(BaseModel):
    year: int
    label: str
    metrics: dict[str, FiniteFloat | str | None]


class CtCheckItem(BaseModel):
    rule_id: str
    title: str
    status: SignalLight
    na_reason: Literal["industry_exempt", "missing_data"] | None = None
    summary: str
    threshold: str
    value_text: str
    evidences: list[CtRuleEvidence]


class FinancialCtSection(BaseModel):
    overall_status: SignalLight
    red_count: int = Field(ge=0)
    yellow_count: int = Field(ge=0)
    green_count: int = Field(ge=0)
    checks: list[CtCheckItem]


class AnnualReturnPoint(BaseModel):
    year: int
    dividend_yuan: FiniteFloat
    repurchase_yuan: FiniteFloat
    equity_financing_yuan: FiniteFloat
    net_return_yuan: FiniteFloat
    fcf_yuan: FiniteFloat | None = None


class ShareholderReturnSection(BaseModel):
    window_years: int = Field(ge=0)
    total_dividend_yuan: FiniteFloat
    total_repurchase_yuan: FiniteFloat
    total_equity_financing_yuan: FiniteFloat
    net_return_yuan: FiniteFloat
    total_fcf_yuan: FiniteFloat | None = None
    fcf_coverage_ratio: FiniteFloat | None = None
    current_dividend_yield_pct: FiniteFloat | None = None
    status: SignalLight
    verdict: str
    series: list[AnnualReturnPoint]


class ReverseDcfSensitivityRow(BaseModel):
    discount_rate_pct: FiniteFloat
    terminal_multiple: FiniteFloat
    implied_fcf_cagr_pct: FiniteFloat | None = None


class ReverseDcfSection(BaseModel):
    solvable: bool
    note: str
    market_cap_yuan: FiniteFloat | None = None
    enterprise_value_yuan: FiniteFloat | None = None
    net_cash_yuan: FiniteFloat | None = None
    base_fcf_yuan: FiniteFloat | None = None
    base_fcf_years: int = Field(ge=0)
    discount_rate_pct: FiniteFloat
    terminal_multiple: FiniteFloat
    implied_fcf_cagr_pct: FiniteFloat | None = None
    historical_revenue_cagr_pct: FiniteFloat | None = None
    implied_vs_history_gap_pct: FiniteFloat | None = None
    sensitivity: list[ReverseDcfSensitivityRow]


class ValuationHistoryPoint(BaseModel):
    trade_date: date
    close: FiniteFloat
    pe_ttm: FiniteFloat | None = None
    pb: FiniteFloat | None = None
    total_mv_yuan: FiniteFloat | None = None


class ValuationSection(BaseModel):
    latest_trade_date: date | None = None
    close: FiniteFloat | None = None
    total_mv_yuan: FiniteFloat | None = None
    pe_ttm: FiniteFloat | None = None
    pe_percentile_5y: FiniteFloat | None = None
    pe_percentile_10y: FiniteFloat | None = None
    pb: FiniteFloat | None = None
    pb_percentile_10y: FiniteFloat | None = None
    dividend_yield_pct: FiniteFloat | None = None
    graham_number: FiniteFloat | None = None
    graham_margin_pct: FiniteFloat | None = None
    peg: FiniteFloat | None = None
    history: list[ValuationHistoryPoint]


class AnnualFinancialTrendPoint(BaseModel):
    year: int
    revenue_yuan: FiniteFloat | None = None
    net_profit_yuan: FiniteFloat | None = None
    deduct_net_profit_yuan: FiniteFloat | None = None
    ocf_yuan: FiniteFloat | None = None
    fcf_yuan: FiniteFloat | None = None
    roe_pct: FiniteFloat | None = None
    gross_margin_pct: FiniteFloat | None = None
    net_margin_pct: FiniteFloat | None = None
    net_cash_yuan: FiniteFloat | None = None
    rd_ratio_pct: FiniteFloat | None = None


class MoatDimensionItem(BaseModel):
    key: str
    label: str
    score: int = Field(ge=0, le=100)
    summary: str


class MoatSection(BaseModel):
    roe_5y_avg_pct: FiniteFloat | None = None
    roe_10y_min_pct: FiniteFloat | None = None
    gross_margin_latest_pct: FiniteFloat | None = None
    gross_margin_5y_std_pct: FiniteFloat | None = None
    roic_approx_pct: FiniteFloat | None = None
    dimensions: list[MoatDimensionItem]


class GrowthSection(BaseModel):
    revenue_cagr_3y_pct: FiniteFloat | None = None
    revenue_cagr_5y_pct: FiniteFloat | None = None
    profit_cagr_5y_pct: FiniteFloat | None = None
    deduct_profit_cagr_5y_pct: FiniteFloat | None = None
    rd_ratio_latest_pct: FiniteFloat | None = None
    capex_to_ocf_latest_pct: FiniteFloat | None = None


class RadarScoreSection(BaseModel):
    profitability: int = Field(ge=0, le=100)
    moat: int = Field(ge=0, le=100)
    balance_sheet: int = Field(ge=0, le=100)
    cashflow_quality: int = Field(ge=0, le=100)
    valuation_margin: int = Field(ge=0, le=100)
    total_score: int = Field(ge=0, le=100)
    scoring_profile: Literal["standard", "financial"] = "standard"
    dimension_labels: dict[str, str] = Field(default_factory=dict)
    bear_cases: list[str]


EarningsQualityTag = Literal[
    "core_cash_cow",
    "investment_driven",
    "subsidy_inflated",
    "cashflow_divergent",
    "leveraged_roe",
    "balanced_steady",
    "financial_special",
]


class AnnualEarningsDecompositionPoint(BaseModel):
    year: int
    revenue_yuan: FiniteFloat | None = None
    operate_profit_yuan: FiniteFloat | None = None
    core_operating_profit_yuan: FiniteFloat | None = None
    investment_and_fair_value_yuan: FiniteFloat | None = None
    subsidy_and_oneoff_yuan: FiniteFloat | None = None
    impairment_net_yuan: FiniteFloat | None = None
    net_profit_yuan: FiniteFloat | None = None
    deduct_net_profit_yuan: FiniteFloat | None = None
    ocf_yuan: FiniteFloat | None = None
    core_operating_margin_pct: FiniteFloat | None = None
    invest_share_of_op_profit_pct: FiniteFloat | None = None


class DupontYearPoint(BaseModel):
    year: int
    roe_pct: FiniteFloat | None = None
    net_margin_pct: FiniteFloat | None = None
    asset_turnover: FiniteFloat | None = None
    equity_multiplier: FiniteFloat | None = None


class CapitalAllocationSummary(BaseModel):
    window_years: int = Field(ge=0)
    total_ocf_yuan: FiniteFloat | None = None
    total_capex_yuan: FiniteFloat | None = None
    total_dividends_yuan: FiniteFloat = 0.0
    total_repurchases_yuan: FiniteFloat = 0.0
    total_equity_financing_yuan: FiniteFloat = 0.0
    net_debt_change_yuan: FiniteFloat | None = None
    ending_net_cash_yuan: FiniteFloat | None = None
    ending_investment_assets_yuan: FiniteFloat | None = None
    capex_to_ocf_pct: FiniteFloat | None = None
    payout_to_ocf_pct: FiniteFloat | None = None
    allocation_style: str
    summary: str


class ForensicFinding(BaseModel):
    finding_id: str
    title: str
    status: SignalLight
    headline: str
    detail: str
    metric_text: str


class StockForensicsSection(BaseModel):
    earnings_quality_tag: EarningsQualityTag
    earnings_quality_label: str
    verdict: str
    core_profit_share_3y_pct: FiniteFloat | None = None
    invest_profit_share_3y_pct: FiniteFloat | None = None
    non_recurring_share_3y_pct: FiniteFloat | None = None
    ocf_to_core_profit_3y_pct: FiniteFloat | None = None
    interest_burden_pct: FiniteFloat | None = None
    investment_assets_yuan: FiniteFloat | None = None
    investment_assets_ratio_pct: FiniteFloat | None = None
    dupont_roe_5y_avg_pct: FiniteFloat | None = None
    dupont_net_margin_5y_avg_pct: FiniteFloat | None = None
    dupont_asset_turnover_5y_avg: FiniteFloat | None = None
    dupont_equity_multiplier_5y_avg: FiniteFloat | None = None
    findings: list[ForensicFinding] = Field(default_factory=list)
    annual_decomposition: list[AnnualEarningsDecompositionPoint] = Field(default_factory=list)
    dupont_series: list[DupontYearPoint] = Field(default_factory=list)
    capital_allocation: CapitalAllocationSummary | None = None


class PeerBenchmarkMetrics(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    name: str
    exchange: StockExchange
    industry_sw1: str | None = None
    as_of: date | None = None
    close: FiniteFloat | None = None
    total_mv_yuan: FiniteFloat | None = None
    pe_ttm: FiniteFloat | None = None
    pe_percentile_10y: FiniteFloat | None = None
    pb: FiniteFloat | None = None
    roe_5y_avg_pct: FiniteFloat | None = None
    gross_margin_latest_pct: FiniteFloat | None = None
    net_cash_to_mv_pct: FiniteFloat | None = None
    ocf_to_profit_5y_pct: FiniteFloat | None = None
    shareholder_yield_pct: FiniteFloat | None = None
    implied_fcf_cagr_pct: FiniteFloat | None = None
    ct_red_count: int = Field(ge=0)
    ct_yellow_count: int = Field(ge=0)
    total_score: int = Field(ge=0, le=100)
    is_financial: bool = False
    earnings_quality_tag: EarningsQualityTag | None = None
    earnings_quality_label: str | None = None
    invest_profit_share_3y_pct: FiniteFloat | None = None
    investment_assets_ratio_pct: FiniteFloat | None = None


class StockSnapshotPayload(BaseModel):
    schema_version: int = 1
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    name: str
    exchange: StockExchange
    industry_sw1: str | None = None
    industry_sw2: str | None = None
    as_of: date
    generated_at: datetime
    data_source: str = "akshare"
    annual_trends: list[AnnualFinancialTrendPoint]
    valuation: ValuationSection
    reverse_dcf: ReverseDcfSection
    financial_ct: FinancialCtSection
    shareholder_return: ShareholderReturnSection
    moat: MoatSection
    growth: GrowthSection
    radar: RadarScoreSection
    forensics: StockForensicsSection | None = None
    peer_metrics: PeerBenchmarkMetrics
    pledge_ratio_pct: FiniteFloat | None = None
    pledge_date: date | None = None
    latest_audit_opinion: str | None = None
    formula_notes: dict[str, str]


class StockCompareItem(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    meta: StockMetaRecord
    snapshot_available: bool
    snapshot_as_of: date | None = None
    metrics: PeerBenchmarkMetrics | None = None


ScreenerSortField = Literal[
    "total_score",
    "pe_percentile_10y",
    "roe_5y_avg_pct",
    "dividend_yield_pct",
    "pe_ttm",
    "total_mv_yuan",
]
ScreenerSortDir = Literal["asc", "desc"]
ScreenerQualityFilter = Literal["all", "core_only", "hide_investment_heavy", "dividend_fortress"]


class StockScreenerItem(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    name: str
    exchange: StockExchange
    industry_sw1: str | None = None
    as_of: date
    close: FiniteFloat | None = None
    total_mv_yuan: FiniteFloat | None = None
    pe_ttm: FiniteFloat | None = None
    pe_percentile_10y: FiniteFloat | None = None
    pb: FiniteFloat | None = None
    pb_percentile_10y: FiniteFloat | None = None
    roe_5y_avg_pct: FiniteFloat | None = None
    dividend_yield_pct: FiniteFloat | None = None
    shareholder_yield_pct: FiniteFloat | None = None
    implied_fcf_cagr_pct: FiniteFloat | None = None
    ct_red_count: int = Field(ge=0)
    ct_yellow_count: int = Field(ge=0)
    ct_green_count: int = Field(ge=0)
    total_score: int = Field(ge=0, le=100)
    valuation_margin: int = Field(ge=0, le=100)
    is_financial: bool = False
    earnings_quality_tag: EarningsQualityTag | None = None
    earnings_quality_label: str | None = None
    invest_profit_share_3y_pct: FiniteFloat | None = None
    investment_assets_ratio_pct: FiniteFloat | None = None


class StockScreenerResponse(BaseModel):
    total_synced: int = Field(ge=0)
    filtered_count: int = Field(ge=0)
    industries: list[str]
    items: list[StockScreenerItem]


DiscoveryThemeId = Literal[
    "gold_fed_cycle",
    "tech_vs_dividend_rotation",
    "earnings_quality_radar",
    "deep_value_fortress",
]


class DiscoveryStockPick(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    name: str
    industry_sw1: str | None = None
    close: FiniteFloat | None = None
    pe_ttm: FiniteFloat | None = None
    pe_percentile_10y: FiniteFloat | None = None
    pb: FiniteFloat | None = None
    dividend_yield_pct: FiniteFloat | None = None
    dividend_spread_over_bond_pct: FiniteFloat | None = None
    roe_5y_avg_pct: FiniteFloat | None = None
    net_cash_to_mv_pct: FiniteFloat | None = None
    graham_margin_pct: FiniteFloat | None = None
    fcf_coverage_ratio: FiniteFloat | None = None
    ct_red_count: int = Field(ge=0)
    total_score: int = Field(ge=0, le=100)
    is_financial: bool = False
    earnings_quality_tag: EarningsQualityTag | None = None
    earnings_quality_label: str | None = None
    invest_profit_share_3y_pct: FiniteFloat | None = None
    investment_assets_ratio_pct: FiniteFloat | None = None
    reason: str


class DiscoveryThemeMetric(BaseModel):
    label: str
    value_text: str
    tone: SignalLight = "na"


class DiscoveryThemeCard(BaseModel):
    theme_id: DiscoveryThemeId
    title: str
    subtitle: str
    signal: SignalLight
    verdict: str
    regime_summary: str
    metrics: list[DiscoveryThemeMetric] = Field(default_factory=list)
    picks: list[DiscoveryStockPick] = Field(default_factory=list)
    caution_picks: list[DiscoveryStockPick] = Field(default_factory=list)
    compare_codes: list[str] = Field(default_factory=list)


class DiscoveryCandidateBuckets(BaseModel):
    dividend_fortresses: list[DiscoveryStockPick] = Field(default_factory=list)
    gold_resources: list[DiscoveryStockPick] = Field(default_factory=list)
    core_cash_cows: list[DiscoveryStockPick] = Field(default_factory=list)
    investment_cautions: list[DiscoveryStockPick] = Field(default_factory=list)
    deep_value: list[DiscoveryStockPick] = Field(default_factory=list)


class MarketDiscoveryResponse(BaseModel):
    as_of: date
    generated_at: datetime
    synced_stock_count: int = Field(ge=0)
    temperature: MarketTemperature
    cross_asset: CrossAssetMacroSnapshot | None = None
    themes: list[DiscoveryThemeCard] = Field(default_factory=list)
    candidate_buckets: DiscoveryCandidateBuckets


class StockSyncSummary(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    as_of: date
    data_source: str
    daily_bars_count: int = Field(ge=0)
    annual_reports_count: int = Field(ge=0)
    ct_red_count: int = Field(ge=0)
    ct_yellow_count: int = Field(ge=0)
    implied_fcf_cagr_pct: FiniteFloat | None = None


AiExecutionMode = Literal["deterministic", "llm", "byok", "deterministic_fallback"]


class CitedMetricFact(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    value_text: str = Field(min_length=1, max_length=80)
    source_section: str = Field(min_length=1, max_length=64)


class DevilsAdvocateChallenge(BaseModel):
    index: int = Field(ge=1)
    title: str = Field(min_length=1, max_length=120)
    thesis: str = Field(min_length=1, max_length=2000)
    cited_facts: list[CitedMetricFact] = Field(default_factory=list)
    suggested_falsify_rule: FalsifyRule | None = None


class DevilsAdvocateRequest(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    action: JournalAction = JournalAction.BUY
    reason: str = Field(min_length=1, max_length=5000)
    falsify_condition: str = Field(default="", max_length=5000)
    mode: Literal["auto", "rule_only"] = "auto"

    @field_validator("reason", "falsify_condition", mode="before")
    @classmethod
    def _strip_ai_reason_texts(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("reason", "falsify_condition")
    @classmethod
    def _validate_ai_reason_no_nul(cls, value: str) -> str:
        return _reject_nul(value, "决策内容")


class AiQuotaStatus(BaseModel):
    plan_tier: PlanTier
    daily_limit: int = Field(ge=0)
    used_today: int = Field(ge=0)
    remaining_today: int = Field(ge=0)
    byok_active: bool
    resets_at_shanghai: str


class DevilsAdvocateResponse(BaseModel):
    code: str
    stock_name: str
    as_of: date | None = None
    mode: AiExecutionMode
    fallback_reason: str | None = None
    challenges: list[DevilsAdvocateChallenge]
    quota: AiQuotaStatus
    compliance_notice: str


class MdaDiffRequest(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    previous_period_label: str = Field(default="上期年报", min_length=1, max_length=40)
    current_period_label: str = Field(default="本期年报", min_length=1, max_length=40)
    previous_text: str = Field(default="", max_length=30000)
    current_text: str = Field(default="", max_length=30000)
    mode: Literal["auto", "rule_only"] = "auto"

    @field_validator(
        "previous_period_label",
        "current_period_label",
        "previous_text",
        "current_text",
        mode="before",
    )
    @classmethod
    def _strip_mda_texts(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator(
        "previous_period_label",
        "current_period_label",
        "previous_text",
        "current_text",
    )
    @classmethod
    def _validate_mda_no_nul(cls, value: str) -> str:
        return _reject_nul(value, "年报对比文本")


class MdaMetricShift(BaseModel):
    metric_label: str
    previous_text: str
    current_text: str
    delta_text: str
    severity: SignalLight
    interpretation: str


class MdaDiffHighlight(BaseModel):
    change_type: Literal["added", "removed", "modified"]
    category: str
    previous_excerpt: str | None = None
    current_excerpt: str | None = None
    signal_tags: list[str]
    severity: SignalLight


class MdaDiffResponse(BaseModel):
    code: str
    stock_name: str
    previous_period_label: str
    current_period_label: str
    mode: AiExecutionMode
    fallback_reason: str | None = None
    summary: str
    metric_shifts: list[MdaMetricShift]
    text_highlights: list[MdaDiffHighlight]
    quota: AiQuotaStatus
    compliance_notice: str


class AiPreferences(BaseModel):
    prefer_rule_only: bool = False
    byok_enabled: bool = False
    byok_base_url_masked: str | None = None
    byok_api_key_configured: bool = False
    byok_api_key_masked: str | None = None
    byok_model: str = "gpt-4o-mini"
    quota: AiQuotaStatus


class StoredAiConfig(BaseModel):
    prefer_rule_only: bool = False
    byok_enabled: bool = False
    byok_base_url: str | None = None
    byok_api_key: str | None = None
    byok_model: str = "gpt-4o-mini"


class AiPreferencesUpdate(BaseModel):
    prefer_rule_only: bool | None = None
    byok_enabled: bool | None = None
    byok_base_url: str | None = Field(default=None, max_length=500)
    byok_api_key: str | None = Field(default=None, max_length=300)
    byok_model: str | None = Field(default=None, min_length=1, max_length=64)

    @field_validator("byok_base_url", mode="before")
    @classmethod
    def _clean_byok_base_url(cls, value: object) -> object:
        if value is None or not isinstance(value, str):
            return value
        if any(ch == "\x00" or ord(ch) < 32 or ord(ch) == 127 for ch in value):
            raise ValueError("BYOK Base URL 不能包含空字符或控制字符")
        return value.strip()

    @field_validator("byok_base_url")
    @classmethod
    def _validate_byok_base_url(cls, value: str | None) -> str | None:
        if value is None or value == "":
            return value
        return validate_public_http_url(value, label="BYOK Base URL")

    @field_validator("byok_api_key", mode="before")
    @classmethod
    def _clean_byok_api_key(cls, value: object) -> object:
        if value is None or not isinstance(value, str):
            return value
        if any(ch == "\x00" or ord(ch) < 32 or ord(ch) == 127 for ch in value):
            raise ValueError("BYOK API Key 不能包含空字符或控制字符")
        return value.strip()

    @field_validator("byok_model", mode="before")
    @classmethod
    def _clean_byok_model(cls, value: object) -> object:
        if value is None or not isinstance(value, str):
            return value
        if any(ch == "\x00" or ord(ch) < 32 or ord(ch) == 127 for ch in value):
            raise ValueError("BYOK 模型名称不能包含空字符或控制字符")
        return value.strip()

    @model_validator(mode="after")
    def _reject_clearing_byok_fields_when_enabled(self) -> Self:
        if self.byok_enabled and self.byok_base_url == "":
            raise ValueError("启用 BYOK 时不能同时清空 Base URL")
        if self.byok_enabled and self.byok_api_key == "":
            raise ValueError("启用 BYOK 时不能同时清空 API Key")
        return self
