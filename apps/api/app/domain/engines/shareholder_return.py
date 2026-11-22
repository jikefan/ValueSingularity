"""Shareholder net return & fake-high-dividend scanner."""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Sequence
from datetime import date

from app.domain.engines._helpers import finite_or_none, report_fcf_yuan, sort_reports_asc
from app.domain.models import (
    AnnualReturnPoint,
    ShareholderReturnSection,
    SignalLight,
    StockAnnualReport,
    StockDividendRecord,
    StockEquityFinancingRecord,
    StockRepurchaseRecord,
)


def analyze_shareholder_return(
    annual_reports: Sequence[StockAnnualReport],
    dividends: Sequence[StockDividendRecord],
    repurchases: Sequence[StockRepurchaseRecord],
    equity_financings: Sequence[StockEquityFinancingRecord],
    *,
    latest_market_cap_yuan: float | None = None,
    as_of: date | None = None,
    max_window_years: int = 10,
) -> ShareholderReturnSection:
    """Compute trailing 5-10y net shareholder return and FCF coverage."""
    ordered_reports = sort_reports_asc(annual_reports)
    fcf_by_year: dict[int, float] = {}
    for report in ordered_reports:
        fcf = report_fcf_yuan(report)
        if fcf is not None:
            fcf_by_year[report.report_year] = fcf

    div_by_year: dict[int, float] = defaultdict(float)
    for div in dividends:
        if math.isfinite(div.dividend_cash_total_yuan) and div.dividend_cash_total_yuan > 0:
            div_by_year[div.report_year] += div.dividend_cash_total_yuan

    rep_by_year: dict[int, float] = defaultdict(float)
    for rep in repurchases:
        if math.isfinite(rep.repurchased_amount_yuan) and rep.repurchased_amount_yuan > 0:
            rep_by_year[rep.year] += rep.repurchased_amount_yuan

    cf_fin_by_year: dict[int, float] = defaultdict(float)
    add_fin_by_year: dict[int, float] = defaultdict(float)
    for fin in equity_financings:
        if not (math.isfinite(fin.amount_yuan) and fin.amount_yuan > 0):
            continue
        if fin.source == "cash_flow":
            cf_fin_by_year[fin.year] += fin.amount_yuan
        else:
            add_fin_by_year[fin.year] += fin.amount_yuan

    all_years: set[int] = (
        {r.report_year for r in ordered_reports}
        | set(div_by_year)
        | set(rep_by_year)
        | set(cf_fin_by_year)
        | set(add_fin_by_year)
    )
    if as_of is not None:
        all_years = {y for y in all_years if y <= as_of.year}

    if not all_years:
        return ShareholderReturnSection(
            window_years=0,
            total_dividend_yuan=0.0,
            total_repurchase_yuan=0.0,
            total_equity_financing_yuan=0.0,
            net_return_yuan=0.0,
            total_fcf_yuan=None,
            fcf_coverage_ratio=None,
            current_dividend_yield_pct=None,
            status="na",
            verdict="缺少分红、回购、再融资与自由现金流历史数据。",
            series=[],
        )

    report_years = [
        r.report_year for r in ordered_reports if as_of is None or r.report_year <= as_of.year
    ]
    end_year = max(report_years) if report_years else max(all_years)
    if all_years and max(all_years) > end_year:
        end_year = max(all_years)
    start_year = max(min(all_years), end_year - max(1, max_window_years) + 1)

    series: list[AnnualReturnPoint] = []
    for year in range(start_year, end_year + 1):
        div_y = round(div_by_year.get(year, 0.0), 2)
        rep_y = round(rep_by_year.get(year, 0.0), 2)
        # Avoid double counting the same equity offering captured in both cash flow and SEO records.
        fin_y = round(max(cf_fin_by_year.get(year, 0.0), add_fin_by_year.get(year, 0.0)), 2)
        net_y = round(div_y + rep_y - fin_y, 2)
        series.append(
            AnnualReturnPoint(
                year=year,
                dividend_yuan=div_y,
                repurchase_yuan=rep_y,
                equity_financing_yuan=fin_y,
                net_return_yuan=net_y,
                fcf_yuan=fcf_by_year.get(year),
            )
        )

    window_years = len(series)
    total_div = round(sum(p.dividend_yuan for p in series), 2)
    total_rep = round(sum(p.repurchase_yuan for p in series), 2)
    total_fin = round(sum(p.equity_financing_yuan for p in series), 2)
    net_return = round(total_div + total_rep - total_fin, 2)

    fcf_points = [p.fcf_yuan for p in series if p.fcf_yuan is not None]
    total_fcf = round(sum(fcf_points), 2) if fcf_points else None

    fcf_coverage_ratio: float | None = None
    if total_fcf is not None and net_return > 0:
        fcf_coverage_ratio = finite_or_none(total_fcf / net_return, 2)

    anchor_div_year = ordered_reports[-1].report_year if ordered_reports else end_year
    latest_div = div_by_year.get(anchor_div_year, 0.0)
    current_dividend_yield_pct: float | None = None
    if (
        latest_market_cap_yuan is not None
        and math.isfinite(latest_market_cap_yuan)
        and latest_market_cap_yuan > 0
    ):
        current_dividend_yield_pct = round((latest_div / latest_market_cap_yuan) * 100.0, 2)

    if net_return < 0:
        status: SignalLight = "red"
        verdict = (
            f"近 {window_years} 年股权再融资（{total_fin / 1e8:.2f}亿元）超过分红与回购合计"
            f"（{(total_div + total_rep) / 1e8:.2f}亿元），股东净回报为负。"
        )
    elif (
        (total_div + total_rep) > 0
        and total_fcf is not None
        and (total_fcf <= 0 or (fcf_coverage_ratio is not None and fcf_coverage_ratio < 0.6))
    ):
        status = "red"
        cov_txt = f"{fcf_coverage_ratio:.2f} 倍" if fcf_coverage_ratio is not None else "为负"
        alert_prefix = "伪高股息警示" if total_div > 0 else "现金回报警示"
        payout_label = "派息" if total_div > 0 else "现金回报"
        verdict = (
            f"{alert_prefix}：近 {window_years} 年累计自由现金流对净回报覆盖仅 {cov_txt}，"
            f"{payout_label}缺乏持续现金流支撑。"
        )
    elif (
        (total_div + total_rep) > 0
        and total_fcf is not None
        and fcf_coverage_ratio is not None
        and fcf_coverage_ratio < 1.0
    ):
        status = "yellow"
        verdict = (
            f"近 {window_years} 年净回报 {net_return / 1e8:.2f}亿元，"
            f"自由现金流覆盖倍数 {fcf_coverage_ratio:.2f} 倍，覆盖度略偏紧。"
        )
    elif net_return == 0:
        status = "yellow"
        verdict = f"近 {window_years} 年未向股东产生净现金回报。"
    elif total_fcf is None:
        status = "yellow"
        verdict = (
            f"近 {window_years} 年累计净回报 {net_return / 1e8:.2f}亿元，"
            "但缺少自由现金流数据验证覆盖度。"
        )
    else:
        status = "green"
        cov_txt = f"{fcf_coverage_ratio:.2f} 倍" if fcf_coverage_ratio is not None else "充足"
        verdict = (
            f"近 {window_years} 年累计净回报 {net_return / 1e8:.2f}亿元，"
            f"自由现金流覆盖倍数达 {cov_txt}，属真金白银回报。"
        )

    return ShareholderReturnSection(
        window_years=window_years,
        total_dividend_yuan=total_div,
        total_repurchase_yuan=total_rep,
        total_equity_financing_yuan=total_fin,
        net_return_yuan=net_return,
        total_fcf_yuan=total_fcf,
        fcf_coverage_ratio=fcf_coverage_ratio,
        current_dividend_yield_pct=current_dividend_yield_pct,
        status=status,
        verdict=verdict,
        series=series,
    )
