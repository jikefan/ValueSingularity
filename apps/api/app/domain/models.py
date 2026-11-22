"""Domain models — the API contract.

Every field here is part of the public contract; the web client mirrors these in
``apps/web/src/types/api.ts``. Keep them free of framework and storage details.
"""

from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, field_validator

FiniteFloat = Annotated[float, Field(allow_inf_nan=False)]
StockExchange = Literal["SH", "SZ", "BJ"]


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


class MarketOverview(BaseModel):
    schema_version: int = 1
    as_of: date
    data_source: str = "akshare"
    generated_at: datetime
    indices: list[IndexQuote]
    temperature: MarketTemperature
    hot_industries: list[IndustryFlow]


class StockMetaRecord(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
    name: str = Field(min_length=1, max_length=64)
    exchange: StockExchange
    industry_sw1: str | None = None
    industry_sw2: str | None = None
    list_date: date | None = None
    is_st: bool = False
    is_active: bool = True


class StockDetail(StockMetaRecord):
    snapshot_available: bool = False


class TradeCalendarEntry(BaseModel):
    trade_date: date
    is_open: bool = True


class IndexDailyRow(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
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
    plan_tier: PlanTier
    plan_expires_at: datetime | None = None
    created_at: datetime


class UserAuthRecord(UserProfile):
    password_hash: str
    is_active: bool


class AuthenticatedUser(BaseModel):
    id: UUID
    plan_tier: PlanTier


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=64)

    @field_validator("display_name")
    @classmethod
    def _strip_display_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("昵称不能为空")
        return cleaned


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
    token_hash: str
    expires_at: datetime
    revoked_at: datetime | None


class RefreshRotationStatus(StrEnum):
    ROTATED = "rotated"
    NOT_FOUND = "not_found"
    EXPIRED = "expired"
    REPLAYED = "replayed"
    INACTIVE = "inactive"


class RefreshRotationResult(BaseModel):
    status: RefreshRotationStatus
    user: UserAuthRecord | None = None


class WatchlistItem(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
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
    code: str = Field(pattern=r"^\d{6}$")
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


class JournalCreate(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
    name: str | None = Field(default=None, max_length=64)
    action: JournalAction
    reason: str = Field(min_length=1, max_length=5000)
    falsify_condition: str = Field(min_length=1, max_length=5000)
    falsify_rules: list[FalsifyRule] | None = None
    max_drawdown: FiniteFloat | None = Field(default=None, ge=0, le=100)
    emotion: str | None = Field(default=None, max_length=32)
    price: FiniteFloat | None = Field(default=None, ge=0.001, le=999_999_999.999)
    benchmark_code: str = Field(default="000300", pattern=r"^\d{6}$")
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
    created_at: datetime


EventMetaValue = str | int | FiniteFloat | bool | None


class UserEventCreate(BaseModel):
    type: str = Field(min_length=1, max_length=32)
    code: str | None = Field(default=None, pattern=r"^\d{6}$")
    meta: dict[str, EventMetaValue] | None = None

    @field_validator("type", mode="before")
    @classmethod
    def _strip_type(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class UserEventItem(BaseModel):
    id: int
    type: str
    code: str | None = None
    meta: dict[str, EventMetaValue] | None = None
    ts: datetime
