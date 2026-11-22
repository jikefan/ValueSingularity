"""Domain models — the API contract.

Every field here is part of the public contract; the web client mirrors these in
``apps/web/src/types/api.ts``. Keep them free of framework and storage details.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, field_validator


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
    price: float
    change_pct: float = Field(description="涨跌幅，百分数（-1.2 表示 -1.2%）")


class MarketTemperature(BaseModel):
    score: float = Field(ge=0, le=100, description="0=冰点，100=过热")
    level: TemperatureLevel
    pe_median: float = Field(description="全市场 PE 中位数")
    pe_percentile: float = Field(ge=0, le=100, description="历史分位，百分数")
    bond_yield: float = Field(description="十年国债收益率，百分数")
    equity_bond_spread: float = Field(description="股债性价比（EP - 国债收益率），百分数")
    comment: str


class IndustryFlow(BaseModel):
    name: str
    change_pct: float
    net_inflow: float = Field(description="净流入，单位：元")
    companies: int = Field(ge=0)


class MarketOverview(BaseModel):
    generated_at: datetime
    indices: list[IndexQuote]
    temperature: MarketTemperature
    hot_industries: list[IndustryFlow]


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
