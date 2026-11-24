"""Synced-pool stock screener domain engine (pure filtering, conversion, and null-last sorting)."""

from __future__ import annotations

import math
from collections.abc import Sequence

from app.domain.engines._helpers import is_financial_institution
from app.domain.models import (
    ScreenerQualityFilter,
    ScreenerSortDir,
    ScreenerSortField,
    StockMetaRecord,
    StockScreenerItem,
    StockScreenerResponse,
    StockSnapshotPayload,
)


def is_financial_institution_from_snapshot(snapshot: StockSnapshotPayload) -> bool:
    """Detect financial institutions from snapshot profile or fallback industry/name heuristics."""
    if snapshot.radar.scoring_profile == "financial":
        return True
    meta = StockMetaRecord(
        code=snapshot.code,
        name=snapshot.name,
        exchange=snapshot.exchange,
        industry_sw1=snapshot.industry_sw1,
        industry_sw2=snapshot.industry_sw2,
    )
    return is_financial_institution(meta)


def snapshot_to_screener_item(snapshot: StockSnapshotPayload) -> StockScreenerItem:
    """Project a full StockSnapshotPayload into a flat StockScreenerItem row."""
    val = snapshot.valuation
    pm = snapshot.peer_metrics
    sr = snapshot.shareholder_return
    f = snapshot.forensics
    return StockScreenerItem(
        code=snapshot.code,
        name=snapshot.name,
        exchange=snapshot.exchange,
        industry_sw1=snapshot.industry_sw1,
        as_of=snapshot.as_of,
        close=val.close if val.close is not None else pm.close,
        total_mv_yuan=val.total_mv_yuan if val.total_mv_yuan is not None else pm.total_mv_yuan,
        pe_ttm=val.pe_ttm if val.pe_ttm is not None else pm.pe_ttm,
        pe_percentile_10y=(
            val.pe_percentile_10y if val.pe_percentile_10y is not None else pm.pe_percentile_10y
        ),
        pb=val.pb if val.pb is not None else pm.pb,
        pb_percentile_10y=val.pb_percentile_10y,
        roe_5y_avg_pct=(
            snapshot.moat.roe_5y_avg_pct
            if snapshot.moat.roe_5y_avg_pct is not None
            else pm.roe_5y_avg_pct
        ),
        dividend_yield_pct=(
            val.dividend_yield_pct
            if val.dividend_yield_pct is not None
            else sr.current_dividend_yield_pct
        ),
        shareholder_yield_pct=pm.shareholder_yield_pct,
        implied_fcf_cagr_pct=(
            snapshot.reverse_dcf.implied_fcf_cagr_pct
            if snapshot.reverse_dcf.implied_fcf_cagr_pct is not None
            else pm.implied_fcf_cagr_pct
        ),
        ct_red_count=snapshot.financial_ct.red_count,
        ct_yellow_count=snapshot.financial_ct.yellow_count,
        ct_green_count=snapshot.financial_ct.green_count,
        total_score=snapshot.radar.total_score,
        valuation_margin=snapshot.radar.valuation_margin,
        is_financial=is_financial_institution_from_snapshot(snapshot),
        earnings_quality_tag=(f.earnings_quality_tag if f is not None else pm.earnings_quality_tag),
        earnings_quality_label=(
            f.earnings_quality_label if f is not None else pm.earnings_quality_label
        ),
        invest_profit_share_3y_pct=(
            f.invest_profit_share_3y_pct if f is not None else pm.invest_profit_share_3y_pct
        ),
        investment_assets_ratio_pct=(
            f.investment_assets_ratio_pct if f is not None else pm.investment_assets_ratio_pct
        ),
    )


def _matches_quality_filter(
    item: StockScreenerItem,
    snapshot: StockSnapshotPayload,
    quality_filter: ScreenerQualityFilter,
) -> bool:
    if quality_filter == "all":
        return True
    if quality_filter == "core_only":
        return item.earnings_quality_tag == "core_cash_cow" and item.ct_red_count == 0
    if quality_filter in {"hide_investment_heavy", "dividend_fortress"}:
        non_rec = (
            snapshot.forensics.non_recurring_share_3y_pct
            if snapshot.forensics is not None
            else None
        )
        has_caution = not item.is_financial and (
            item.earnings_quality_tag in {"investment_driven", "subsidy_inflated"}
            or (
                item.invest_profit_share_3y_pct is not None
                and item.invest_profit_share_3y_pct >= 30.0
            )
            or (
                item.investment_assets_ratio_pct is not None
                and item.investment_assets_ratio_pct >= 40.0
            )
            or (non_rec is not None and non_rec >= 30.0)
        )
        if quality_filter == "hide_investment_heavy":
            return not has_caution
        fcf_cov = snapshot.shareholder_return.fcf_coverage_ratio
        return (
            item.ct_red_count == 0
            and item.dividend_yield_pct is not None
            and item.dividend_yield_pct >= 3.0
            and not has_caution
            and (item.is_financial or (fcf_cov is not None and fcf_cov >= 0.8))
        )
    return True


def _sortable_metric_value(item: StockScreenerItem, sort_by: ScreenerSortField) -> float | None:
    raw: float | int | None = getattr(item, sort_by)
    if raw is None:
        return None
    val = float(raw)
    return val if math.isfinite(val) else None


def screen_snapshots(
    snapshots: Sequence[StockSnapshotPayload],
    *,
    zero_red_only: bool = False,
    max_pe_percentile: float | None = None,
    min_roe: float | None = None,
    min_dividend_yield: float | None = None,
    industry: str | None = None,
    query: str | None = None,
    quality_filter: ScreenerQualityFilter = "all",
    sort_by: ScreenerSortField = "total_score",
    sort_dir: ScreenerSortDir = "desc",
    limit: int = 50,
) -> StockScreenerResponse:
    """Filter, sort (null-last), and paginate precomputed synced-pool snapshots."""
    paired_items = [(snapshot_to_screener_item(snap), snap) for snap in snapshots]
    total_synced = len(paired_items)
    industries = sorted(
        {
            item.industry_sw1.strip()
            for item, _ in paired_items
            if item.industry_sw1 and item.industry_sw1.strip()
        }
    )

    cleaned_industry = industry.strip() if industry else ""
    cleaned_query = query.strip().casefold() if query else ""
    pe_cap = (
        max_pe_percentile
        if max_pe_percentile is not None and math.isfinite(max_pe_percentile)
        else None
    )
    roe_floor = min_roe if min_roe is not None and math.isfinite(min_roe) else None
    div_floor = (
        min_dividend_yield
        if min_dividend_yield is not None and math.isfinite(min_dividend_yield)
        else None
    )

    filtered: list[StockScreenerItem] = []
    for item, snap in paired_items:
        if zero_red_only and item.ct_red_count > 0:
            continue
        if not _matches_quality_filter(item, snap, quality_filter):
            continue
        if pe_cap is not None and (
            item.pe_percentile_10y is None or item.pe_percentile_10y > pe_cap
        ):
            continue
        if roe_floor is not None and (
            item.roe_5y_avg_pct is None or item.roe_5y_avg_pct < roe_floor
        ):
            continue
        if div_floor is not None and (
            item.dividend_yield_pct is None or item.dividend_yield_pct < div_floor
        ):
            continue
        if cleaned_industry and (item.industry_sw1 or "").strip() != cleaned_industry:
            continue
        if (
            cleaned_query
            and cleaned_query not in item.code.casefold()
            and cleaned_query not in item.name.casefold()
        ):
            continue
        filtered.append(item)

    filtered_count = len(filtered)
    non_null: list[tuple[float, str, StockScreenerItem]] = []
    nulls: list[StockScreenerItem] = []
    for item in filtered:
        metric = _sortable_metric_value(item, sort_by)
        if metric is None:
            nulls.append(item)
        else:
            non_null.append((metric, item.code, item))

    desc = sort_dir == "desc"
    non_null.sort(key=lambda entry: (-entry[0] if desc else entry[0], entry[1]))
    nulls.sort(key=lambda item: item.code)
    ordered = [entry[2] for entry in non_null] + nulls

    bounded_limit = max(1, min(limit, 200))
    return StockScreenerResponse(
        total_synced=total_synced,
        filtered_count=filtered_count,
        industries=industries,
        items=ordered[:bounded_limit],
    )
