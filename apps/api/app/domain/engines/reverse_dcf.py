"""Reverse DCF implied FCF CAGR solver (never outputs subjective target prices)."""

from __future__ import annotations

import math
from collections.abc import Sequence

from app.domain.engines._helpers import (
    compute_cagr_pct,
    finite_or_none,
    report_fcf_yuan,
    report_net_cash_yuan,
    sort_reports_asc,
)
from app.domain.models import (
    ReverseDcfSection,
    ReverseDcfSensitivityRow,
    StockAnnualReport,
    StockMetaRecord,
)

_DEFAULT_DISCOUNT_RATE_PCT = 9.0
_DEFAULT_TERMINAL_MULTIPLE = 12.0
_HORIZON_YEARS = 10
_MIN_GROWTH = -0.30
_MAX_GROWTH = 0.60
_SENSITIVITY_DISCOUNT_RATES = (8.0, 9.0, 10.0)
_SENSITIVITY_MULTIPLES = (10.0, 12.0, 15.0)


def dcf_present_value(
    base_fcf_yuan: float,
    growth_rate: float,
    discount_rate: float,
    terminal_multiple: float,
    *,
    horizon_years: int = _HORIZON_YEARS,
) -> float:
    """Compute DCF enterprise value given base FCF, constant growth rate g, r, and terminal M."""
    pv = 0.0
    for year in range(1, horizon_years + 1):
        fcf_t = base_fcf_yuan * ((1.0 + growth_rate) ** year)
        pv += fcf_t / ((1.0 + discount_rate) ** year)
    terminal_fcf = base_fcf_yuan * ((1.0 + growth_rate) ** horizon_years)
    terminal_value = terminal_fcf * terminal_multiple
    pv += terminal_value / ((1.0 + discount_rate) ** horizon_years)
    return pv


def solve_implied_fcf_cagr_pct(
    enterprise_value_yuan: float,
    base_fcf_yuan: float,
    *,
    discount_rate_pct: float = _DEFAULT_DISCOUNT_RATE_PCT,
    terminal_multiple: float = _DEFAULT_TERMINAL_MULTIPLE,
    horizon_years: int = _HORIZON_YEARS,
    min_growth: float = _MIN_GROWTH,
    max_growth: float = _MAX_GROWTH,
) -> float | None:
    """Solve for the 10y FCF CAGR in [min_growth, max_growth] matching enterprise_value_yuan."""
    if not (
        math.isfinite(enterprise_value_yuan)
        and math.isfinite(base_fcf_yuan)
        and enterprise_value_yuan > 0
        and base_fcf_yuan > 0
    ):
        return None

    r = discount_rate_pct / 100.0
    pv_low = dcf_present_value(
        base_fcf_yuan, min_growth, r, terminal_multiple, horizon_years=horizon_years
    )
    pv_high = dcf_present_value(
        base_fcf_yuan, max_growth, r, terminal_multiple, horizon_years=horizon_years
    )
    if enterprise_value_yuan < pv_low or enterprise_value_yuan > pv_high:
        return None

    low = min_growth
    high = max_growth
    for _ in range(80):
        mid = 0.5 * (low + high)
        pv_mid = dcf_present_value(
            base_fcf_yuan, mid, r, terminal_multiple, horizon_years=horizon_years
        )
        if pv_mid < enterprise_value_yuan:
            low = mid
        else:
            high = mid

    return round(0.5 * (low + high) * 100.0, 2)


def _historical_revenue_cagr_pct(ordered: Sequence[StockAnnualReport]) -> float | None:
    if len(ordered) < 2:
        return None
    latest = ordered[-1]
    if latest.revenue_yuan is None or latest.revenue_yuan <= 0:
        return None

    target_year = latest.report_year - 5
    by_year = {r.report_year: r for r in ordered}
    anchor = by_year.get(target_year)
    if anchor is None or anchor.revenue_yuan is None or anchor.revenue_yuan <= 0:
        # Fallback to oldest available positive revenue within 3..5y if exact t-5 missing.
        candidates = [
            r
            for r in ordered[:-1]
            if r.revenue_yuan is not None
            and r.revenue_yuan > 0
            and 3 <= (latest.report_year - r.report_year) <= 5
        ]
        if not candidates:
            return None
        anchor = candidates[0]

    years = latest.report_year - anchor.report_year
    return compute_cagr_pct(anchor.revenue_yuan, latest.revenue_yuan, years)


def compute_reverse_dcf(
    reports: Sequence[StockAnnualReport],
    *,
    market_cap_yuan: float | None,
    discount_rate_pct: float = _DEFAULT_DISCOUNT_RATE_PCT,
    terminal_multiple: float = _DEFAULT_TERMINAL_MULTIPLE,
    meta: StockMetaRecord | None = None,
) -> ReverseDcfSection:
    """Invert current enterprise value into market-implied 10y FCF CAGR."""
    ordered = sort_reports_asc(reports)
    latest_report = ordered[-1] if ordered else None
    hist_rev_cagr = _historical_revenue_cagr_pct(ordered)
    clean_mcap = (
        finite_or_none(market_cap_yuan, 2)
        if market_cap_yuan is not None and math.isfinite(market_cap_yuan) and market_cap_yuan > 0
        else None
    )

    if meta is not None and meta.industry_sw1 in {"银行", "非银金融"}:
        return ReverseDcfSection(
            solvable=False,
            note="金融行业资产负债结构特殊，暂不适用企业自由现金流逆向 DCF 模型。",
            market_cap_yuan=clean_mcap,
            enterprise_value_yuan=None,
            net_cash_yuan=None,
            base_fcf_yuan=None,
            base_fcf_years=0,
            discount_rate_pct=discount_rate_pct,
            terminal_multiple=terminal_multiple,
            implied_fcf_cagr_pct=None,
            historical_revenue_cagr_pct=hist_rev_cagr,
            implied_vs_history_gap_pct=None,
            sensitivity=[],
        )

    net_cash_yuan = report_net_cash_yuan(latest_report) if latest_report is not None else None

    valid_fcfs = [fcf for r in ordered if (fcf := report_fcf_yuan(r)) is not None]
    recent_fcfs = valid_fcfs[-3:]
    base_fcf_years = len(recent_fcfs)
    base_fcf_yuan = finite_or_none(sum(recent_fcfs) / base_fcf_years, 2) if recent_fcfs else None

    ev_yuan: float | None = None
    if clean_mcap is not None:
        net_cash_val = net_cash_yuan if net_cash_yuan is not None else 0.0
        ev_yuan = finite_or_none(clean_mcap - net_cash_val, 2)

    sensitivity: list[ReverseDcfSensitivityRow] = []
    for r_pct in _SENSITIVITY_DISCOUNT_RATES:
        for multiple in _SENSITIVITY_MULTIPLES:
            implied = (
                solve_implied_fcf_cagr_pct(
                    ev_yuan,
                    base_fcf_yuan,
                    discount_rate_pct=r_pct,
                    terminal_multiple=multiple,
                )
                if ev_yuan is not None and base_fcf_yuan is not None
                else None
            )
            sensitivity.append(
                ReverseDcfSensitivityRow(
                    discount_rate_pct=r_pct,
                    terminal_multiple=multiple,
                    implied_fcf_cagr_pct=implied,
                )
            )

    if clean_mcap is None:
        return ReverseDcfSection(
            solvable=False,
            note="缺少最新总市值数据，无法反推市场隐含自由现金流增速。",
            market_cap_yuan=None,
            enterprise_value_yuan=None,
            net_cash_yuan=net_cash_yuan,
            base_fcf_yuan=base_fcf_yuan,
            base_fcf_years=base_fcf_years,
            discount_rate_pct=discount_rate_pct,
            terminal_multiple=terminal_multiple,
            implied_fcf_cagr_pct=None,
            historical_revenue_cagr_pct=hist_rev_cagr,
            implied_vs_history_gap_pct=None,
            sensitivity=sensitivity,
        )

    if ev_yuan is None or ev_yuan <= 0:
        return ReverseDcfSection(
            solvable=False,
            note=(
                "当前净现金超过总市值（企业价值 EV ≤ 0），市场未对其未来经营现金流给出正估值溢价，"
                "无法按正企业价值反推增速。"
            ),
            market_cap_yuan=clean_mcap,
            enterprise_value_yuan=ev_yuan,
            net_cash_yuan=net_cash_yuan,
            base_fcf_yuan=base_fcf_yuan,
            base_fcf_years=base_fcf_years,
            discount_rate_pct=discount_rate_pct,
            terminal_multiple=terminal_multiple,
            implied_fcf_cagr_pct=None,
            historical_revenue_cagr_pct=hist_rev_cagr,
            implied_vs_history_gap_pct=None,
            sensitivity=sensitivity,
        )

    if base_fcf_yuan is None or base_fcf_yuan <= 0:
        return ReverseDcfSection(
            solvable=False,
            note="近 3 年平均自由现金流非正（FCF ≤ 0），逆向 DCF 增长率模型不适用。",
            market_cap_yuan=clean_mcap,
            enterprise_value_yuan=ev_yuan,
            net_cash_yuan=net_cash_yuan,
            base_fcf_yuan=base_fcf_yuan,
            base_fcf_years=base_fcf_years,
            discount_rate_pct=discount_rate_pct,
            terminal_multiple=terminal_multiple,
            implied_fcf_cagr_pct=None,
            historical_revenue_cagr_pct=hist_rev_cagr,
            implied_vs_history_gap_pct=None,
            sensitivity=sensitivity,
        )

    implied_cagr = solve_implied_fcf_cagr_pct(
        ev_yuan,
        base_fcf_yuan,
        discount_rate_pct=discount_rate_pct,
        terminal_multiple=terminal_multiple,
    )
    if implied_cagr is None:
        return ReverseDcfSection(
            solvable=False,
            note="在 [-30%, +60%] 合理增速求解区间内无法匹配当前企业价值，市值已计入极端预期。",
            market_cap_yuan=clean_mcap,
            enterprise_value_yuan=ev_yuan,
            net_cash_yuan=net_cash_yuan,
            base_fcf_yuan=base_fcf_yuan,
            base_fcf_years=base_fcf_years,
            discount_rate_pct=discount_rate_pct,
            terminal_multiple=terminal_multiple,
            implied_fcf_cagr_pct=None,
            historical_revenue_cagr_pct=hist_rev_cagr,
            implied_vs_history_gap_pct=None,
            sensitivity=sensitivity,
        )

    gap = round(implied_cagr - hist_rev_cagr, 2) if hist_rev_cagr is not None else None
    if gap is not None and gap > 5.0:
        note = (
            f"在 {discount_rate_pct:.1f}% 折现率与 {terminal_multiple:.1f}x 终值倍数假设下，"
            f"当前股价隐含未来十年 FCF 年化增速 {implied_cagr:.2f}%，"
            f"较历史营收增速高出 {gap:.2f} 个百分点，隐含预期偏乐观。"
        )
    elif gap is not None and gap < -3.0:
        note = (
            f"在 {discount_rate_pct:.1f}% 折现率与 {terminal_multiple:.1f}x 终值倍数假设下，"
            f"当前股价隐含未来十年 FCF 年化增速仅 {implied_cagr:.2f}%，"
            f"低于历史营收增速 {abs(gap):.2f} 个百分点，市场预期偏保守。"
        )
    else:
        note = (
            f"在 {discount_rate_pct:.1f}% 折现率与 {terminal_multiple:.1f}x 终值倍数假设下，"
            f"当前企业价值隐含未来十年 FCF 年化增速约为 {implied_cagr:.2f}%。"
        )

    return ReverseDcfSection(
        solvable=True,
        note=note,
        market_cap_yuan=clean_mcap,
        enterprise_value_yuan=ev_yuan,
        net_cash_yuan=net_cash_yuan,
        base_fcf_yuan=base_fcf_yuan,
        base_fcf_years=base_fcf_years,
        discount_rate_pct=discount_rate_pct,
        terminal_multiple=terminal_multiple,
        implied_fcf_cagr_pct=implied_cagr,
        historical_revenue_cagr_pct=hist_rev_cagr,
        implied_vs_history_gap_pct=gap,
        sensitivity=sensitivity,
    )
