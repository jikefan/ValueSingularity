"""Full StockSnapshotPayload assembly engine (pure domain logic)."""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import UTC, date, datetime
from typing import Literal

from app.domain.engines._helpers import (
    clamp_score,
    compute_cagr_pct,
    finite_or_none,
    is_financial_institution,
    percentile_rank,
    report_fcf_yuan,
    report_interest_debt_yuan,
    report_net_cash_yuan,
    safe_pct,
    sort_reports_asc,
)
from app.domain.engines.ct_scanner import scan_financial_ct
from app.domain.engines.forensics import analyze_stock_forensics
from app.domain.engines.reverse_dcf import compute_reverse_dcf
from app.domain.engines.shareholder_return import analyze_shareholder_return
from app.domain.market_math import subtract_years
from app.domain.models import (
    AnnualFinancialTrendPoint,
    FinancialCtSection,
    GrowthSection,
    MoatDimensionItem,
    MoatSection,
    PeerBenchmarkMetrics,
    RadarScoreSection,
    ReverseDcfSection,
    ShareholderReturnSection,
    StockAnnualReport,
    StockDailyBar,
    StockFactBundle,
    StockForensicsSection,
    StockMetaRecord,
    StockSnapshotPayload,
    ValuationHistoryPoint,
    ValuationSection,
)

_MAX_HISTORY_POINTS = 260
_RECENT_DAILY_POINTS = 60

_FORMULA_NOTES: dict[str, str] = {
    "ct_scanner": (
        "财务排雷 CT 共扫描 7 项本土风险：存贷双高、在建工程不转固、现金流与利润背离、"
        "应收与存货膨胀、商誉减值悬顶、全市场质押比例及年报审计意见；所有红黄灯均可下钻至历年科目。"
    ),
    "shareholder_return": (
        "股东净回报 = 累计现金分红 + 累计已实施回购 - 累计母公司口径股权再融资；"
        "自由现金流覆盖倍数 = 累计(经营现金流 - 购建长期资产支出) / 股东净回报。"
    ),
    "reverse_dcf": (
        "逆向 DCF 以近 3 年平均自由现金流为基数、企业价值 EV = 总市值 - 净现金，"
        "在默认折现率 9.0%、第 10 年终值倍数 12.0x 下用二分法反推隐含未来十年 "
        "FCF 年化增速，不输出主观目标价。"
    ),
    "valuation_percentiles": (
        "PE/PB 历史分位基于全部日线估值序列在对应近 5 年/近 10 年窗口内计算，"
        "仅纳入正值样本；走势图采样保留近 60 个交易日日频与更早区间周频（上限 260 点）。"
    ),
    "graham": (
        "格雷厄姆数字 = √(22.5 × EPS × BVPS) = 最新收盘价 × √(22.5 / (PE_TTM × PB))；"
        "安全边际率 = (格雷厄姆数字 - 现价) / 格雷厄姆数字 × 100%。"
    ),
    "roic_approx": (
        "近似 ROIC = (归母净利润 + 利息支出 × 0.75) / (股东权益 + 有息负债 - 货币资金)。"
    ),
    "radar": (
        "五维雷达（盈利能力、护城河、资产负债、现金流质量、估值安全边际）"
        "按确定性定量规则映射至 0–100 分。"
    ),
}


def _dedup_bars_asc(
    bars: Sequence[StockDailyBar],
    *,
    as_of_limit: bool = True,
    as_of: date | None = None,
) -> list[StockDailyBar]:
    by_date: dict[date, StockDailyBar] = {}
    for bar in bars:
        if as_of_limit and as_of is not None and bar.trade_date > as_of:
            continue
        by_date[bar.trade_date] = bar
    return [by_date[d] for d in sorted(by_date)]


def _sample_valuation_history(bars: Sequence[StockDailyBar]) -> list[ValuationHistoryPoint]:
    if not bars:
        return []
    latest_date = bars[-1].trade_date
    cutoff_10y = subtract_years(latest_date, 10)
    window = [bar for bar in bars if bar.trade_date >= cutoff_10y]
    if not window:
        window = list(bars[-_MAX_HISTORY_POINTS:])

    if len(window) <= _MAX_HISTORY_POINTS:
        selected = window
    else:
        tail = window[-_RECENT_DAILY_POINTS:]
        head = window[:-_RECENT_DAILY_POINTS]
        by_week: dict[tuple[int, int], StockDailyBar] = {}
        for bar in head:
            iso = bar.trade_date.isocalendar()
            by_week[(iso.year, iso.week)] = bar
        weekly_head = list(by_week.values())
        max_head = _MAX_HISTORY_POINTS - len(tail)
        if len(weekly_head) > max_head and max_head > 0:
            step = len(weekly_head) / max_head
            weekly_head = [
                weekly_head[min(len(weekly_head) - 1, int(i * step))] for i in range(max_head)
            ]
        selected = [*weekly_head, *tail]

    return [
        ValuationHistoryPoint(
            trade_date=bar.trade_date,
            close=round(bar.close, 2),
            pe_ttm=finite_or_none(bar.pe_ttm, 2),
            pb=finite_or_none(bar.pb, 2),
            total_mv_yuan=finite_or_none(bar.total_mv_yuan, 2),
        )
        for bar in selected
    ]


def _build_annual_trends(
    ordered_reports: Sequence[StockAnnualReport],
) -> list[AnnualFinancialTrendPoint]:
    trends: list[AnnualFinancialTrendPoint] = []
    prev_equity: float | None = None

    for report in ordered_reports[-12:]:
        equity = (
            report.parent_equity_yuan
            if report.parent_equity_yuan is not None
            else report.total_equity_yuan
        )
        avg_equity: float | None = None
        if equity is not None and equity > 0:
            if prev_equity is not None and prev_equity > 0:
                avg_equity = 0.5 * (prev_equity + equity)
            else:
                avg_equity = equity
        if equity is not None:
            prev_equity = equity

        gross_profit = (
            report.revenue_yuan - report.operate_cost_yuan
            if report.revenue_yuan is not None and report.operate_cost_yuan is not None
            else None
        )
        trends.append(
            AnnualFinancialTrendPoint(
                year=report.report_year,
                revenue_yuan=finite_or_none(report.revenue_yuan, 2),
                net_profit_yuan=finite_or_none(report.net_profit_yuan, 2),
                deduct_net_profit_yuan=finite_or_none(report.deduct_net_profit_yuan, 2),
                ocf_yuan=finite_or_none(report.ocf_yuan, 2),
                fcf_yuan=report_fcf_yuan(report),
                roe_pct=safe_pct(report.net_profit_yuan, avg_equity, 2),
                gross_margin_pct=safe_pct(gross_profit, report.revenue_yuan, 2),
                net_margin_pct=safe_pct(report.net_profit_yuan, report.revenue_yuan, 2),
                net_cash_yuan=report_net_cash_yuan(report),
                rd_ratio_pct=safe_pct(report.research_expense_yuan, report.revenue_yuan, 2),
            )
        )
    return trends


def _cagr_from_reports(
    ordered: Sequence[StockAnnualReport],
    getter: str,
    target_years: int,
) -> float | None:
    if len(ordered) < 2:
        return None
    latest = ordered[-1]
    end_val = getattr(latest, getter)
    if end_val is None or not math.isfinite(end_val) or end_val <= 0:
        return None
    by_year = {r.report_year: r for r in ordered}
    anchor = by_year.get(latest.report_year - target_years)
    if anchor is None:
        return None
    start_val = getattr(anchor, getter)
    return compute_cagr_pct(start_val, end_val, target_years)


def _build_growth_section(
    ordered: Sequence[StockAnnualReport],
    trends: Sequence[AnnualFinancialTrendPoint],
) -> GrowthSection:
    rev_cagr_3y = _cagr_from_reports(ordered, "revenue_yuan", 3)
    rev_cagr_5y = _cagr_from_reports(ordered, "revenue_yuan", 5)
    profit_cagr_5y = _cagr_from_reports(ordered, "net_profit_yuan", 5)
    deduct_profit_cagr_5y = _cagr_from_reports(ordered, "deduct_net_profit_yuan", 5)

    rd_latest = next((t.rd_ratio_pct for t in reversed(trends) if t.rd_ratio_pct is not None), None)
    capex_to_ocf_latest: float | None = None
    if ordered:
        latest = ordered[-1]
        if latest.capex_yuan is not None and latest.ocf_yuan is not None and latest.ocf_yuan > 0:
            capex_to_ocf_latest = safe_pct(max(0.0, latest.capex_yuan), latest.ocf_yuan, 2)

    return GrowthSection(
        revenue_cagr_3y_pct=rev_cagr_3y,
        revenue_cagr_5y_pct=rev_cagr_5y,
        profit_cagr_5y_pct=profit_cagr_5y,
        deduct_profit_cagr_5y_pct=deduct_profit_cagr_5y,
        rd_ratio_latest_pct=rd_latest,
        capex_to_ocf_latest_pct=capex_to_ocf_latest,
    )


def _build_valuation_section(
    bars: Sequence[StockDailyBar],
    growth: GrowthSection,
    dividend_yield_pct: float | None,
) -> ValuationSection:
    if not bars:
        return ValuationSection(dividend_yield_pct=dividend_yield_pct, history=[])

    latest = bars[-1]
    cutoff_5y = subtract_years(latest.trade_date, 5)
    cutoff_10y = subtract_years(latest.trade_date, 10)

    pe_5y = [
        bar.pe_ttm
        for bar in bars
        if bar.trade_date >= cutoff_5y and bar.pe_ttm is not None and bar.pe_ttm > 0
    ]
    pe_10y = [
        bar.pe_ttm
        for bar in bars
        if bar.trade_date >= cutoff_10y and bar.pe_ttm is not None and bar.pe_ttm > 0
    ]
    pb_10y = [
        bar.pb for bar in bars if bar.trade_date >= cutoff_10y and bar.pb is not None and bar.pb > 0
    ]

    pe_pct_5y = (
        percentile_rank(pe_5y, latest.pe_ttm)
        if latest.pe_ttm is not None and latest.pe_ttm > 0
        else None
    )
    pe_pct_10y = (
        percentile_rank(pe_10y, latest.pe_ttm)
        if latest.pe_ttm is not None and latest.pe_ttm > 0
        else None
    )
    pb_pct_10y = (
        percentile_rank(pb_10y, latest.pb) if latest.pb is not None and latest.pb > 0 else None
    )

    graham_number: float | None = None
    graham_margin_pct: float | None = None
    if (
        latest.close > 0
        and latest.pe_ttm is not None
        and latest.pe_ttm > 0
        and latest.pb is not None
        and latest.pb > 0
    ):
        graham_number = round(latest.close * math.sqrt(22.5 / (latest.pe_ttm * latest.pb)), 2)
        if graham_number > 0:
            graham_margin_pct = round(((graham_number - latest.close) / graham_number) * 100.0, 2)

    peg: float | None = None
    growth_anchor = (
        growth.deduct_profit_cagr_5y_pct
        if growth.deduct_profit_cagr_5y_pct is not None
        else (
            growth.profit_cagr_5y_pct
            if growth.profit_cagr_5y_pct is not None
            else growth.revenue_cagr_5y_pct
        )
    )
    if (
        latest.pe_ttm is not None
        and latest.pe_ttm > 0
        and growth_anchor is not None
        and growth_anchor > 0
    ):
        peg = round(latest.pe_ttm / growth_anchor, 2)

    return ValuationSection(
        latest_trade_date=latest.trade_date,
        close=round(latest.close, 2),
        total_mv_yuan=finite_or_none(latest.total_mv_yuan, 2),
        pe_ttm=finite_or_none(latest.pe_ttm, 2),
        pe_percentile_5y=pe_pct_5y,
        pe_percentile_10y=pe_pct_10y,
        pb=finite_or_none(latest.pb, 2),
        pb_percentile_10y=pb_pct_10y,
        dividend_yield_pct=dividend_yield_pct,
        graham_number=graham_number,
        graham_margin_pct=graham_margin_pct,
        peg=peg,
        history=_sample_valuation_history(bars),
    )


def _compute_roic_approx_pct(latest: StockAnnualReport | None) -> float | None:
    if latest is None or latest.net_profit_yuan is None:
        return None
    interest_raw = latest.interest_expense_yuan if latest.interest_expense_yuan is not None else 0.0
    interest = max(0.0, interest_raw)
    nopat = latest.net_profit_yuan + interest * 0.75
    equity = (
        latest.total_equity_yuan
        if latest.total_equity_yuan is not None
        else latest.parent_equity_yuan
    )
    if equity is None:
        return None
    monetary = latest.monetary_funds_yuan if latest.monetary_funds_yuan is not None else 0.0
    invested_capital = equity + report_interest_debt_yuan(latest) - monetary
    if invested_capital <= 0:
        invested_capital = equity
    return safe_pct(nopat, invested_capital, 2)


def _build_moat_section(
    ordered: Sequence[StockAnnualReport],
    trends: Sequence[AnnualFinancialTrendPoint],
    growth: GrowthSection,
    ocf_to_profit_5y_pct: float | None,
    *,
    shareholder_return: ShareholderReturnSection | None = None,
    meta: StockMetaRecord | None = None,
) -> MoatSection:
    roe_5y_vals = [t.roe_pct for t in trends[-5:] if t.roe_pct is not None]
    roe_10y_vals = [t.roe_pct for t in trends[-10:] if t.roe_pct is not None]
    gm_5y_vals = [t.gross_margin_pct for t in trends[-5:] if t.gross_margin_pct is not None]

    roe_5y_avg = round(sum(roe_5y_vals) / len(roe_5y_vals), 2) if roe_5y_vals else None
    roe_10y_min = round(min(roe_10y_vals), 2) if roe_10y_vals else None
    gm_latest = gm_5y_vals[-1] if gm_5y_vals else None
    gm_5y_std: float | None = None
    if gm_5y_vals:
        mean_gm = sum(gm_5y_vals) / len(gm_5y_vals)
        variance = sum((x - mean_gm) ** 2 for x in gm_5y_vals) / len(gm_5y_vals)
        gm_5y_std = round(math.sqrt(variance), 2)

    roic_pct = _compute_roic_approx_pct(ordered[-1] if ordered else None)
    net_cash = trends[-1].net_cash_yuan if trends else None
    latest_debt = report_interest_debt_yuan(ordered[-1], include_lease=True) if ordered else 0.0
    is_financial = is_financial_institution(meta)

    # Score 6 moat dimensions deterministically onto [0, 100].
    roe_score = (
        clamp_score(
            (roe_5y_avg / 25.0) * 65.0
            + max(
                0.0,
                min(35.0, ((roe_10y_min if roe_10y_min is not None else 0.0) / 15.0) * 35.0),
            )
        )
        if roe_5y_avg is not None
        else 50
    )
    gm_stability_bonus = max(0.0, 30.0 - gm_5y_std * 4.0) if gm_5y_std is not None else 15.0
    if is_financial and gm_latest is None:
        pricing_score = 55
        pricing_summary = "金融业不核算传统工业毛利率，盈利能力重在净息差与中间业务收入稳健性。"
    elif gm_latest is not None:
        pricing_score = clamp_score(min(70.0, max(0.0, gm_latest * 0.9)) + gm_stability_bonus)
        pricing_summary = (
            f"最新毛利率 {gm_latest:.1f}%，5年波动标准差 {gm_5y_std:.2f}%。"
            if gm_5y_std is not None
            else "毛利率历史序列尚不完整。"
        )
    else:
        pricing_score = 50
        pricing_summary = "毛利率历史序列尚不完整。"

    if is_financial:
        recent_profits = [r.net_profit_yuan for r in ordered[-5:] if r.net_profit_yuan is not None]
        profit_adj = 0.0
        if recent_profits:
            if all(p > 0 for p in recent_profits):
                profit_adj = 10.0
            elif recent_profits[-1] > 0:
                profit_adj = 5.0
            else:
                profit_adj = -15.0
        div_adj = 0.0
        if shareholder_return is not None:
            div_years = sum(1 for pt in shareholder_return.series[-5:] if pt.dividend_yuan > 0)
            if div_years >= 4:
                div_adj = 15.0
            elif div_years >= 2:
                div_adj = 8.0
            if shareholder_return.net_return_yuan < 0:
                div_adj -= 10.0
        cash_score = max(25, min(95, clamp_score(60.0 + profit_adj + div_adj)))
        cash_summary = (
            "金融行业存贷款变动计入经营现金流，不适用传统净现比；已切换至分红可持续性评估。"
        )
    elif ocf_to_profit_5y_pct is not None:
        cash_score = clamp_score(min(100.0, max(0.0, ocf_to_profit_5y_pct * 0.85)))
        cash_summary = f"近5年累计净现比 {ocf_to_profit_5y_pct:.1f}%。"
    else:
        cash_score = 50
        cash_summary = "缺少5年经营现金流与利润对比数据。"

    capex_ratio = (
        growth.capex_to_ocf_latest_pct if growth.capex_to_ocf_latest_pct is not None else 30.0
    )
    cap_penalty = min(30.0, max(0.0, (capex_ratio - 30.0) * 0.4))
    roic_score = (
        clamp_score(min(100.0, max(0.0, roic_pct * 4.0 + 15.0 - cap_penalty)))
        if roic_pct is not None
        else 50
    )
    if is_financial:
        fortress_score = 65
        fortress_summary = "金融行业资产负债结构以资本充足率与拨备覆盖率为核心指标。"
    elif net_cash is None:
        fortress_score = 50
        fortress_summary = "缺少货币资金与有息负债明细。"
    elif net_cash >= 0 and latest_debt <= 0:
        fortress_score = 95
        fortress_summary = f"最新净现金 {net_cash / 1e8:.2f} 亿元。"
    elif net_cash >= 0:
        fortress_score = 82
        fortress_summary = f"最新净现金 {net_cash / 1e8:.2f} 亿元。"
    else:
        fortress_score = clamp_score(max(20.0, 70.0 - abs(net_cash) / max(1.0, latest_debt) * 25.0))
        fortress_summary = f"最新净现金 {net_cash / 1e8:.2f} 亿元。"

    rd_latest = growth.rd_ratio_latest_pct if growth.rd_ratio_latest_pct is not None else 0.0
    rev_cagr_5y = growth.revenue_cagr_5y_pct if growth.revenue_cagr_5y_pct is not None else 0.0
    rd_component = min(40.0, max(0.0, rd_latest * 4.0))
    growth_component = min(60.0, max(0.0, (rev_cagr_5y + 5.0) * 2.4))
    reinvest_score = (
        clamp_score(rd_component + growth_component)
        if (growth.rd_ratio_latest_pct is not None or growth.revenue_cagr_5y_pct is not None)
        else 50
    )

    dimensions = [
        MoatDimensionItem(
            key="roe_durability",
            label="ROE 持久力",
            score=roe_score,
            summary=(
                f"5年均值 {roe_5y_avg:.1f}%，近10年最低 {roe_10y_min:.1f}%。"
                if roe_5y_avg is not None and roe_10y_min is not None
                else "ROE 历史序列尚不完整。"
            ),
        ),
        MoatDimensionItem(
            key="pricing_power",
            label="毛利率与定价权",
            score=pricing_score,
            summary=pricing_summary,
        ),
        MoatDimensionItem(
            key="cash_conversion",
            label="盈利含金量",
            score=cash_score,
            summary=cash_summary,
        ),
        MoatDimensionItem(
            key="capital_efficiency",
            label="资本效率",
            score=roic_score,
            summary=(
                f"近似 ROIC {roic_pct:.1f}%。"
                if roic_pct is not None
                else "缺少投入资本回报率数据。"
            ),
        ),
        MoatDimensionItem(
            key="balance_fortress",
            label="资产负债安全垫",
            score=fortress_score,
            summary=fortress_summary,
        ),
        MoatDimensionItem(
            key="rd_reinvestment",
            label="研发与成长延续性",
            score=reinvest_score,
            summary=(
                f"研发费用率 {rd_latest:.2f}%，5年营收 CAGR {growth.revenue_cagr_5y_pct:.1f}%。"
                if growth.revenue_cagr_5y_pct is not None
                else "待补充完整营收复合增速数据。"
            ),
        ),
    ]

    return MoatSection(
        roe_5y_avg_pct=roe_5y_avg,
        roe_10y_min_pct=roe_10y_min,
        gross_margin_latest_pct=gm_latest,
        gross_margin_5y_std_pct=gm_5y_std,
        roic_approx_pct=roic_pct,
        dimensions=dimensions,
    )


def _score_financial_capital_resilience(
    *,
    valuation: ValuationSection,
    shareholder_return: ShareholderReturnSection,
    moat: MoatSection,
) -> int:
    div_yield = (
        valuation.dividend_yield_pct
        if valuation.dividend_yield_pct is not None
        else shareholder_return.current_dividend_yield_pct
    )
    yield_adj = (
        min(18.0, (div_yield / 4.0) * 15.0) if div_yield is not None and div_yield > 0 else 0.0
    )

    recent_div_years = sum(1 for pt in shareholder_return.series[-5:] if pt.dividend_yuan > 0)
    if recent_div_years >= 4:
        payout_adj = 10.0
    elif recent_div_years >= 2:
        payout_adj = 5.0
    elif shareholder_return.total_dividend_yuan <= 0:
        payout_adj = -15.0
    else:
        payout_adj = 2.0

    roe_adj = 0.0
    if moat.roe_10y_min_pct is not None:
        if moat.roe_10y_min_pct >= 10.0:
            roe_adj = 15.0
        elif moat.roe_10y_min_pct >= 8.0:
            roe_adj = 12.0
        elif moat.roe_10y_min_pct >= 5.0:
            roe_adj = 5.0
        elif moat.roe_10y_min_pct < 0:
            roe_adj = -10.0

    # Net equity dilution uses net_return_yuan < 0 rather than shareholder_return.status because
    # industrial FCF coverage flags deposit-driven negative bank OCF as false-positive red.
    dilution_adj = -15.0 if shareholder_return.net_return_yuan < 0 else 0.0
    raw = clamp_score(50.0 + yield_adj + payout_adj + roe_adj + dilution_adj)
    return max(25, min(95, raw))


def _build_radar_and_bear_cases(
    *,
    trends: Sequence[AnnualFinancialTrendPoint],
    valuation: ValuationSection,
    reverse_dcf: ReverseDcfSection,
    ct: FinancialCtSection,
    shareholder_return: ShareholderReturnSection,
    moat: MoatSection,
    growth: GrowthSection,
    ocf_to_profit_5y_pct: float | None,
    forensics: StockForensicsSection | None = None,
    is_financial: bool = False,
) -> RadarScoreSection:
    latest_net_margin = next(
        (t.net_margin_pct for t in reversed(trends) if t.net_margin_pct is not None), None
    )
    has_reports = bool(trends)
    roe_val = (
        moat.roe_5y_avg_pct if moat.roe_5y_avg_pct is not None else (0.0 if has_reports else 10.0)
    )
    roic_val = (
        moat.roic_approx_pct if moat.roic_approx_pct is not None else (0.0 if has_reports else 10.0)
    )
    margin_val = (
        latest_net_margin if latest_net_margin is not None else (0.0 if has_reports else 8.0)
    )
    profitability = clamp_score(
        (min(100.0, max(0.0, roe_val * 3.5)) * 0.50)
        + (min(100.0, max(0.0, roic_val * 3.5)) * 0.30)
        + (min(100.0, max(0.0, margin_val * 2.2)) * 0.20)
    )
    moat_score = clamp_score(
        sum(dim.score for dim in moat.dimensions) / len(moat.dimensions)
        if moat.dimensions
        else 50.0
    )

    latest_net_cash = trends[-1].net_cash_yuan if trends else None
    balance_base = (
        65.0
        if is_financial
        else (80.0 if (latest_net_cash is not None and latest_net_cash >= 0) else 55.0)
    )
    balance_sheet = clamp_score(balance_base - ct.red_count * 18.0 - ct.yellow_count * 7.0)

    if is_financial:
        cashflow_quality = _score_financial_capital_resilience(
            valuation=valuation,
            shareholder_return=shareholder_return,
            moat=moat,
        )
    else:
        cov = shareholder_return.fcf_coverage_ratio
        cashflow_base = (
            min(100.0, max(0.0, ocf_to_profit_5y_pct * 0.85))
            if ocf_to_profit_5y_pct is not None
            else 50.0
        )
        cov_bonus = (
            10.0
            if (cov is not None and cov >= 1.0)
            else (-15.0 if shareholder_return.status == "red" else 0.0)
        )
        cashflow_quality = clamp_score(cashflow_base + cov_bonus)

    if is_financial:
        if valuation.pb_percentile_10y is not None and valuation.pe_percentile_10y is not None:
            pct_anchor: float | None = (
                0.6 * valuation.pb_percentile_10y + 0.4 * valuation.pe_percentile_10y
            )
        elif valuation.pb_percentile_10y is not None:
            pct_anchor = valuation.pb_percentile_10y
        else:
            pct_anchor = valuation.pe_percentile_10y
    else:
        pct_anchor = (
            valuation.pe_percentile_10y
            if valuation.pe_percentile_10y is not None
            else valuation.pb_percentile_10y
        )
    val_base = max(10.0, 100.0 - pct_anchor) if pct_anchor is not None else 50.0
    graham_adj = (
        max(-15.0, min(15.0, valuation.graham_margin_pct * 0.3))
        if valuation.graham_margin_pct is not None
        else 0.0
    )
    dcf_adj = 0.0
    if not is_financial and reverse_dcf.implied_vs_history_gap_pct is not None:
        dcf_adj = max(-15.0, min(10.0, -reverse_dcf.implied_vs_history_gap_pct * 0.8))
    valuation_margin = clamp_score(val_base + graham_adj + dcf_adj)

    raw_total = (
        0.25 * profitability
        + 0.20 * moat_score
        + 0.20 * balance_sheet
        + 0.20 * cashflow_quality
        + 0.15 * valuation_margin
        - ct.red_count * 5.0
    )
    total_score = clamp_score(raw_total)

    bear_cases: list[str] = []
    for check in ct.checks:
        if check.status in {"red", "yellow"}:
            bear_cases.append(f"[{check.title}] {check.summary}")
    if (
        reverse_dcf.implied_vs_history_gap_pct is not None
        and reverse_dcf.implied_vs_history_gap_pct > 5.0
    ):
        bear_cases.append(
            f"[逆向估值偏乐观] 当前隐含 FCF 增速 {reverse_dcf.implied_fcf_cagr_pct:.2f}% "
            f"高于历史营收增速 {reverse_dcf.implied_vs_history_gap_pct:.2f} 个百分点。"
        )
    elif (
        not reverse_dcf.solvable
        and reverse_dcf.base_fcf_yuan is not None
        and reverse_dcf.base_fcf_yuan <= 0
    ):
        bear_cases.append(f"[自由现金流承压] {reverse_dcf.note}")
    if valuation.pe_percentile_10y is not None and valuation.pe_percentile_10y >= 75.0:
        bear_cases.append(
            f"[估值分位偏高] 当前 PE(TTM) 处于近10年 {valuation.pe_percentile_10y:.1f}% 分位，"
            "安全边际收窄。"
        )
    if shareholder_return.status == "red" and (
        not is_financial or shareholder_return.net_return_yuan < 0
    ):
        bear_cases.append(f"[股东回报警示] {shareholder_return.verdict}")
    if growth.revenue_cagr_3y_pct is not None and growth.revenue_cagr_3y_pct < 0:
        bear_cases.append(
            f"[成长性放缓] 近3年营收复合增速为 {growth.revenue_cagr_3y_pct:.2f}%，主业规模收缩。"
        )
    if not is_financial and forensics is not None:
        for finding in forensics.findings:
            if finding.finding_id in {"investment_reliance", "non_recurring_subsidy"} and (
                finding.status in {"red", "yellow"}
            ):
                bear_cases.append(f"[{finding.title}] {finding.headline}：{finding.detail}")
    if not bear_cases:
        bear_cases.append(
            "当前定量排雷与估值指标未见显著警示，仍需持续跟踪行业竞争格局与资本开支回报。"
        )

    scoring_profile: Literal["standard", "financial"] = "financial" if is_financial else "standard"
    dimension_labels = {"cashflow_quality": "资本与分红耐力"} if is_financial else {}

    return RadarScoreSection(
        profitability=profitability,
        moat=moat_score,
        balance_sheet=balance_sheet,
        cashflow_quality=cashflow_quality,
        valuation_margin=valuation_margin,
        total_score=total_score,
        scoring_profile=scoring_profile,
        dimension_labels=dimension_labels,
        bear_cases=bear_cases,
    )


def build_stock_snapshot(
    meta: StockMetaRecord,
    bundle: StockFactBundle,
    *,
    generated_at: datetime | None = None,
) -> StockSnapshotPayload:
    """Assemble the complete precomputed StockSnapshotPayload from meta and fact bundle."""
    meta_updates: dict[str, object] = {}
    if bundle.profile_industry_sw1 is not None and bundle.profile_industry_sw1 != meta.industry_sw1:
        meta_updates["industry_sw1"] = bundle.profile_industry_sw1
    if bundle.profile_industry_sw2 is not None and bundle.profile_industry_sw2 != meta.industry_sw2:
        meta_updates["industry_sw2"] = bundle.profile_industry_sw2
    if bundle.profile_list_date is not None and bundle.profile_list_date != meta.list_date:
        meta_updates["list_date"] = bundle.profile_list_date
    effective_meta = meta.model_copy(update=meta_updates) if meta_updates else meta
    is_financial = is_financial_institution(effective_meta)

    ordered_reports = sort_reports_asc(bundle.annual_reports)
    ordered_bars = _dedup_bars_asc(bundle.daily_bars, as_of=bundle.as_of)

    latest_bar = ordered_bars[-1] if ordered_bars else None
    latest_mcap = latest_bar.total_mv_yuan if latest_bar is not None else None

    trends = _build_annual_trends(ordered_reports)
    growth = _build_growth_section(ordered_reports, trends)
    ct_section = scan_financial_ct(ordered_reports, bundle.pledge, meta=effective_meta)
    shareholder_return = analyze_shareholder_return(
        ordered_reports,
        bundle.dividends,
        bundle.repurchases,
        bundle.equity_financings,
        latest_market_cap_yuan=latest_mcap,
        as_of=bundle.as_of,
    )
    reverse_dcf = compute_reverse_dcf(
        ordered_reports, market_cap_yuan=latest_mcap, meta=effective_meta
    )
    valuation = _build_valuation_section(
        ordered_bars,
        growth,
        shareholder_return.current_dividend_yield_pct,
    )

    ocf_to_profit_5y_pct: float | None = None
    if not is_financial:
        recent_5y_ocf_profit = [
            (r.ocf_yuan, r.net_profit_yuan)
            for r in ordered_reports[-5:]
            if r.ocf_yuan is not None and r.net_profit_yuan is not None
        ]
        if recent_5y_ocf_profit:
            sum_ocf = sum(pair[0] for pair in recent_5y_ocf_profit)
            sum_profit = sum(pair[1] for pair in recent_5y_ocf_profit)
            ocf_to_profit_5y_pct = safe_pct(sum_ocf, sum_profit, 2)

    moat = _build_moat_section(
        ordered_reports,
        trends,
        growth,
        ocf_to_profit_5y_pct,
        shareholder_return=shareholder_return,
        meta=effective_meta,
    )
    forensics = analyze_stock_forensics(
        ordered_reports,
        effective_meta,
        dividends=bundle.dividends,
        repurchases=bundle.repurchases,
        equity_financings=bundle.equity_financings,
        shareholder_return=shareholder_return,
        as_of=bundle.as_of,
        is_financial=is_financial,
    )
    radar = _build_radar_and_bear_cases(
        trends=trends,
        valuation=valuation,
        reverse_dcf=reverse_dcf,
        ct=ct_section,
        shareholder_return=shareholder_return,
        moat=moat,
        growth=growth,
        ocf_to_profit_5y_pct=ocf_to_profit_5y_pct,
        forensics=forensics,
        is_financial=is_financial,
    )

    net_cash_to_mv_pct: float | None = None
    if (
        not is_financial
        and reverse_dcf.net_cash_yuan is not None
        and valuation.total_mv_yuan is not None
        and valuation.total_mv_yuan > 0
    ):
        net_cash_to_mv_pct = round((reverse_dcf.net_cash_yuan / valuation.total_mv_yuan) * 100.0, 2)

    shareholder_yield_pct: float | None = None
    if (
        valuation.total_mv_yuan is not None
        and math.isfinite(valuation.total_mv_yuan)
        and valuation.total_mv_yuan > 0
        and shareholder_return.series
    ):
        anchor_year = (
            ordered_reports[-1].report_year
            if ordered_reports
            else shareholder_return.series[-1].year
        )
        anchor_point = next(
            (point for point in shareholder_return.series if point.year == anchor_year),
            shareholder_return.series[-1],
        )
        if bundle.repurchases:
            repurchase_cutoff = subtract_years(bundle.as_of, 1)
            trailing_12m_repurchase = sum(
                rep.repurchased_amount_yuan
                for rep in bundle.repurchases
                if repurchase_cutoff <= rep.event_date <= bundle.as_of
                and math.isfinite(rep.repurchased_amount_yuan)
            )
        else:
            trailing_12m_repurchase = anchor_point.repurchase_yuan
        post_anchor_equity_financing = sum(
            point.equity_financing_yuan
            for point in shareholder_return.series
            if point.year > anchor_point.year
        )
        net_cash_to_shareholders = (
            anchor_point.dividend_yuan
            + trailing_12m_repurchase
            - (anchor_point.equity_financing_yuan + post_anchor_equity_financing)
        )
        shareholder_yield_pct = finite_or_none(
            (net_cash_to_shareholders / valuation.total_mv_yuan) * 100.0,
            2,
        )

    peer_metrics = PeerBenchmarkMetrics(
        code=effective_meta.code,
        name=effective_meta.name,
        exchange=effective_meta.exchange,
        industry_sw1=effective_meta.industry_sw1,
        as_of=bundle.as_of,
        close=valuation.close,
        total_mv_yuan=valuation.total_mv_yuan,
        pe_ttm=valuation.pe_ttm,
        pe_percentile_10y=valuation.pe_percentile_10y,
        pb=valuation.pb,
        roe_5y_avg_pct=moat.roe_5y_avg_pct,
        gross_margin_latest_pct=moat.gross_margin_latest_pct,
        net_cash_to_mv_pct=net_cash_to_mv_pct,
        ocf_to_profit_5y_pct=ocf_to_profit_5y_pct,
        shareholder_yield_pct=shareholder_yield_pct,
        implied_fcf_cagr_pct=reverse_dcf.implied_fcf_cagr_pct,
        ct_red_count=ct_section.red_count,
        ct_yellow_count=ct_section.yellow_count,
        total_score=radar.total_score,
        is_financial=is_financial,
        earnings_quality_tag=forensics.earnings_quality_tag,
        earnings_quality_label=forensics.earnings_quality_label,
        invest_profit_share_3y_pct=forensics.invest_profit_share_3y_pct,
        investment_assets_ratio_pct=forensics.investment_assets_ratio_pct,
    )

    latest_audit = next(
        (r.audit_opinion for r in reversed(ordered_reports) if r.audit_opinion),
        None,
    )
    formula_notes = dict(_FORMULA_NOTES)
    formula_notes["forensics"] = (
        "主业利润拆解 = 营业利润 - 投资收益 - 公允价值变动收益 - 其他收益 - 资产处置收益；"
        "表内投资类资产 = 交易性金融资产 + 长期股权投资 + 投资性房地产及其他金融/债权投资；"
        "杜邦三因子基于平均净资产与平均总资产计算，金融业态豁免总资产周转率。"
    )
    if is_financial:
        formula_notes["financial_radar"] = (
            "金融行业（银行/保险/券商等）存贷款及同业资金变动计入经营现金流，"
            "故豁免传统净现比、在建工程及存贷双高扫描；五维雷达第四维切换为「资本与分红耐力」，"
            "综合股息率、分红持续性、10年最低 ROE 稳定性与净稀释状态评估，"
            "估值优先参考 PB 历史分位。"
        )

    return StockSnapshotPayload(
        schema_version=1,
        code=effective_meta.code,
        name=effective_meta.name,
        exchange=effective_meta.exchange,
        industry_sw1=effective_meta.industry_sw1,
        industry_sw2=effective_meta.industry_sw2,
        as_of=bundle.as_of,
        generated_at=generated_at if generated_at is not None else datetime.now(UTC),
        data_source=bundle.data_source,
        annual_trends=trends,
        valuation=valuation,
        reverse_dcf=reverse_dcf,
        financial_ct=ct_section,
        shareholder_return=shareholder_return,
        moat=moat,
        growth=growth,
        radar=radar,
        forensics=forensics,
        peer_metrics=peer_metrics,
        pledge_ratio_pct=finite_or_none(bundle.pledge.pledge_ratio_pct, 2)
        if bundle.pledge
        else None,
        pledge_date=bundle.pledge.trade_date if bundle.pledge else None,
        latest_audit_opinion=latest_audit,
        formula_notes=formula_notes,
    )
