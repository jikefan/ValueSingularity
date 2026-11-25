"""Pure institutional earnings forensics, DuPont decomposition, and capital allocation engine."""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Sequence
from datetime import date

from app.domain.engines._helpers import (
    finite_or_none,
    is_financial_institution,
    report_net_cash_yuan,
    safe_pct,
    sort_reports_asc,
)
from app.domain.models import (
    AnnualEarningsDecompositionPoint,
    CapitalAllocationSummary,
    DupontYearPoint,
    EarningsQualityTag,
    ForensicFinding,
    ShareholderReturnSection,
    SignalLight,
    StockAnnualReport,
    StockDividendRecord,
    StockEquityFinancingRecord,
    StockForensicsSection,
    StockMetaRecord,
    StockRepurchaseRecord,
)

_CLAMP_SHARE_MAX = 999.0
_CLAMP_OCF_RATIO_MAX = 500.0


def _fmt_yi(value: float | None) -> str:
    return f"{value / 1e8:.2f}亿元" if value is not None else "—"


def _fmt_pct(value: float | None) -> str:
    return f"{value:.1f}%" if value is not None else "—"


def _clamp_pct(value: float, *, max_abs: float = _CLAMP_SHARE_MAX) -> float:
    return round(max(-max_abs, min(max_abs, value)), 2)


def _mean_or_none(values: Sequence[float | None], ndigits: int = 2) -> float | None:
    valid = [v for v in values if v is not None and math.isfinite(v)]
    if not valid:
        return None
    return round(sum(valid) / len(valid), ndigits)


def _has_net_debt_inputs(report: StockAnnualReport) -> bool:
    has_debt = any(
        v is not None
        for v in (
            report.short_loan_yuan,
            report.noncurrent_liab_1y_yuan,
            report.long_loan_yuan,
            report.bond_payable_yuan,
            report.short_bond_payable_yuan,
            report.lease_liab_yuan,
            report.total_liabilities_yuan,
        )
    )
    return report.monetary_funds_yuan is not None and has_debt


def _compute_capital_allocation(
    ordered_reports: Sequence[StockAnnualReport],
    *,
    dividends: Sequence[StockDividendRecord],
    repurchases: Sequence[StockRepurchaseRecord],
    equity_financings: Sequence[StockEquityFinancingRecord],
    shareholder_return: ShareholderReturnSection | None,
    ending_investment_assets_yuan: float | None,
    financial: bool,
    as_of: date | None,
) -> CapitalAllocationSummary | None:
    recent = list(ordered_reports[-5:])
    if not recent:
        return None

    window_years = len(recent)
    report_years = [r.report_year for r in recent]
    max_report_year = max(report_years)
    action_years: list[int] = [
        *(
            d.report_year
            for d in dividends
            if math.isfinite(d.dividend_cash_total_yuan)
            and d.dividend_cash_total_yuan > 0
            and (as_of is None or d.report_date <= as_of)
        ),
        *(
            rep.year
            for rep in repurchases
            if math.isfinite(rep.repurchased_amount_yuan)
            and rep.repurchased_amount_yuan > 0
            and (as_of is None or rep.event_date <= as_of)
        ),
        *(
            fin.year
            for fin in equity_financings
            if math.isfinite(fin.amount_yuan)
            and fin.amount_yuan > 0
            and (as_of is None or fin.event_date <= as_of)
        ),
    ]
    if shareholder_return is not None and shareholder_return.series:
        action_years.extend(pt.year for pt in shareholder_return.series)
    valid_action_years = [y for y in action_years if as_of is None or y <= as_of.year]
    end_year = max([max_report_year, *valid_action_years])
    # Align payout window when declared dividends lead the latest annual report.
    if end_year > max_report_year:
        year_set = set(range(end_year - window_years + 1, end_year + 1))
    else:
        year_set = set(report_years)

    ocf_vals = [r.ocf_yuan for r in recent if r.ocf_yuan is not None]
    capex_vals = [max(0.0, r.capex_yuan) for r in recent if r.capex_yuan is not None]
    total_ocf = round(sum(ocf_vals), 2) if ocf_vals else None
    total_capex = round(sum(capex_vals), 2) if capex_vals else None

    if dividends or repurchases or equity_financings:
        div_total = sum(
            d.dividend_cash_total_yuan
            for d in dividends
            if d.report_year in year_set
            and math.isfinite(d.dividend_cash_total_yuan)
            and d.dividend_cash_total_yuan > 0
            and (as_of is None or d.report_date <= as_of)
        )
        rep_total = sum(
            rep.repurchased_amount_yuan
            for rep in repurchases
            if rep.year in year_set
            and math.isfinite(rep.repurchased_amount_yuan)
            and rep.repurchased_amount_yuan > 0
            and (as_of is None or rep.event_date <= as_of)
        )
        cf_fin: dict[int, float] = defaultdict(float)
        add_fin: dict[int, float] = defaultdict(float)
        for fin in equity_financings:
            if (
                fin.year not in year_set
                or not math.isfinite(fin.amount_yuan)
                or fin.amount_yuan <= 0
                or (as_of is not None and fin.event_date > as_of)
            ):
                continue
            if fin.source == "cash_flow":
                cf_fin[fin.year] += fin.amount_yuan
            else:
                add_fin[fin.year] += fin.amount_yuan
        fin_total = sum(max(cf_fin.get(yr, 0.0), add_fin.get(yr, 0.0)) for yr in year_set)
    elif shareholder_return is not None and shareholder_return.series:
        matched_pts = [pt for pt in shareholder_return.series if pt.year in year_set]
        if not matched_pts:
            matched_pts = shareholder_return.series[-window_years:]
        div_total = sum(pt.dividend_yuan for pt in matched_pts)
        rep_total = sum(pt.repurchase_yuan for pt in matched_pts)
        fin_total = sum(pt.equity_financing_yuan for pt in matched_pts)
    else:
        div_total = 0.0
        rep_total = 0.0
        fin_total = 0.0

    div_total = round(div_total, 2)
    rep_total = round(rep_total, 2)
    fin_total = round(fin_total, 2)
    total_payout = div_total + rep_total

    net_debt_change: float | None = None
    if len(recent) >= 2 and _has_net_debt_inputs(recent[0]) and _has_net_debt_inputs(recent[-1]):
        start_net_cash = report_net_cash_yuan(recent[0])
        end_net_cash = report_net_cash_yuan(recent[-1])
        if start_net_cash is not None and end_net_cash is not None:
            net_debt_change = round((-end_net_cash) - (-start_net_cash), 2)

    latest = recent[-1]
    ending_net_cash = report_net_cash_yuan(latest)
    raw_capex_ocf = safe_pct(total_capex, total_ocf, 2)
    raw_payout_ocf = safe_pct(total_payout, total_ocf, 2)
    capex_to_ocf_pct = _clamp_pct(raw_capex_ocf) if raw_capex_ocf is not None else None
    payout_to_ocf_pct = _clamp_pct(raw_payout_ocf) if raw_payout_ocf is not None else None

    if financial:
        allocation_style = "内生分红稳健型" if total_payout >= fin_total else "资本补充与分红并行型"
        summary = (
            f"近 {window_years} 年累计分红 {_fmt_yi(div_total)}、回购 {_fmt_yi(rep_total)}，"
            f"股权再融资 {_fmt_yi(fin_total)}"
            "（金融业信贷及同业资金变动计入经营现金流，不直接与工业 CapEx 类比）。"
        )
    elif total_ocf is None:
        allocation_style = "待补充现金流明细"
        summary = (
            f"近 {window_years} 年累计分红 {_fmt_yi(div_total)}、回购 {_fmt_yi(rep_total)}、"
            f"股权再融资 {_fmt_yi(fin_total)}，缺少经营现金流数据。"
        )
    else:
        inv_asset_ratio = safe_pct(ending_investment_assets_yuan, latest.total_assets_yuan, 2)
        if total_ocf <= 0:
            allocation_style = (
                "造血承压与外部输血型"
                if (fin_total > 0 or (net_debt_change is not None and net_debt_change > 0))
                else "主业现金流承压型"
            )
        elif (
            total_payout >= fin_total
            and payout_to_ocf_pct is not None
            and payout_to_ocf_pct >= 35.0
            and (capex_to_ocf_pct is None or capex_to_ocf_pct <= 50.0)
        ):
            allocation_style = "轻资产现金牛·高分红回报型"
        elif inv_asset_ratio is not None and inv_asset_ratio >= 25.0:
            allocation_style = "盈余留存·金融资产配置型"
        elif capex_to_ocf_pct is not None and capex_to_ocf_pct >= 70.0:
            if fin_total > total_payout or (
                net_debt_change is not None and net_debt_change > total_ocf * 0.2
            ):
                allocation_style = "高资本开支·外延加杠杆扩张型"
            else:
                allocation_style = "内生现金再投资扩张型"
        else:
            allocation_style = "稳健平衡·内生留存与回馈兼顾"

        summary_parts = [f"近 {window_years} 年累计经营现金流 {_fmt_yi(total_ocf)}"]
        if total_capex is not None:
            cap_note = f"（占 OCF {capex_to_ocf_pct:.1f}%）" if capex_to_ocf_pct is not None else ""
            summary_parts.append(f"资本开支 {_fmt_yi(total_capex)}{cap_note}")
        summary_parts.append(f"分红+回购 {_fmt_yi(total_payout)}")
        summary_parts.append(f"股权融资 {_fmt_yi(fin_total)}")
        tail_parts: list[str] = []
        if ending_net_cash is not None:
            tail_parts.append(f"期末净现金 {_fmt_yi(ending_net_cash)}")
        if ending_investment_assets_yuan is not None:
            tail_parts.append(f"表内投资类资产 {_fmt_yi(ending_investment_assets_yuan)}")
        tail_txt = f"；{'、'.join(tail_parts)}" if tail_parts else ""
        summary = "，".join(summary_parts) + tail_txt + "。"

    return CapitalAllocationSummary(
        window_years=window_years,
        total_ocf_yuan=total_ocf,
        total_capex_yuan=total_capex,
        total_dividends_yuan=div_total,
        total_repurchases_yuan=rep_total,
        total_equity_financing_yuan=fin_total,
        net_debt_change_yuan=net_debt_change,
        ending_net_cash_yuan=ending_net_cash,
        ending_investment_assets_yuan=ending_investment_assets_yuan,
        capex_to_ocf_pct=capex_to_ocf_pct,
        payout_to_ocf_pct=payout_to_ocf_pct,
        allocation_style=allocation_style,
        summary=summary,
    )


def _build_annual_decomposition(
    ordered_reports: Sequence[StockAnnualReport],
    *,
    financial: bool,
) -> list[AnnualEarningsDecompositionPoint]:
    points: list[AnnualEarningsDecompositionPoint] = []
    for report in ordered_reports[-10:]:
        op = report.operate_profit_yuan
        has_inv_parts = (
            report.invest_income_yuan is not None or report.fair_value_change_yuan is not None
        )
        invest_fv = (
            round((report.invest_income_yuan or 0.0) + (report.fair_value_change_yuan or 0.0), 2)
            if has_inv_parts or op is not None
            else None
        )
        has_sub_parts = (
            report.other_income_yuan is not None
            or report.asset_disposal_yuan is not None
            or report.nonbusiness_net_yuan is not None
        )
        subsidy_oneoff = (
            round(
                (report.other_income_yuan or 0.0)
                + (report.asset_disposal_yuan or 0.0)
                + (report.nonbusiness_net_yuan or 0.0),
                2,
            )
            if has_sub_parts or op is not None
            else None
        )

        core_op: float | None = None
        core_margin: float | None = None
        invest_share: float | None = None
        if not financial and op is not None:
            core_op = round(
                op
                - (report.invest_income_yuan or 0.0)
                - (report.fair_value_change_yuan or 0.0)
                - (report.other_income_yuan or 0.0)
                - (report.asset_disposal_yuan or 0.0),
                2,
            )
            core_margin = safe_pct(core_op, report.revenue_yuan, 2)
            if invest_fv is not None:
                gross_scale = abs(core_op) + abs(invest_fv)
                if op > 1.0 and gross_scale <= 5.0 * op:
                    invest_share = _clamp_pct((invest_fv / op) * 100.0)
                elif gross_scale > 1.0:
                    invest_share = _clamp_pct((invest_fv / gross_scale) * 100.0)
        elif financial and op is not None and invest_fv is not None:
            if op > 1.0:
                invest_share = _clamp_pct((invest_fv / op) * 100.0)
            else:
                fin_scale = abs(op - invest_fv) + abs(invest_fv)
                if fin_scale > 1.0:
                    invest_share = _clamp_pct((invest_fv / fin_scale) * 100.0)

        points.append(
            AnnualEarningsDecompositionPoint(
                year=report.report_year,
                revenue_yuan=finite_or_none(report.revenue_yuan, 2),
                operate_profit_yuan=finite_or_none(op, 2),
                core_operating_profit_yuan=core_op,
                investment_and_fair_value_yuan=invest_fv,
                subsidy_and_oneoff_yuan=subsidy_oneoff,
                impairment_net_yuan=finite_or_none(report.impairment_net_yuan, 2),
                net_profit_yuan=finite_or_none(report.net_profit_yuan, 2),
                deduct_net_profit_yuan=finite_or_none(report.deduct_net_profit_yuan, 2),
                ocf_yuan=finite_or_none(report.ocf_yuan, 2),
                core_operating_margin_pct=core_margin,
                invest_share_of_op_profit_pct=invest_share,
            )
        )
    return points


def _build_dupont_series(
    ordered_reports: Sequence[StockAnnualReport],
    *,
    financial: bool,
) -> list[DupontYearPoint]:
    if not ordered_reports:
        return []
    start_idx = max(0, len(ordered_reports) - 5)
    prev_report: StockAnnualReport | None = (
        ordered_reports[start_idx - 1] if start_idx > 0 else None
    )

    series: list[DupontYearPoint] = []
    for report in ordered_reports[start_idx:]:
        is_consecutive = prev_report is not None and (
            report.report_year - prev_report.report_year == 1
        )
        prev_eq = (
            (
                prev_report.parent_equity_yuan
                if prev_report.parent_equity_yuan is not None
                else prev_report.total_equity_yuan
            )
            if is_consecutive and prev_report is not None
            else None
        )
        prev_assets = (
            prev_report.total_assets_yuan if is_consecutive and prev_report is not None else None
        )

        eq = (
            report.parent_equity_yuan
            if report.parent_equity_yuan is not None
            else report.total_equity_yuan
        )
        avg_equity: float | None = None
        if eq is not None and eq > 0:
            if prev_eq is not None and prev_eq > 0:
                avg_equity = 0.5 * (prev_eq + eq)
            elif prev_eq is not None and prev_eq <= 0:
                # Omit ROE/EM when recovering from negative equity to avoid >200% distortion.
                avg_equity = None
            else:
                avg_equity = eq

        avg_assets: float | None = None
        if report.total_assets_yuan is not None and report.total_assets_yuan > 0:
            if prev_assets is not None and prev_assets > 0:
                avg_assets = 0.5 * (prev_assets + report.total_assets_yuan)
            else:
                avg_assets = report.total_assets_yuan

        roe_pct = safe_pct(report.net_profit_yuan, avg_equity, 2)
        net_margin_pct = safe_pct(report.net_profit_yuan, report.revenue_yuan, 2)
        asset_turnover: float | None = None
        if not financial and report.revenue_yuan is not None and avg_assets is not None:
            asset_turnover = finite_or_none(report.revenue_yuan / avg_assets, 2)
        equity_multiplier: float | None = None
        if avg_assets is not None and avg_equity is not None and avg_equity > 0:
            equity_multiplier = finite_or_none(avg_assets / avg_equity, 2)

        prev_report = report
        series.append(
            DupontYearPoint(
                year=report.report_year,
                roe_pct=roe_pct,
                net_margin_pct=net_margin_pct,
                asset_turnover=asset_turnover,
                equity_multiplier=equity_multiplier,
            )
        )
    return series


def analyze_stock_forensics(
    reports: Sequence[StockAnnualReport],
    meta: StockMetaRecord | None = None,
    *,
    dividends: Sequence[StockDividendRecord] = (),
    repurchases: Sequence[StockRepurchaseRecord] = (),
    equity_financings: Sequence[StockEquityFinancingRecord] = (),
    shareholder_return: ShareholderReturnSection | None = None,
    as_of: date | None = None,
    is_financial: bool | None = None,
) -> StockForensicsSection:
    """Decompose operating profit quality, DuPont drivers, and 5-year capital allocation."""
    ordered = sort_reports_asc(reports)
    financial = is_financial if is_financial is not None else is_financial_institution(meta)

    annual_decomp = _build_annual_decomposition(ordered, financial=financial)
    dupont_series = _build_dupont_series(ordered, financial=financial)

    dupont_roe_avg = _mean_or_none([p.roe_pct for p in dupont_series])
    dupont_margin_avg = _mean_or_none([p.net_margin_pct for p in dupont_series])
    dupont_turnover_avg = (
        None if financial else _mean_or_none([p.asset_turnover for p in dupont_series])
    )
    dupont_em_avg = _mean_or_none([p.equity_multiplier for p in dupont_series])

    latest = ordered[-1] if ordered else None
    recent3 = ordered[-3:]
    investment_assets_yuan: float | None = None
    investment_assets_ratio_pct: float | None = None
    if latest is not None:
        has_inv_assets = (
            latest.long_equity_invest_yuan is not None
            or latest.invest_property_and_other_fin_yuan is not None
            or (
                any(r.operate_profit_yuan is not None for r in recent3)
                and (
                    latest.trade_fin_assets_yuan is not None or latest.total_assets_yuan is not None
                )
            )
            or any(
                r.long_equity_invest_yuan is not None
                or r.invest_property_and_other_fin_yuan is not None
                for r in recent3
            )
        )
        if has_inv_assets:
            investment_assets_yuan = round(
                (latest.trade_fin_assets_yuan or 0.0)
                + (latest.long_equity_invest_yuan or 0.0)
                + (latest.invest_property_and_other_fin_yuan or 0.0),
                2,
            )
            investment_assets_ratio_pct = safe_pct(
                investment_assets_yuan, latest.total_assets_yuan, 2
            )

    op_3y = [pt for pt in annual_decomp if pt.operate_profit_yuan is not None][-3:]
    invest_share_3y: float | None = None
    core_share_3y: float | None = None
    sum_op_3y: float | None = None
    sum_core_3y: float | None = None
    sum_inv_3y: float | None = None
    if op_3y:
        sum_op = sum(pt.operate_profit_yuan or 0.0 for pt in op_3y)
        sum_inv = sum(pt.investment_and_fair_value_yuan or 0.0 for pt in op_3y)
        sum_op_3y = sum_op
        sum_inv_3y = sum_inv
        if financial:
            if sum_op > 1.0:
                invest_share_3y = _clamp_pct((sum_inv / sum_op) * 100.0)
            else:
                fin_scale = abs(sum_op - sum_inv) + abs(sum_inv)
                if fin_scale > 1.0:
                    invest_share_3y = _clamp_pct((sum_inv / fin_scale) * 100.0)
        else:
            sum_core = sum(pt.core_operating_profit_yuan or 0.0 for pt in op_3y)
            sum_core_3y = sum_core
            gross_scale = abs(sum_core) + abs(sum_inv)
            if sum_op > 1.0 and gross_scale <= 5.0 * sum_op:
                invest_share_3y = _clamp_pct((sum_inv / sum_op) * 100.0)
                core_share_3y = _clamp_pct((sum_core / sum_op) * 100.0)
            elif gross_scale > 1.0:
                invest_share_3y = _clamp_pct((sum_inv / gross_scale) * 100.0)
                core_share_3y = _clamp_pct((sum_core / gross_scale) * 100.0)

    recent_3y = ordered[-3:]
    np_pairs = [
        (r.net_profit_yuan, r.deduct_net_profit_yuan)
        for r in recent_3y
        if r.net_profit_yuan is not None and r.deduct_net_profit_yuan is not None
    ]
    sum_np_3y = sum(pair[0] for pair in np_pairs) if np_pairs else None
    sum_deduct_3y = sum(pair[1] for pair in np_pairs) if np_pairs else None
    np_only_vals = [r.net_profit_yuan for r in recent_3y if r.net_profit_yuan is not None]
    sum_np_only_3y = sum(np_only_vals) if np_only_vals else None

    subsidy_pts_3y = [
        pt.subsidy_and_oneoff_yuan
        for pt in annual_decomp[-3:]
        if pt.subsidy_and_oneoff_yuan is not None
    ]
    sum_subsidy_3y = sum(subsidy_pts_3y) if subsidy_pts_3y else None

    non_recurring_share_3y: float | None = None
    used_loss_fallback = False
    if not financial:
        if sum_np_3y is not None and sum_deduct_3y is not None and sum_np_3y > 1.0:
            if sum_deduct_3y <= 0:
                non_recurring_share_3y = 100.0
            else:
                csrc_share = ((sum_np_3y - sum_deduct_3y) / sum_np_3y) * 100.0
                share_candidates = [csrc_share]
                # Blend pre-tax subsidies only when CSRC deduct profit flags non-recurring items.
                if csrc_share >= 15.0 and sum_subsidy_3y is not None:
                    subsidy_denom = max(sum_np_3y, abs(sum_subsidy_3y))
                    share_candidates.append((sum_subsidy_3y / subsidy_denom) * 100.0)
                non_recurring_share_3y = min(100.0, _clamp_pct(max(share_candidates)))
        elif (
            sum_np_3y is None
            and sum_np_only_3y is not None
            and sum_np_only_3y > 1.0
            and sum_subsidy_3y is not None
        ):
            subsidy_denom = max(sum_np_only_3y, abs(sum_subsidy_3y))
            non_recurring_share_3y = min(
                100.0, _clamp_pct((sum_subsidy_3y / subsidy_denom) * 100.0)
            )
        elif sum_subsidy_3y is not None and (
            (sum_np_3y is not None and sum_np_3y <= 1.0)
            or (sum_np_only_3y is not None and sum_np_only_3y <= 1.0)
            or sum_op_3y is not None
        ):
            used_loss_fallback = True
            if sum_op_3y is not None:
                op_scale = max(abs(sum_op_3y), abs(sum_subsidy_3y), 1.0)
                non_recurring_share_3y = _clamp_pct((sum_subsidy_3y / op_scale) * 100.0)

    ocf_to_core_3y: float | None = None
    interest_burden_pct: float | None = None
    sum_ocf_3y: float | None = None
    sum_core_3y_for_cf: float | None = None
    sum_interest_3y = 0.0
    sum_core_int: float | None = None
    if not financial:
        core_ocf_pairs = [
            (pt.ocf_yuan, pt.core_operating_profit_yuan)
            for pt in annual_decomp[-3:]
            if pt.ocf_yuan is not None and pt.core_operating_profit_yuan is not None
        ]
        if core_ocf_pairs:
            sum_ocf_3y = sum(pair[0] for pair in core_ocf_pairs)
            sum_core_3y_for_cf = sum(pair[1] for pair in core_ocf_pairs)
            core_meaningful = (
                sum_core_3y_for_cf > 1e7
                and (core_share_3y is None or core_share_3y >= 15.0)
                and (sum_op_3y is None or sum_op_3y <= 0 or sum_core_3y_for_cf >= 0.10 * sum_op_3y)
            )
            if core_meaningful:
                ocf_to_core_3y = _clamp_pct(
                    (sum_ocf_3y / sum_core_3y_for_cf) * 100.0,
                    max_abs=_CLAMP_OCF_RATIO_MAX,
                )

        int_core_pairs = [
            (max(0.0, r.interest_expense_yuan), pt.core_operating_profit_yuan)
            for r, pt in zip(ordered[-3:], annual_decomp[-3:], strict=True)
            if r.interest_expense_yuan is not None and pt.core_operating_profit_yuan is not None
        ]
        if int_core_pairs:
            sum_interest_3y = sum(pair[0] for pair in int_core_pairs)
            sum_core_int = sum(pair[1] for pair in int_core_pairs)
            core_ebit_3y = sum_core_int + sum_interest_3y
            if core_ebit_3y > 1.0:
                interest_burden_pct = _clamp_pct((sum_interest_3y / core_ebit_3y) * 100.0)

    capital_allocation = _compute_capital_allocation(
        ordered,
        dividends=dividends,
        repurchases=repurchases,
        equity_financings=equity_financings,
        shareholder_return=shareholder_return,
        ending_investment_assets_yuan=investment_assets_yuan,
        financial=financial,
        as_of=as_of,
    )

    findings: list[ForensicFinding] = []
    if financial:
        return _assemble_financial_forensics(
            ordered=ordered,
            annual_decomp=annual_decomp,
            dupont_series=dupont_series,
            dupont_roe_avg=dupont_roe_avg,
            dupont_margin_avg=dupont_margin_avg,
            dupont_em_avg=dupont_em_avg,
            invest_share_3y=invest_share_3y,
            investment_assets_yuan=investment_assets_yuan,
            investment_assets_ratio_pct=investment_assets_ratio_pct,
            capital_allocation=capital_allocation,
        )

    latest_pt = annual_decomp[-1] if annual_decomp else None
    latest_core_op = latest_pt.core_operating_profit_yuan if latest_pt else None
    latest_np = latest_pt.net_profit_yuan if latest_pt else None
    latest_inv_fv = latest_pt.investment_and_fair_value_yuan if latest_pt else None

    core_loss_masked_by_invest = (
        latest_core_op is not None
        and latest_core_op <= 0
        and latest_np is not None
        and latest_np > 0
        and latest_inv_fv is not None
        and latest_inv_fv > 0
        and latest_inv_fv >= abs(latest_core_op) * 0.5
    )
    sum_core_loss_masked_by_invest = (
        sum_core_3y is not None
        and sum_core_3y < 0
        and sum_inv_3y is not None
        and sum_inv_3y > 0
        and (
            (sum_op_3y is not None and sum_op_3y > 0 and sum_inv_3y >= abs(sum_core_3y))
            or sum_inv_3y >= abs(sum_core_3y) * 0.5
        )
        and (invest_share_3y is not None and invest_share_3y >= 50.0)
    )

    if (
        (invest_share_3y is not None and invest_share_3y >= 50.0)
        or core_loss_masked_by_invest
        or sum_core_loss_masked_by_invest
    ):
        inv_status: SignalLight = "red"
        inv_headline = "盈利高度依赖对外投资"
        inv_parts = [f"近3年投资与公允价值变动收益占营业利润 {_fmt_pct(invest_share_3y)}"]
        if latest_core_op is not None:
            inv_parts.append(f"最新年报主业核心营业利润 {_fmt_yi(latest_core_op)}")
        if latest_inv_fv is not None:
            inv_parts.append(f"投资及公允价值收益 {_fmt_yi(latest_inv_fv)}")
        if investment_assets_yuan is not None:
            asset_note = (
                f"（占总资产 {investment_assets_ratio_pct:.1f}%）"
                if investment_assets_ratio_pct is not None
                else ""
            )
            inv_parts.append(
                f"表内金融与长期股权投资资产 {_fmt_yi(investment_assets_yuan)}{asset_note}"
            )
        inv_detail = "，".join(inv_parts) + "，需警惕投资波动掩盖主业真实盈利。"
    elif invest_share_3y is not None and invest_share_3y >= 20.0:
        inv_status = "yellow"
        inv_headline = (
            "投资收益占比较高，需区分股权分红协同与炒股周期波动"
            if invest_share_3y >= 25.0
            else "存在一定投资收益贡献，建议跟踪持续性"
        )
        inv_parts = [f"近3年投资与公允价值变动占营业利润 {_fmt_pct(invest_share_3y)}"]
        if core_share_3y is not None:
            inv_parts.append(f"主业核心利润占比 {_fmt_pct(core_share_3y)}")
        if investment_assets_ratio_pct is not None:
            inv_parts.append(f"表内投资类资产占总资产 {_fmt_pct(investment_assets_ratio_pct)}")
        inv_detail = "，".join(inv_parts) + "。"
    elif invest_share_3y is not None:
        if (latest_core_op is not None and latest_core_op <= 0) or (
            sum_op_3y is not None and sum_op_3y <= 0
        ):
            inv_status = "yellow"
            if sum_op_3y is not None and sum_op_3y <= 0 and invest_share_3y <= -20.0:
                inv_headline = "投资公允价值亏损拖累营业利润"
                inv_detail = (
                    f"近3年投资与公允价值净额拖累营业利润（占比 {_fmt_pct(invest_share_3y)}），"
                    f"三年营业利润合计 {_fmt_yi(sum_op_3y)}，需警惕证券或股权资产减值波动。"
                )
            else:
                inv_headline = "主业核心营业利润承压"
                inv_parts = [f"最新年报主业核心营业利润 {_fmt_yi(latest_core_op)}"]
                if invest_share_3y is not None:
                    inv_parts.append(f"投资收益占比 {_fmt_pct(invest_share_3y)}")
                inv_detail = "，".join(inv_parts) + "，仍需观察主业景气度修复。"
        else:
            inv_status = "green"
            inv_headline = "主业自身造血主导"
            inv_parts = [
                f"近3年主业核心营业利润占比达 {_fmt_pct(core_share_3y)}",
                f"投资与公允价值贡献仅 {_fmt_pct(invest_share_3y)}",
            ]
            if investment_assets_yuan is not None:
                asset_note = (
                    f"（占总资产 {investment_assets_ratio_pct:.1f}%）"
                    if investment_assets_ratio_pct is not None
                    else ""
                )
                inv_parts.append(f"表内投资类资产 {_fmt_yi(investment_assets_yuan)}{asset_note}")
            inv_detail = "，".join(inv_parts) + "。"
    else:
        inv_status = "na"
        inv_headline = "缺少利润表营业利润拆解明细"
        inv_detail = "暂未同步营业利润、投资收益或公允价值变动科目，无法剥离主业与投资收益。"
    findings.append(
        ForensicFinding(
            finding_id="investment_reliance",
            title="对外投资驱动诊断",
            status=inv_status,
            headline=inv_headline,
            detail=inv_detail,
            metric_text=f"投资收益占比 {_fmt_pct(invest_share_3y)}",
        )
    )

    if non_recurring_share_3y is not None:
        if non_recurring_share_3y >= 45.0:
            sub_status: SignalLight = "red"
            sub_headline = "非经常性损益与政府补贴依赖显著"
        elif non_recurring_share_3y >= 25.0:
            sub_status = "yellow"
            sub_headline = "非经常性损益占比偏高"
        elif used_loss_fallback and sum_subsidy_3y is not None and sum_subsidy_3y > 0:
            sub_status = "yellow"
            sub_headline = "盈利偏弱期存在政府补助或一次性收益"
        else:
            sub_status = "green"
            sub_headline = "扣非与归母利润高度贴合"

        np_display = sum_np_3y if sum_np_3y is not None else sum_np_only_3y
        if used_loss_fallback or (np_display is not None and np_display <= 1.0):
            loss_extra: list[str] = []
            if np_display is not None:
                loss_extra.append(f"归母净利润 {_fmt_yi(np_display)}")
            if sum_deduct_3y is not None:
                loss_extra.append(f"扣非净利润 {_fmt_yi(sum_deduct_3y)}")
            extra_txt = f"（{'，'.join(loss_extra)}）" if loss_extra else ""
            sub_detail = (
                f"近3年营业利润偏弱或亏损，非经常性损益与补贴净额合计 {_fmt_yi(sum_subsidy_3y)}"
                f"{extra_txt}。"
            )
            sub_metric = (
                f"补贴/一次性 {_fmt_yi(sum_subsidy_3y)}"
                if sum_subsidy_3y is not None
                else f"非经/补贴占比 {_fmt_pct(non_recurring_share_3y)}"
            )
        elif (
            sum_deduct_3y is not None
            and sum_deduct_3y <= 0
            and sum_np_3y is not None
            and sum_np_3y > 1.0
        ):
            sub_parts = [
                f"近3年扣非净利润 {_fmt_yi(sum_deduct_3y)} vs 归母净利润 {_fmt_yi(sum_np_3y)}",
            ]
            if sum_subsidy_3y is not None:
                sub_parts.append(f"其他收益与资产处置等营业外项目合计 {_fmt_yi(sum_subsidy_3y)}")
            sub_parts.append(
                "近3年扣非净利润合计亏损，全部账面归母利润均由非经常性损益/政府补助撑起"
            )
            sub_detail = "，".join(sub_parts) + "。"
            sub_metric = f"非经/补贴占比 {_fmt_pct(non_recurring_share_3y)}"
        else:
            sub_parts = []
            if sum_deduct_3y is not None and sum_np_3y is not None:
                sub_parts.append(
                    f"近3年扣非净利润 {_fmt_yi(sum_deduct_3y)} vs 归母净利润 {_fmt_yi(sum_np_3y)}"
                )
            elif np_display is not None:
                sub_parts.append(f"近3年归母净利润 {_fmt_yi(np_display)}")
            if sum_subsidy_3y is not None:
                sub_parts.append(f"其他收益与资产处置等营业外项目合计 {_fmt_yi(sum_subsidy_3y)}")
            sub_parts.append(f"非经常性/补贴影响占比约 {_fmt_pct(non_recurring_share_3y)}")
            sub_detail = "，".join(sub_parts) + "。"
            sub_metric = f"非经/补贴占比 {_fmt_pct(non_recurring_share_3y)}"
    elif sum_subsidy_3y is not None and sum_subsidy_3y > 0:
        sub_status = "yellow"
        sub_headline = "亏损期依赖补贴或一次性收益减亏"
        np_display = sum_np_3y if sum_np_3y is not None else sum_np_only_3y
        loss_extra = []
        if np_display is not None:
            loss_extra.append(f"归母净利润 {_fmt_yi(np_display)}")
        if sum_deduct_3y is not None:
            loss_extra.append(f"扣非净利润 {_fmt_yi(sum_deduct_3y)}")
        extra_txt = f"（{'，'.join(loss_extra)}）" if loss_extra else ""
        sub_detail = (
            f"近3年营业利润偏弱或亏损，非经常性损益与补贴净额合计 {_fmt_yi(sum_subsidy_3y)}"
            f"{extra_txt}。"
        )
        sub_metric = f"补贴/一次性 {_fmt_yi(sum_subsidy_3y)}"
    else:
        sub_status = "na"
        sub_headline = "缺少扣非与非经常性损益对比数据"
        sub_detail = "暂缺近3年扣非净利润或政府补助/资产处置明细。"
        sub_metric = "数据不足"
    findings.append(
        ForensicFinding(
            finding_id="non_recurring_subsidy",
            title="非经常性损益与补贴扫描",
            status=sub_status,
            headline=sub_headline,
            detail=sub_detail,
            metric_text=sub_metric,
        )
    )

    is_leveraged_roe = (
        dupont_roe_avg is not None
        and dupont_roe_avg > 0
        and dupont_em_avg is not None
        and dupont_em_avg >= 2.8
        and dupont_margin_avg is not None
        and 0.0 <= dupont_margin_avg < 8.0
    )
    if dupont_roe_avg is not None:
        turnover_fragment = (
            f"、总资产周转率 {dupont_turnover_avg:.2f} 次"
            if dupont_turnover_avg is not None
            else ""
        )
        if is_leveraged_roe:
            dp_status: SignalLight = "yellow"
            dp_headline = "高杠杆低净利率驱动型 ROE"
            dp_detail = (
                f"5年平均 ROE {_fmt_pct(dupont_roe_avg)} 主要依赖 "
                f"{dupont_em_avg:.2f} 倍权益乘数放大，"
                f"销售净利率仅 {_fmt_pct(dupont_margin_avg)}{turnover_fragment}，"
                "需防范融资成本与周期下行冲击。"
            )
        elif (
            dupont_roe_avg >= 15.0
            and dupont_em_avg is not None
            and dupont_em_avg < 2.2
            and dupont_margin_avg is not None
            and dupont_margin_avg >= 12.0
        ):
            dp_status = "green"
            dp_headline = "高净利率驱动型真护城河"
            turnover_paren = (
                f"（周转率 {dupont_turnover_avg:.2f} 次）"
                if dupont_turnover_avg is not None
                else ""
            )
            dp_detail = (
                f"5年平均 ROE 达 {_fmt_pct(dupont_roe_avg)}，"
                f"销售净利率 {_fmt_pct(dupont_margin_avg)}、"
                f"权益乘数仅 {dupont_em_avg:.2f} 倍{turnover_paren}，"
                "高盈利质量并非依赖财务杠杆堆砌。"
            )
        else:
            dp_status = (
                "green"
                if dupont_roe_avg >= 12.0 and (dupont_em_avg is None or dupont_em_avg < 2.8)
                else "yellow"
            )
            dp_headline = (
                "杜邦三因子结构均衡"
                if dp_status == "green"
                else ("盈利承压或亏损" if dupont_roe_avg <= 0 else "盈利回报或资本周转偏温和")
            )
            factor_parts: list[str] = []
            if dupont_margin_avg is not None:
                factor_parts.append(f"净利率均值 {_fmt_pct(dupont_margin_avg)}")
            if dupont_turnover_avg is not None:
                factor_parts.append(f"资产周转率均值 {dupont_turnover_avg:.2f} 次")
            if dupont_em_avg is not None:
                factor_parts.append(f"权益乘数均值 {dupont_em_avg:.2f} 倍")
            factors_txt = f"（{'、'.join(factor_parts)}）" if factor_parts else ""
            dp_detail = f"近5年 ROE 均值 {_fmt_pct(dupont_roe_avg)}{factors_txt}。"
        dp_metric = (
            f"ROE {_fmt_pct(dupont_roe_avg)} / 乘数 {dupont_em_avg:.2f}x"
            if dupont_em_avg is not None
            else f"ROE {_fmt_pct(dupont_roe_avg)}"
        )
    else:
        dp_status = "na"
        dp_headline = "缺少杜邦三因子连续年度数据"
        dp_detail = "暂缺完整的净利润、营收、总资产与股东权益历史序列。"
        dp_metric = "数据不足"
    findings.append(
        ForensicFinding(
            finding_id="dupont_attribution",
            title="杜邦三因子归因",
            status=dp_status,
            headline=dp_headline,
            detail=dp_detail,
            metric_text=dp_metric,
        )
    )

    core_int_anchor = sum_core_int if sum_core_int is not None else sum_core_3y_for_cf
    heavy_interest_unsustainable = (
        sum_interest_3y > 0 and core_int_anchor is not None and core_int_anchor <= 0
    )
    core_loss_cash_outflow = (
        sum_core_3y_for_cf is not None
        and sum_core_3y_for_cf <= 1.0
        and sum_ocf_3y is not None
        and sum_ocf_3y < 0
    )
    core_weak_cash_outflow = (
        ocf_to_core_3y is None
        and sum_core_3y_for_cf is not None
        and sum_core_3y_for_cf > 1.0
        and sum_ocf_3y is not None
        and sum_ocf_3y < 0
    )
    core_weak_nonneg_ocf = (
        ocf_to_core_3y is None
        and sum_core_3y_for_cf is not None
        and sum_ocf_3y is not None
        and sum_ocf_3y >= 0
    )
    # OCF is after corporate income/excise tax while core_operating_profit is pre-tax.
    if (
        (interest_burden_pct is not None and interest_burden_pct >= 50.0)
        or heavy_interest_unsustainable
        or core_loss_cash_outflow
        or core_weak_cash_outflow
        or (ocf_to_core_3y is not None and ocf_to_core_3y < 35.0)
    ):
        cf_status: SignalLight = "red"
    elif (
        (interest_burden_pct is not None and interest_burden_pct >= 25.0)
        or core_weak_nonneg_ocf
        or (ocf_to_core_3y is not None and ocf_to_core_3y < 60.0)
    ):
        cf_status = "yellow"
    elif ocf_to_core_3y is not None:
        cf_status = "green"
    else:
        cf_status = "na"

    if cf_status == "na":
        cf_headline = "缺少主业核心利润现金转化数据"
        cf_detail = "暂未获取营业利润拆解与经营现金流近3年配对序列。"
        cf_metric = "数据不足"
    else:
        issues: list[str] = []
        if heavy_interest_unsustainable:
            issues.append(
                f"主业核心利润无法覆盖利息支出（利息占息税前核心利润 "
                f"{_fmt_pct(interest_burden_pct)}）"
                if interest_burden_pct is not None
                else "主业核心利润无法覆盖利息支出"
            )
        elif interest_burden_pct is not None and interest_burden_pct >= 25.0:
            issues.append(f"利息负担占息税前核心利润 {_fmt_pct(interest_burden_pct)}")
        if core_loss_cash_outflow:
            issues.append("主业经营亏损且现金流净流出")
        elif core_weak_cash_outflow:
            issues.append("主业核心利润微薄且现金流净流出")
        elif core_weak_nonneg_ocf:
            issues.append("主业核心利润微薄或亏损，现金转化比率不适用")
        elif ocf_to_core_3y is not None and ocf_to_core_3y < 60.0:
            issues.append(f"近3年 OCF/主业核心利润仅 {_fmt_pct(ocf_to_core_3y)}")
        cf_headline = "、".join(issues) if issues else "主业核心利润现金转化扎实"

        cf_detail_parts: list[str] = []
        if ocf_to_core_3y is not None:
            cf_detail_parts.append(f"近3年经营现金流占主业核心利润 {_fmt_pct(ocf_to_core_3y)}")
        elif sum_core_3y_for_cf is not None and sum_ocf_3y is not None:
            cf_detail_parts.append(
                f"近3年主业核心营业利润累计 {_fmt_yi(sum_core_3y_for_cf)}，"
                f"经营现金流累计 {_fmt_yi(sum_ocf_3y)}"
            )
        elif sum_core_int is not None:
            cf_detail_parts.append(f"近3年主业核心营业利润累计 {_fmt_yi(sum_core_int)}")
        if interest_burden_pct is not None:
            cf_detail_parts.append(f"利息费用占息税前核心利润 {_fmt_pct(interest_burden_pct)}")
        elif sum_interest_3y > 0:
            cf_detail_parts.append(f"近3年利息支出合计 {_fmt_yi(sum_interest_3y)}")
        cf_detail = "，".join(cf_detail_parts) + "。"

        if ocf_to_core_3y is not None:
            cf_metric = f"OCF/核心利润 {_fmt_pct(ocf_to_core_3y)}"
        elif sum_ocf_3y is not None:
            cf_metric = f"3年 OCF {_fmt_yi(sum_ocf_3y)}"
        elif interest_burden_pct is not None:
            cf_metric = f"利息负担 {_fmt_pct(interest_burden_pct)}"
        else:
            cf_metric = f"3年利息 {_fmt_yi(sum_interest_3y)}"
    findings.append(
        ForensicFinding(
            finding_id="cashflow_core_conversion",
            title="现金流与主业转化验证",
            status=cf_status,
            headline=cf_headline,
            detail=cf_detail,
            metric_text=cf_metric,
        )
    )

    if capital_allocation is not None:
        if capital_allocation.total_ocf_yuan is None:
            ca_status: SignalLight = "na"
        elif capital_allocation.total_ocf_yuan <= 0:
            ca_status = "red"
        elif capital_allocation.allocation_style in {
            "轻资产现金牛·高分红回报型",
            "稳健平衡·内生留存与回馈兼顾",
            "内生现金再投资扩张型",
        }:
            ca_status = "green"
        else:
            ca_status = "yellow"
        findings.append(
            ForensicFinding(
                finding_id="capital_allocation",
                title="五年资本配置归因",
                status=ca_status,
                headline=capital_allocation.allocation_style,
                detail=capital_allocation.summary,
                metric_text=capital_allocation.allocation_style,
            )
        )

    finding_by_id = {item.finding_id: item for item in findings}
    if (
        (invest_share_3y is not None and invest_share_3y >= 50.0)
        or core_loss_masked_by_invest
        or sum_core_loss_masked_by_invest
    ):
        tag: EarningsQualityTag = "investment_driven"
        label = "盈利高度依赖对外投资"
        verdict = inv_detail
    elif non_recurring_share_3y is not None and non_recurring_share_3y >= 45.0:
        tag = "subsidy_inflated"
        label = "非经常性损益或补贴占比偏高"
        verdict = finding_by_id["non_recurring_subsidy"].detail
    elif (
        (ocf_to_core_3y is not None and ocf_to_core_3y < 60.0)
        or (interest_burden_pct is not None and interest_burden_pct >= 50.0)
        or heavy_interest_unsustainable
        or core_loss_cash_outflow
        or core_weak_cash_outflow
    ):
        tag = "cashflow_divergent"
        label = "现金转化偏弱或利息负担偏重"
        verdict = cf_detail
    elif is_leveraged_roe:
        tag = "leveraged_roe"
        label = "高杠杆驱动型 ROE"
        verdict = finding_by_id["dupont_attribution"].detail
    elif (
        core_share_3y is not None
        and core_share_3y >= 75.0
        and sum_op_3y is not None
        and sum_op_3y > 0
        and sum_core_3y is not None
        and sum_core_3y > 0
        and (invest_share_3y is None or invest_share_3y < 20.0)
        and (non_recurring_share_3y is None or non_recurring_share_3y < 25.0)
        and ocf_to_core_3y is not None
        and ocf_to_core_3y >= 65.0
        and (interest_burden_pct is None or interest_burden_pct < 25.0)
        and (latest_core_op is None or latest_core_op > 0)
    ):
        tag = "core_cash_cow"
        label = "主业造血现金牛"
        verdict = (
            f"近3年主业核心营业利润占比 {_fmt_pct(core_share_3y)}、"
            f"OCF 对核心利润转化率 {_fmt_pct(ocf_to_core_3y)}，盈利纯度与现金流质量俱佳。"
        )
    else:
        tag = "balanced_steady"
        label = "盈利结构稳健均衡"
        verdict_parts: list[str] = []
        if core_share_3y is not None:
            verdict_parts.append(f"近3年主业核心利润占比 {_fmt_pct(core_share_3y)}")
        if invest_share_3y is not None:
            verdict_parts.append(f"投资收益占比 {_fmt_pct(invest_share_3y)}")
        if dupont_roe_avg is not None:
            verdict_parts.append(f"5年平均 ROE {_fmt_pct(dupont_roe_avg)}")
        verdict = "，".join(verdict_parts) + "。" if verdict_parts else "主业拆解数据待补充。"

    return StockForensicsSection(
        earnings_quality_tag=tag,
        earnings_quality_label=label,
        verdict=verdict,
        core_profit_share_3y_pct=core_share_3y,
        invest_profit_share_3y_pct=invest_share_3y,
        non_recurring_share_3y_pct=non_recurring_share_3y,
        ocf_to_core_profit_3y_pct=ocf_to_core_3y,
        interest_burden_pct=interest_burden_pct,
        investment_assets_yuan=investment_assets_yuan,
        investment_assets_ratio_pct=investment_assets_ratio_pct,
        dupont_roe_5y_avg_pct=dupont_roe_avg,
        dupont_net_margin_5y_avg_pct=dupont_margin_avg,
        dupont_asset_turnover_5y_avg=dupont_turnover_avg,
        dupont_equity_multiplier_5y_avg=dupont_em_avg,
        findings=findings,
        annual_decomposition=annual_decomp,
        dupont_series=dupont_series,
        capital_allocation=capital_allocation,
    )


def _assemble_financial_forensics(
    *,
    ordered: Sequence[StockAnnualReport],
    annual_decomp: list[AnnualEarningsDecompositionPoint],
    dupont_series: list[DupontYearPoint],
    dupont_roe_avg: float | None,
    dupont_margin_avg: float | None,
    dupont_em_avg: float | None,
    invest_share_3y: float | None,
    investment_assets_yuan: float | None,
    investment_assets_ratio_pct: float | None,
    capital_allocation: CapitalAllocationSummary | None,
) -> StockForensicsSection:
    recent_profits = [r.net_profit_yuan for r in ordered[-5:] if r.net_profit_yuan is not None]
    all_positive = bool(recent_profits) and all(p > 0 for p in recent_profits)
    roe_vals = [p.roe_pct for p in dupont_series if p.roe_pct is not None]
    min_roe = min(roe_vals) if roe_vals else None

    roe_summary_parts = [f"近5年平均 ROE {_fmt_pct(dupont_roe_avg)}"]
    if min_roe is not None:
        roe_summary_parts[0] += f"（最低 {min_roe:.1f}%）"
    if invest_share_3y is not None:
        roe_summary_parts.append(
            f"金融业投资收益及公允价值变动（近3年占营业利润 {invest_share_3y:.1f}%）"
            "属债券配置与自营/险资正常主营收益结构"
        )
    else:
        roe_summary_parts.append("金融业投资收益及公允价值变动属正常主营配置结构")

    dupont_fin_parts: list[str] = []
    if dupont_margin_avg is not None:
        dupont_fin_parts.append(f"5年平均净利率 {_fmt_pct(dupont_margin_avg)}")
    if dupont_em_avg is not None:
        dupont_fin_parts.append(f"平均权益乘数 {dupont_em_avg:.2f} 倍")
    dupont_fin_prefix = "，".join(dupont_fin_parts) + "；" if dupont_fin_parts else ""

    findings = [
        ForensicFinding(
            finding_id="financial_profit_stability",
            title="金融盈利与 ROE 稳健性",
            status="green" if all_positive and (dupont_roe_avg or 0.0) >= 8.0 else "yellow",
            headline="金融业态适用 ROE 与资本耐力评估",
            detail="，".join(roe_summary_parts) + "。",
            metric_text=f"5年均值 ROE {_fmt_pct(dupont_roe_avg)}",
        ),
        ForensicFinding(
            finding_id="dupont_attribution",
            title="金融杠杆与净利率结构",
            status="na" if dupont_em_avg is None else "green",
            headline="已豁免工业总资产周转率指标",
            detail=(
                f"{dupont_fin_prefix}"
                "金融资产负债表以存贷款及保险准备金为主，不适用传统制造业总资产周转率对比。"
            ),
            metric_text=(
                f"权益乘数 {dupont_em_avg:.2f}x" if dupont_em_avg is not None else "数据不足"
            ),
        ),
    ]
    if capital_allocation is not None:
        total_payout = (
            capital_allocation.total_dividends_yuan + capital_allocation.total_repurchases_yuan
        )
        findings.append(
            ForensicFinding(
                finding_id="capital_allocation",
                title="五年资本与分红配置",
                status=(
                    "green"
                    if total_payout >= capital_allocation.total_equity_financing_yuan
                    else "yellow"
                ),
                headline=capital_allocation.allocation_style,
                detail=capital_allocation.summary,
                metric_text=capital_allocation.allocation_style,
            )
        )

    verdict_roe = (
        f"近5年平均 ROE {_fmt_pct(dupont_roe_avg)}，" if dupont_roe_avg is not None else ""
    )
    verdict = (
        f"金融行业特殊结构：{verdict_roe}"
        "已豁免工业主业剥离与资产周转率惩罚，重点跟踪净息差/赔付率与分红连续性。"
    )
    return StockForensicsSection(
        earnings_quality_tag="financial_special",
        earnings_quality_label="金融特殊结构",
        verdict=verdict,
        core_profit_share_3y_pct=None,
        invest_profit_share_3y_pct=invest_share_3y,
        non_recurring_share_3y_pct=None,
        ocf_to_core_profit_3y_pct=None,
        interest_burden_pct=None,
        investment_assets_yuan=investment_assets_yuan,
        investment_assets_ratio_pct=investment_assets_ratio_pct,
        dupont_roe_5y_avg_pct=dupont_roe_avg,
        dupont_net_margin_5y_avg_pct=dupont_margin_avg,
        dupont_asset_turnover_5y_avg=None,
        dupont_equity_multiplier_5y_avg=dupont_em_avg,
        findings=findings,
        annual_decomposition=annual_decomp,
        dupont_series=dupont_series,
        capital_allocation=capital_allocation,
    )
