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
_ASCII_STOCK_CODE_PATTERN = r"^[0-9]{6}$"
_INT64_MIN = -9_223_372_036_854_775_808
_INT64_MAX = 9_223_372_036_854_775_807


def _reject_nul(value: str, label: str = "文本") -> str:
    if "\x00" in value:
        raise ValueError(f"{label}不能包含空字符")
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


class MarketOverview(BaseModel):
    schema_version: int = 1
    as_of: date
    data_source: str = "akshare"
    generated_at: datetime
    indices: list[IndexQuote]
    temperature: MarketTemperature
    hot_industries: list[IndustryFlow]


class StockMetaRecord(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
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
        return _reject_nul(cleaned, "昵称")


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


class CtRuleEvidence(BaseModel):
    year: int
    label: str
    metrics: dict[str, FiniteFloat | str | None]


class CtCheckItem(BaseModel):
    rule_id: str
    title: str
    status: SignalLight
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
    bear_cases: list[str]


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


class StockSyncSummary(BaseModel):
    code: str = Field(pattern=_ASCII_STOCK_CODE_PATTERN)
    as_of: date
    data_source: str
    daily_bars_count: int = Field(ge=0)
    annual_reports_count: int = Field(ge=0)
    ct_red_count: int = Field(ge=0)
    ct_yellow_count: int = Field(ge=0)
    implied_fcf_cagr_pct: FiniteFloat | None = None
