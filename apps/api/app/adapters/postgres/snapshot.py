"""PostgreSQL repository for precomputed per-stock snapshots."""

from __future__ import annotations

import asyncio
import logging
import math
import time
import weakref
from collections.abc import Sequence
from datetime import UTC, date, datetime
from typing import Any, Literal, cast

from pydantic import ValidationError
from sqlalchemy import Select, case, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import StockSnapshot
from app.db.session import AsyncSessionLocal, DatabaseUnavailableError
from app.db.session import engine as db_engine
from app.domain.models import (
    AnnualFinancialTrendPoint,
    CapitalAllocationSummary,
    EarningsQualityTag,
    FinancialCtSection,
    GrowthSection,
    MoatSection,
    PeerBenchmarkMetrics,
    RadarScoreSection,
    ReverseDcfSection,
    ShareholderReturnSection,
    SignalLight,
    StockExchange,
    StockForensicsSection,
    StockSnapshotPayload,
    ValuationSection,
)
from app.settings import settings

logger = logging.getLogger("vs.adapters.postgres.snapshot")

_SUMMARY_CACHE: dict[int, tuple[float, list[StockSnapshotPayload]]] = {}
_SUMMARY_LOCKS: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[int, asyncio.Lock]] = (
    weakref.WeakKeyDictionary()
)
_SUMMARY_REFRESH_TASKS: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, dict[int, asyncio.Task[None]]
] = weakref.WeakKeyDictionary()
_SUMMARY_EPOCHS: dict[int, int] = {}

_VALID_EXCHANGES = frozenset({"SH", "SZ", "BJ"})
_VALID_SIGNAL_LIGHTS = frozenset({"green", "yellow", "red", "na"})
_VALID_SCORING_PROFILES = frozenset({"standard", "financial"})
_VALID_EQ_TAGS = frozenset(
    {
        "core_cash_cow",
        "investment_driven",
        "subsidy_inflated",
        "cashflow_divergent",
        "leveraged_roe",
        "balanced_steady",
        "financial_special",
    }
)


class _CorruptPayload(ValueError):
    """Raised when a persisted snapshot row fails core structural invariants."""


class _FallbackToPydantic(ValueError):
    """Raised when a payload needs full Pydantic validation (e.g. non-slim arrays)."""


def _build_slim_payload_expr() -> Any:
    p = StockSnapshot.payload
    empty_array = func.jsonb_build_array()
    empty_object = func.jsonb_build_object()

    def _slim_array_section(section: str, key: str) -> Any:
        sec = p[section]
        return case(
            (
                func.jsonb_typeof(sec) == "object",
                sec.op("-")(key).op("||")(func.jsonb_build_object(key, empty_array)),
            ),
            else_=sec,
        )

    forensics = p["forensics"]
    slim_forensics = case(
        (
            func.jsonb_typeof(forensics) == "object",
            forensics.op("-")("annual_decomposition").op("-")("dupont_series").op("-")("findings"),
        ),
        else_=forensics,
    )

    # Guard with jsonb_typeof(p) == "object" so corrupt scalars skip on ValidationError
    # rather than failing SQL `-`.
    return case(
        (
            func.jsonb_typeof(p) == "object",
            p.op("-")("annual_trends")
            .op("-")("formula_notes")
            .op("||")(
                func.jsonb_build_object(
                    "annual_trends",
                    empty_array,
                    "formula_notes",
                    empty_object,
                    "valuation",
                    _slim_array_section("valuation", "history"),
                    "financial_ct",
                    _slim_array_section("financial_ct", "checks"),
                    "shareholder_return",
                    _slim_array_section("shareholder_return", "series"),
                    "reverse_dcf",
                    _slim_array_section("reverse_dcf", "sensitivity"),
                    "moat",
                    _slim_array_section("moat", "dimensions"),
                    "forensics",
                    slim_forensics,
                )
            ),
        ),
        else_=p,
    )


_SLIM_PAYLOAD_EXPR = _build_slim_payload_expr()
_ANNUAL_LEN_EXPR = case(
    (
        func.jsonb_typeof(StockSnapshot.payload["annual_trends"]) == "array",
        func.jsonb_array_length(StockSnapshot.payload["annual_trends"]),
    ),
    else_=0,
)


def _is_postgresql_bind(bind: Any) -> bool:
    return getattr(getattr(bind, "dialect", None), "name", None) == "postgresql"


def _is_app_engine_bind(bind: Any) -> bool:
    if bind is None:
        return False
    return getattr(bind, "sync_engine", bind) is getattr(db_engine, "sync_engine", db_engine)


def _get_summary_lock(bind_key: int) -> asyncio.Lock:
    # Locks are bound to the active event loop so multi-loop test runners never share a Lock.
    loop = asyncio.get_running_loop()
    loop_locks = _SUMMARY_LOCKS.setdefault(loop, {})
    lock = loop_locks.get(bind_key)
    if lock is None:
        lock = asyncio.Lock()
        loop_locks[bind_key] = lock
    return lock


def _req_dict(mapping: dict[str, Any], key: str) -> dict[str, Any]:
    if key not in mapping:
        raise _CorruptPayload(key)
    val = mapping[key]
    if not isinstance(val, dict):
        raise _CorruptPayload(key)
    return val


def _req_str(mapping: dict[str, Any], key: str, *, nonempty: bool = False) -> str:
    if key not in mapping:
        raise _CorruptPayload(key)
    val = mapping[key]
    if not isinstance(val, str):
        raise _FallbackToPydantic(key)
    if nonempty and not val:
        raise _FallbackToPydantic(key)
    return val


def _opt_str(mapping: dict[str, Any], key: str, default: str | None = None) -> str | None:
    if key not in mapping or mapping[key] is None:
        return default
    val = mapping[key]
    if not isinstance(val, str):
        raise _FallbackToPydantic(key)
    return val


def _req_code(mapping: dict[str, Any], key: str = "code") -> str:
    val = _req_str(mapping, key)
    if len(val) == 6 and val.isascii() and val.isdigit():
        return val
    raise _CorruptPayload(key)


def _req_exchange(mapping: dict[str, Any], key: str = "exchange") -> StockExchange:
    val = _req_str(mapping, key)
    if val in _VALID_EXCHANGES:
        return cast(StockExchange, val)
    raise _CorruptPayload(key)


def _req_signal(mapping: dict[str, Any], key: str) -> SignalLight:
    val = _req_str(mapping, key)
    if val in _VALID_SIGNAL_LIGHTS:
        return cast(SignalLight, val)
    raise _CorruptPayload(key)


def _req_bool(mapping: dict[str, Any], key: str) -> bool:
    if key not in mapping:
        raise _CorruptPayload(key)
    val = mapping[key]
    if isinstance(val, bool):
        return val
    raise _FallbackToPydantic(key)


def _opt_bool(mapping: dict[str, Any], key: str, *, default: bool = False) -> bool:
    if key not in mapping:
        return default
    val = mapping[key]
    if isinstance(val, bool):
        return val
    raise _FallbackToPydantic(key)


def _req_int(
    mapping: dict[str, Any], key: str, *, min_val: int = 0, max_val: int | None = None
) -> int:
    if key not in mapping:
        raise _CorruptPayload(key)
    val = mapping[key]
    if type(val) is int:
        if val < min_val or (max_val is not None and val > max_val):
            raise _CorruptPayload(key)
        return val
    raise _FallbackToPydantic(key)


def _opt_finite_float(mapping: dict[str, Any], key: str) -> float | None:
    if key not in mapping or mapping[key] is None:
        return None
    val = mapping[key]
    if isinstance(val, int | float) and not isinstance(val, bool):
        fval = float(val)
        if not math.isfinite(fval):
            raise _CorruptPayload(key)
        return fval
    raise _FallbackToPydantic(key)


def _req_finite_float(mapping: dict[str, Any], key: str, *, default: float | None = None) -> float:
    if key not in mapping:
        if default is not None:
            return default
        raise _CorruptPayload(key)
    val = mapping[key]
    if val is None:
        raise _CorruptPayload(key)
    if isinstance(val, int | float) and not isinstance(val, bool):
        fval = float(val)
        if not math.isfinite(fval):
            raise _CorruptPayload(key)
        return fval
    raise _FallbackToPydantic(key)


def _parse_date(val: Any, key: str) -> date:
    if type(val) is date:
        return val
    if isinstance(val, str):
        try:
            return date.fromisoformat(val)
        except ValueError:
            raise _FallbackToPydantic(key) from None
    raise _FallbackToPydantic(key)


def _req_date(mapping: dict[str, Any], key: str) -> date:
    if key not in mapping or mapping[key] is None:
        raise _CorruptPayload(key)
    return _parse_date(mapping[key], key)


def _opt_date(mapping: dict[str, Any], key: str) -> date | None:
    if key not in mapping or mapping[key] is None:
        return None
    return _parse_date(mapping[key], key)


def _req_datetime(mapping: dict[str, Any], key: str) -> datetime:
    if key not in mapping or mapping[key] is None:
        raise _CorruptPayload(key)
    val = mapping[key]
    if isinstance(val, datetime):
        return val
    if isinstance(val, str):
        try:
            return datetime.fromisoformat(val)
        except ValueError:
            raise _FallbackToPydantic(key) from None
    raise _FallbackToPydantic(key)


def _req_empty_list(mapping: dict[str, Any], key: str) -> list[Any]:
    if key not in mapping:
        raise _CorruptPayload(key)
    val = mapping[key]
    if not isinstance(val, list):
        raise _CorruptPayload(key)
    if val:
        raise _FallbackToPydantic(key)
    return []


def _opt_empty_list(mapping: dict[str, Any], key: str) -> list[Any]:
    if key not in mapping:
        return []
    val = mapping[key]
    if not isinstance(val, list):
        raise _CorruptPayload(key)
    if val:
        raise _FallbackToPydantic(key)
    return []


def _req_str_dict(mapping: dict[str, Any], key: str, *, required: bool) -> dict[str, str]:
    if key not in mapping:
        if required:
            raise _CorruptPayload(key)
        return {}
    val = mapping[key]
    if not isinstance(val, dict):
        raise _CorruptPayload(key)
    if val and not all(isinstance(k, str) and isinstance(v, str) for k, v in val.items()):
        raise _FallbackToPydantic(key)
    return cast(dict[str, str], val)


def _parse_slim_snapshot_fast(raw: Any, n_years: int = 0) -> StockSnapshotPayload:
    """Validate core invariants and construct a slim StockSnapshotPayload fast."""
    if not isinstance(raw, dict):
        raise _CorruptPayload("root")

    if "schema_version" in raw:
        sv = raw["schema_version"]
        if type(sv) is not int:
            raise _FallbackToPydantic("schema_version")
        schema_version = sv
    else:
        schema_version = 1

    code = _req_code(raw, "code")
    name = _req_str(raw, "name", nonempty=True)
    exchange = _req_exchange(raw, "exchange")
    industry_sw1 = _opt_str(raw, "industry_sw1")
    industry_sw2 = _opt_str(raw, "industry_sw2")
    as_of = _req_date(raw, "as_of")
    generated_at = _req_datetime(raw, "generated_at")
    data_source = _req_str(raw, "data_source") if "data_source" in raw else "akshare"

    _req_empty_list(raw, "annual_trends")
    formula_notes = _req_str_dict(raw, "formula_notes", required=True)
    pledge_ratio_pct = _opt_finite_float(raw, "pledge_ratio_pct")
    pledge_date = _opt_date(raw, "pledge_date")
    latest_audit_opinion = _opt_str(raw, "latest_audit_opinion")

    val_raw = _req_dict(raw, "valuation")
    _req_empty_list(val_raw, "history")
    valuation = ValuationSection.model_construct(
        latest_trade_date=_opt_date(val_raw, "latest_trade_date"),
        close=_opt_finite_float(val_raw, "close"),
        total_mv_yuan=_opt_finite_float(val_raw, "total_mv_yuan"),
        pe_ttm=_opt_finite_float(val_raw, "pe_ttm"),
        pe_percentile_5y=_opt_finite_float(val_raw, "pe_percentile_5y"),
        pe_percentile_10y=_opt_finite_float(val_raw, "pe_percentile_10y"),
        pb=_opt_finite_float(val_raw, "pb"),
        pb_percentile_10y=_opt_finite_float(val_raw, "pb_percentile_10y"),
        dividend_yield_pct=_opt_finite_float(val_raw, "dividend_yield_pct"),
        graham_number=_opt_finite_float(val_raw, "graham_number"),
        graham_margin_pct=_opt_finite_float(val_raw, "graham_margin_pct"),
        peg=_opt_finite_float(val_raw, "peg"),
        history=[],
    )

    dcf_raw = _req_dict(raw, "reverse_dcf")
    _req_empty_list(dcf_raw, "sensitivity")
    reverse_dcf = ReverseDcfSection.model_construct(
        solvable=_req_bool(dcf_raw, "solvable"),
        note=_req_str(dcf_raw, "note"),
        market_cap_yuan=_opt_finite_float(dcf_raw, "market_cap_yuan"),
        enterprise_value_yuan=_opt_finite_float(dcf_raw, "enterprise_value_yuan"),
        net_cash_yuan=_opt_finite_float(dcf_raw, "net_cash_yuan"),
        base_fcf_yuan=_opt_finite_float(dcf_raw, "base_fcf_yuan"),
        base_fcf_years=_req_int(dcf_raw, "base_fcf_years", min_val=0),
        discount_rate_pct=_req_finite_float(dcf_raw, "discount_rate_pct"),
        terminal_multiple=_req_finite_float(dcf_raw, "terminal_multiple"),
        implied_fcf_cagr_pct=_opt_finite_float(dcf_raw, "implied_fcf_cagr_pct"),
        historical_revenue_cagr_pct=_opt_finite_float(dcf_raw, "historical_revenue_cagr_pct"),
        implied_vs_history_gap_pct=_opt_finite_float(dcf_raw, "implied_vs_history_gap_pct"),
        sensitivity=[],
    )

    ct_raw = _req_dict(raw, "financial_ct")
    _req_empty_list(ct_raw, "checks")
    financial_ct = FinancialCtSection.model_construct(
        overall_status=_req_signal(ct_raw, "overall_status"),
        red_count=_req_int(ct_raw, "red_count", min_val=0),
        yellow_count=_req_int(ct_raw, "yellow_count", min_val=0),
        green_count=_req_int(ct_raw, "green_count", min_val=0),
        checks=[],
    )

    sr_raw = _req_dict(raw, "shareholder_return")
    _req_empty_list(sr_raw, "series")
    shareholder_return = ShareholderReturnSection.model_construct(
        window_years=_req_int(sr_raw, "window_years", min_val=0),
        total_dividend_yuan=_req_finite_float(sr_raw, "total_dividend_yuan"),
        total_repurchase_yuan=_req_finite_float(sr_raw, "total_repurchase_yuan"),
        total_equity_financing_yuan=_req_finite_float(sr_raw, "total_equity_financing_yuan"),
        net_return_yuan=_req_finite_float(sr_raw, "net_return_yuan"),
        total_fcf_yuan=_opt_finite_float(sr_raw, "total_fcf_yuan"),
        fcf_coverage_ratio=_opt_finite_float(sr_raw, "fcf_coverage_ratio"),
        current_dividend_yield_pct=_opt_finite_float(sr_raw, "current_dividend_yield_pct"),
        status=_req_signal(sr_raw, "status"),
        verdict=_req_str(sr_raw, "verdict"),
        series=[],
    )

    moat_raw = _req_dict(raw, "moat")
    _req_empty_list(moat_raw, "dimensions")
    moat = MoatSection.model_construct(
        roe_5y_avg_pct=_opt_finite_float(moat_raw, "roe_5y_avg_pct"),
        roe_10y_min_pct=_opt_finite_float(moat_raw, "roe_10y_min_pct"),
        gross_margin_latest_pct=_opt_finite_float(moat_raw, "gross_margin_latest_pct"),
        gross_margin_5y_std_pct=_opt_finite_float(moat_raw, "gross_margin_5y_std_pct"),
        roic_approx_pct=_opt_finite_float(moat_raw, "roic_approx_pct"),
        dimensions=[],
    )

    growth_raw = _req_dict(raw, "growth")
    growth = GrowthSection.model_construct(
        revenue_cagr_3y_pct=_opt_finite_float(growth_raw, "revenue_cagr_3y_pct"),
        revenue_cagr_5y_pct=_opt_finite_float(growth_raw, "revenue_cagr_5y_pct"),
        profit_cagr_5y_pct=_opt_finite_float(growth_raw, "profit_cagr_5y_pct"),
        deduct_profit_cagr_5y_pct=_opt_finite_float(growth_raw, "deduct_profit_cagr_5y_pct"),
        rd_ratio_latest_pct=_opt_finite_float(growth_raw, "rd_ratio_latest_pct"),
        capex_to_ocf_latest_pct=_opt_finite_float(growth_raw, "capex_to_ocf_latest_pct"),
    )

    radar_raw = _req_dict(raw, "radar")
    scoring_profile_raw = _opt_str(radar_raw, "scoring_profile")
    if scoring_profile_raw is None:
        if "scoring_profile" in radar_raw and radar_raw["scoring_profile"] is None:
            raise _CorruptPayload("radar.scoring_profile")
        scoring_profile: Literal["standard", "financial"] = "standard"
    elif scoring_profile_raw in _VALID_SCORING_PROFILES:
        scoring_profile = cast(Literal["standard", "financial"], scoring_profile_raw)
    else:
        raise _CorruptPayload("radar.scoring_profile")

    bear_cases_raw = radar_raw.get("bear_cases")
    if not isinstance(bear_cases_raw, list) or not all(isinstance(x, str) for x in bear_cases_raw):
        raise _CorruptPayload("radar.bear_cases")

    radar = RadarScoreSection.model_construct(
        profitability=_req_int(radar_raw, "profitability", min_val=0, max_val=100),
        moat=_req_int(radar_raw, "moat", min_val=0, max_val=100),
        balance_sheet=_req_int(radar_raw, "balance_sheet", min_val=0, max_val=100),
        cashflow_quality=_req_int(radar_raw, "cashflow_quality", min_val=0, max_val=100),
        valuation_margin=_req_int(radar_raw, "valuation_margin", min_val=0, max_val=100),
        total_score=_req_int(radar_raw, "total_score", min_val=0, max_val=100),
        scoring_profile=scoring_profile,
        dimension_labels=_req_str_dict(radar_raw, "dimension_labels", required=False),
        bear_cases=list(bear_cases_raw),
    )

    forensics: StockForensicsSection | None = None
    if "forensics" in raw and raw["forensics"] is not None:
        f_raw = raw["forensics"]
        if not isinstance(f_raw, dict):
            raise _CorruptPayload("forensics")
        eq_tag_raw = _req_str(f_raw, "earnings_quality_tag")
        if eq_tag_raw not in _VALID_EQ_TAGS:
            raise _CorruptPayload("forensics.earnings_quality_tag")
        _opt_empty_list(f_raw, "findings")
        _opt_empty_list(f_raw, "annual_decomposition")
        _opt_empty_list(f_raw, "dupont_series")

        cap_alloc: CapitalAllocationSummary | None = None
        if "capital_allocation" in f_raw and f_raw["capital_allocation"] is not None:
            ca_raw = f_raw["capital_allocation"]
            if not isinstance(ca_raw, dict):
                raise _CorruptPayload("forensics.capital_allocation")
            cap_alloc = CapitalAllocationSummary.model_construct(
                window_years=_req_int(ca_raw, "window_years", min_val=0),
                total_ocf_yuan=_opt_finite_float(ca_raw, "total_ocf_yuan"),
                total_capex_yuan=_opt_finite_float(ca_raw, "total_capex_yuan"),
                total_dividends_yuan=_req_finite_float(ca_raw, "total_dividends_yuan", default=0.0),
                total_repurchases_yuan=_req_finite_float(
                    ca_raw, "total_repurchases_yuan", default=0.0
                ),
                total_equity_financing_yuan=_req_finite_float(
                    ca_raw, "total_equity_financing_yuan", default=0.0
                ),
                net_debt_change_yuan=_opt_finite_float(ca_raw, "net_debt_change_yuan"),
                ending_net_cash_yuan=_opt_finite_float(ca_raw, "ending_net_cash_yuan"),
                ending_investment_assets_yuan=_opt_finite_float(
                    ca_raw, "ending_investment_assets_yuan"
                ),
                capex_to_ocf_pct=_opt_finite_float(ca_raw, "capex_to_ocf_pct"),
                payout_to_ocf_pct=_opt_finite_float(ca_raw, "payout_to_ocf_pct"),
                allocation_style=_req_str(ca_raw, "allocation_style"),
                summary=_req_str(ca_raw, "summary"),
            )

        forensics = StockForensicsSection.model_construct(
            earnings_quality_tag=cast(EarningsQualityTag, eq_tag_raw),
            earnings_quality_label=_req_str(f_raw, "earnings_quality_label"),
            verdict=_req_str(f_raw, "verdict"),
            core_profit_share_3y_pct=_opt_finite_float(f_raw, "core_profit_share_3y_pct"),
            invest_profit_share_3y_pct=_opt_finite_float(f_raw, "invest_profit_share_3y_pct"),
            non_recurring_share_3y_pct=_opt_finite_float(f_raw, "non_recurring_share_3y_pct"),
            ocf_to_core_profit_3y_pct=_opt_finite_float(f_raw, "ocf_to_core_profit_3y_pct"),
            interest_burden_pct=_opt_finite_float(f_raw, "interest_burden_pct"),
            investment_assets_yuan=_opt_finite_float(f_raw, "investment_assets_yuan"),
            investment_assets_ratio_pct=_opt_finite_float(f_raw, "investment_assets_ratio_pct"),
            dupont_roe_5y_avg_pct=_opt_finite_float(f_raw, "dupont_roe_5y_avg_pct"),
            dupont_net_margin_5y_avg_pct=_opt_finite_float(f_raw, "dupont_net_margin_5y_avg_pct"),
            dupont_asset_turnover_5y_avg=_opt_finite_float(f_raw, "dupont_asset_turnover_5y_avg"),
            dupont_equity_multiplier_5y_avg=_opt_finite_float(
                f_raw, "dupont_equity_multiplier_5y_avg"
            ),
            findings=[],
            annual_decomposition=[],
            dupont_series=[],
            capital_allocation=cap_alloc,
        )

    pm_raw = _req_dict(raw, "peer_metrics")
    pm_eq_raw = _opt_str(pm_raw, "earnings_quality_tag")
    if pm_eq_raw is not None and pm_eq_raw not in _VALID_EQ_TAGS:
        raise _CorruptPayload("peer_metrics.earnings_quality_tag")
    peer_metrics = PeerBenchmarkMetrics.model_construct(
        code=_req_code(pm_raw, "code"),
        name=_req_str(pm_raw, "name", nonempty=True),
        exchange=_req_exchange(pm_raw, "exchange"),
        industry_sw1=_opt_str(pm_raw, "industry_sw1"),
        as_of=_opt_date(pm_raw, "as_of"),
        close=_opt_finite_float(pm_raw, "close"),
        total_mv_yuan=_opt_finite_float(pm_raw, "total_mv_yuan"),
        pe_ttm=_opt_finite_float(pm_raw, "pe_ttm"),
        pe_percentile_10y=_opt_finite_float(pm_raw, "pe_percentile_10y"),
        pb=_opt_finite_float(pm_raw, "pb"),
        roe_5y_avg_pct=_opt_finite_float(pm_raw, "roe_5y_avg_pct"),
        gross_margin_latest_pct=_opt_finite_float(pm_raw, "gross_margin_latest_pct"),
        net_cash_to_mv_pct=_opt_finite_float(pm_raw, "net_cash_to_mv_pct"),
        ocf_to_profit_5y_pct=_opt_finite_float(pm_raw, "ocf_to_profit_5y_pct"),
        shareholder_yield_pct=_opt_finite_float(pm_raw, "shareholder_yield_pct"),
        implied_fcf_cagr_pct=_opt_finite_float(pm_raw, "implied_fcf_cagr_pct"),
        ct_red_count=_req_int(pm_raw, "ct_red_count", min_val=0),
        ct_yellow_count=_req_int(pm_raw, "ct_yellow_count", min_val=0),
        total_score=_req_int(pm_raw, "total_score", min_val=0, max_val=100),
        is_financial=_opt_bool(pm_raw, "is_financial", default=False),
        earnings_quality_tag=(
            cast(EarningsQualityTag, pm_eq_raw) if pm_eq_raw is not None else None
        ),
        earnings_quality_label=_opt_str(pm_raw, "earnings_quality_label"),
        invest_profit_share_3y_pct=_opt_finite_float(pm_raw, "invest_profit_share_3y_pct"),
        investment_assets_ratio_pct=_opt_finite_float(pm_raw, "investment_assets_ratio_pct"),
    )

    annual_trends = (
        [AnnualFinancialTrendPoint.model_construct(year=2025 - i) for i in range(n_years)]
        if n_years > 0
        else []
    )
    return StockSnapshotPayload.model_construct(
        schema_version=schema_version,
        code=code,
        name=name,
        exchange=exchange,
        industry_sw1=industry_sw1,
        industry_sw2=industry_sw2,
        as_of=as_of,
        generated_at=generated_at,
        data_source=data_source,
        annual_trends=annual_trends,
        valuation=valuation,
        reverse_dcf=reverse_dcf,
        financial_ct=financial_ct,
        shareholder_return=shareholder_return,
        moat=moat,
        growth=growth,
        radar=radar,
        forensics=forensics,
        peer_metrics=peer_metrics,
        pledge_ratio_pct=pledge_ratio_pct,
        pledge_date=pledge_date,
        latest_audit_opinion=latest_audit_opinion,
        formula_notes=formula_notes,
    )


async def _refresh_summary_cache_background(bind_key: int) -> None:
    lock = _get_summary_lock(bind_key)
    try:
        async with lock:
            ttl = settings.snapshot_summary_cache_ttl_seconds
            if ttl <= 0:
                return
            cached = _SUMMARY_CACHE.get(bind_key)
            if cached is not None and cached[0] > time.monotonic():
                return
            epoch = _SUMMARY_EPOCHS.get(bind_key, 0)
            async with AsyncSessionLocal() as session:
                repo = PostgresStockSnapshotRepository(session)
                refresh_bind = getattr(session, "bind", None)
                items = await repo._load_all_snapshots(refresh_bind)
            if _SUMMARY_EPOCHS.get(bind_key, 0) == epoch:
                _SUMMARY_CACHE[bind_key] = (time.monotonic() + ttl, list(items))
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("后台刷新全市场快照摘要缓存失败: %s", exc)


def _schedule_summary_refresh(bind_key: int) -> None:
    loop = asyncio.get_running_loop()
    loop_tasks = _SUMMARY_REFRESH_TASKS.setdefault(loop, {})
    existing = loop_tasks.get(bind_key)
    if existing is not None and not existing.done():
        return

    task = loop.create_task(
        _refresh_summary_cache_background(bind_key),
        name=f"snapshot-summary-refresh-{bind_key}",
    )
    loop_tasks[bind_key] = task

    def _cleanup(done_task: asyncio.Task[None]) -> None:
        if loop_tasks.get(bind_key) is done_task:
            loop_tasks.pop(bind_key, None)

    task.add_done_callback(_cleanup)


async def warmup_snapshot_summary_cache() -> None:
    """Best-effort startup warmup for the slim snapshot summary cache."""
    if settings.snapshot_summary_cache_ttl_seconds <= 0:
        return
    try:
        async with AsyncSessionLocal() as session:
            repo = PostgresStockSnapshotRepository(session)
            await repo.list_all_snapshots()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("启动预热全市场快照摘要缓存失败: %s", exc)


async def cancel_summary_refresh_tasks() -> None:
    """Cancel any in-flight SWR background refresh tasks on the active event loop."""
    loop = asyncio.get_running_loop()
    loop_tasks = _SUMMARY_REFRESH_TASKS.get(loop)
    if not loop_tasks:
        return
    pending = [task for task in loop_tasks.values() if not task.done()]
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    loop_tasks.clear()


class PostgresStockSnapshotRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_snapshot(self, code: str) -> StockSnapshotPayload | None:
        try:
            row = await self._session.get(StockSnapshot, code)
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc

        if row is None:
            return None
        return StockSnapshotPayload.model_validate(row.payload)

    async def get_snapshots_for_compare(
        self, codes: Sequence[str]
    ) -> dict[str, StockSnapshotPayload]:
        unique_codes = list(dict.fromkeys(codes))
        if not unique_codes:
            return {}
        stmt = select(StockSnapshot).where(StockSnapshot.code.in_(unique_codes))
        try:
            rows = (await self._session.scalars(stmt)).all()
        except SQLAlchemyError as exc:
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc
        return {row.code: StockSnapshotPayload.model_validate(row.payload) for row in rows}

    async def _load_all_snapshots(self, bind: Any) -> list[StockSnapshotPayload]:
        if _is_postgresql_bind(bind):
            stmt: Select[Any] = select(_SLIM_PAYLOAD_EXPR, _ANNUAL_LEN_EXPR).order_by(
                StockSnapshot.code.asc()
            )
            try:
                rows = (await self._session.execute(stmt)).all()
            except SQLAlchemyError as exc:
                raise DatabaseUnavailableError(exc.__class__.__name__) from exc
            raw_items: list[tuple[Any, int]] = [(row[0], int(row[1] or 0)) for row in rows]
        else:
            stmt = select(StockSnapshot).order_by(StockSnapshot.code.asc())
            try:
                rows = (await self._session.scalars(stmt)).all()
            except SQLAlchemyError as exc:
                raise DatabaseUnavailableError(exc.__class__.__name__) from exc
            raw_items = []
            for row in rows:
                raw = row.payload if hasattr(row, "payload") else row
                n_years = 0
                if isinstance(raw, dict):
                    trends = raw.get("annual_trends")
                    if isinstance(trends, list):
                        n_years = len(trends)
                raw_items.append((raw, n_years))

        if not raw_items:
            return []

        def _validate_all(items_with_counts: list[tuple[Any, int]]) -> list[StockSnapshotPayload]:
            items: list[StockSnapshotPayload] = []
            for raw, n_years in items_with_counts:
                try:
                    items.append(_parse_slim_snapshot_fast(raw, n_years))
                except _CorruptPayload:
                    continue
                except ValueError:
                    try:
                        snap = StockSnapshotPayload.model_validate(raw)
                    except ValidationError:
                        continue
                    if n_years > 0 and not snap.annual_trends:
                        snap = snap.model_copy(
                            update={
                                "annual_trends": [
                                    AnnualFinancialTrendPoint.model_construct(year=2025 - i)
                                    for i in range(n_years)
                                ]
                            }
                        )
                    items.append(snap)
            return items

        return await asyncio.to_thread(_validate_all, raw_items)

    async def list_all_snapshots(self) -> list[StockSnapshotPayload]:
        bind = getattr(self._session, "bind", None)
        ttl = settings.snapshot_summary_cache_ttl_seconds
        if bind is None or ttl <= 0:
            return await self._load_all_snapshots(bind)

        bind_key = id(bind)
        cached = _SUMMARY_CACHE.get(bind_key)
        if cached is not None:
            if cached[0] > time.monotonic():
                return list(cached[1])
            if _is_app_engine_bind(bind):
                _schedule_summary_refresh(bind_key)
                return list(cached[1])

        lock = _get_summary_lock(bind_key)
        async with lock:
            cached = _SUMMARY_CACHE.get(bind_key)
            if cached is not None:
                if cached[0] > time.monotonic():
                    return list(cached[1])
                if _is_app_engine_bind(bind):
                    _schedule_summary_refresh(bind_key)
                    return list(cached[1])

            epoch = _SUMMARY_EPOCHS.get(bind_key, 0)
            items = await self._load_all_snapshots(bind)
            if _SUMMARY_EPOCHS.get(bind_key, 0) == epoch:
                _SUMMARY_CACHE[bind_key] = (time.monotonic() + ttl, list(items))
            return list(items)

    async def save_snapshot(self, snapshot: StockSnapshotPayload) -> None:
        now = datetime.now(UTC)
        payload = snapshot.model_dump(mode="json")
        stmt = (
            pg_insert(StockSnapshot)
            .values(
                code=snapshot.code,
                as_of=snapshot.as_of,
                payload=payload,
                updated_at=now,
            )
            .on_conflict_do_update(
                index_elements=["code"],
                set_={
                    "as_of": snapshot.as_of,
                    "payload": payload,
                    "updated_at": now,
                },
                where=(StockSnapshot.as_of <= snapshot.as_of),
            )
        )
        try:
            await self._session.execute(stmt)
            await self._session.commit()
        except SQLAlchemyError as exc:
            await self._session.rollback()
            raise DatabaseUnavailableError(exc.__class__.__name__) from exc
        except Exception:
            await self._session.rollback()
            raise

        bind = getattr(self._session, "bind", None)
        if bind is not None:
            bind_key = id(bind)
            _SUMMARY_CACHE.pop(bind_key, None)
            _SUMMARY_EPOCHS[bind_key] = _SUMMARY_EPOCHS.get(bind_key, 0) + 1
