"""Deterministic 7-rule A-share financial red-flag CT scanner."""

from __future__ import annotations

import math
from collections.abc import Sequence

from app.domain.engines._helpers import (
    finite_or_none,
    is_financial_institution,
    report_interest_debt_yuan,
    safe_pct,
    sort_reports_asc,
)
from app.domain.models import (
    CtCheckItem,
    CtRuleEvidence,
    FinancialCtSection,
    SignalLight,
    StockAnnualReport,
    StockMetaRecord,
    StockPledgeSnapshot,
)

_CLEAN_AUDIT_OPINIONS = frozenset({"标准无保留意见", "无保留意见"})
_EVIDENCE_YEARS = 5


def _fmt_pct(value: float | None) -> str:
    return f"{value:.1f}%" if value is not None else "—"


def _fmt_yi(value: float | None) -> str:
    return f"{value / 1e8:.2f}亿元" if value is not None else "—"


def _check_dual_high_cash_debt(
    reports: Sequence[StockAnnualReport],
    meta: StockMetaRecord | None,
) -> CtCheckItem:
    threshold = "货币资金/总资产 ≥ 25% 且有息负债/总资产 ≥ 20%（红灯）；双 ≥ 15%（黄灯）"
    if is_financial_institution(meta):
        return CtCheckItem(
            rule_id="dual_high_cash_debt",
            title="存贷双高扫描",
            status="na",
            summary="金融行业结构特殊 — 不适用常规存贷双高指标（吸储与同业负债属主营金融负债）。",
            threshold=threshold,
            value_text="不适用",
            evidences=[],
        )

    evidences: list[CtRuleEvidence] = []
    recent = list(reports[-_EVIDENCE_YEARS:])
    latest_cash_pct: float | None = None
    latest_debt_pct: float | None = None
    for idx, report in enumerate(recent):
        cash = report.monetary_funds_yuan
        debt = report_interest_debt_yuan(report)
        cash_pct = safe_pct(cash, report.total_assets_yuan)
        debt_pct = safe_pct(debt, report.total_assets_yuan)
        if idx == len(recent) - 1:
            latest_cash_pct = cash_pct
            latest_debt_pct = debt_pct
        evidences.append(
            CtRuleEvidence(
                year=report.report_year,
                label=f"{report.report_year}年报",
                metrics={
                    "monetary_funds_yuan": finite_or_none(cash, 2),
                    "interest_debt_yuan": finite_or_none(debt, 2),
                    "cash_to_assets_pct": cash_pct,
                    "debt_to_assets_pct": debt_pct,
                },
            )
        )

    if latest_cash_pct is None or latest_debt_pct is None:
        return CtCheckItem(
            rule_id="dual_high_cash_debt",
            title="存贷双高扫描",
            status="na",
            summary="缺少货币资金或总资产数据，暂无法评估存贷双高风险。",
            threshold=threshold,
            value_text="数据不足",
            evidences=evidences,
        )

    value_text = f"现金 {latest_cash_pct:.1f}% / 有息负债 {latest_debt_pct:.1f}%"
    if latest_cash_pct >= 25.0 and latest_debt_pct >= 20.0:
        status: SignalLight = "red"
        summary = (
            f"最新年报货币资金占总资产 {latest_cash_pct:.1f}%，同时有息负债占总资产 "
            f"{latest_debt_pct:.1f}%，存在典型存贷双高嫌疑，需核查资金受限或虚增可能。"
        )
    elif latest_cash_pct >= 15.0 and latest_debt_pct >= 15.0:
        status = "yellow"
        summary = (
            f"货币资金占比 {latest_cash_pct:.1f}% 且有息负债占比 {latest_debt_pct:.1f}%，"
            "现金与债务同步偏高，建议核对利息收入与受限资金附注。"
        )
    else:
        status = "green"
        summary = (
            f"货币资金占总资产 {latest_cash_pct:.1f}%、有息负债占比 {latest_debt_pct:.1f}%，"
            "未见显著存贷双高异常。"
        )

    return CtCheckItem(
        rule_id="dual_high_cash_debt",
        title="存贷双高扫描",
        status=status,
        summary=summary,
        threshold=threshold,
        value_text=value_text,
        evidences=evidences,
    )


def _check_stalled_cip(reports: Sequence[StockAnnualReport]) -> CtCheckItem:
    threshold = (
        "在建工程/总资产 ≥ 15% 且（持续≥10%或占固定资产≥50%）（红灯）；"
        "≥ 8% 或占固定资产≥30%（黄灯）"
    )
    evidences: list[CtRuleEvidence] = []
    recent = list(reports[-_EVIDENCE_YEARS:])
    latest_cip: float | None = None
    latest_fixed: float | None = None
    latest_cip_assets_pct: float | None = None
    latest_cip_fixed_pct: float | None = None
    high_cip_streak = 0

    for idx, report in enumerate(recent):
        cip = report.cip_yuan
        if cip is None and report.fixed_asset_yuan is not None:
            cip = 0.0
        cip_assets_pct = safe_pct(cip, report.total_assets_yuan)
        cip_fixed_pct = safe_pct(cip, report.fixed_asset_yuan)
        if cip_assets_pct is not None:
            high_cip_streak = high_cip_streak + 1 if cip_assets_pct >= 10.0 else 0
        else:
            high_cip_streak = 0
        if idx == len(recent) - 1:
            latest_cip = cip
            latest_fixed = report.fixed_asset_yuan
            latest_cip_assets_pct = cip_assets_pct
            latest_cip_fixed_pct = cip_fixed_pct
        evidences.append(
            CtRuleEvidence(
                year=report.report_year,
                label=f"{report.report_year}年报",
                metrics={
                    "cip_yuan": finite_or_none(cip, 2),
                    "fixed_asset_yuan": finite_or_none(report.fixed_asset_yuan, 2),
                    "cip_to_assets_pct": cip_assets_pct,
                    "cip_to_fixed_pct": cip_fixed_pct,
                },
            )
        )

    if latest_cip_assets_pct is None:
        return CtCheckItem(
            rule_id="stalled_cip",
            title="在建工程不转固",
            status="na",
            summary="缺少在建工程或固定资产科目数据。",
            threshold=threshold,
            value_text="数据不足",
            evidences=evidences,
        )

    value_text = (
        f"占总资产 {_fmt_pct(latest_cip_assets_pct)} / 占固定资产 {_fmt_pct(latest_cip_fixed_pct)}"
    )
    zero_fixed_stalled = latest_cip is not None and latest_cip > 0 and latest_fixed == 0
    if latest_cip_assets_pct >= 15.0 and (
        high_cip_streak >= 3
        or zero_fixed_stalled
        or (latest_cip_fixed_pct is not None and latest_cip_fixed_pct >= 50.0)
    ):
        status: SignalLight = "red"
        summary = (
            f"在建工程占总资产达 {latest_cip_assets_pct:.1f}%（占固定资产 "
            f"{_fmt_pct(latest_cip_fixed_pct)}），长期高位沉淀存在延迟转固少计折旧风险。"
        )
    elif latest_cip_assets_pct >= 8.0 or (
        latest_cip_fixed_pct is not None and latest_cip_fixed_pct >= 30.0
    ):
        status = "yellow"
        summary = (
            f"在建工程占总资产 {latest_cip_assets_pct:.1f}%（占固定资产 "
            f"{_fmt_pct(latest_cip_fixed_pct)}），需关注后续投产转固节奏。"
        )
    else:
        status = "green"
        summary = f"在建工程占总资产 {latest_cip_assets_pct:.1f}%，处于正常扩产周转水平。"

    return CtCheckItem(
        rule_id="stalled_cip",
        title="在建工程不转固",
        status=status,
        summary=summary,
        threshold=threshold,
        value_text=value_text,
        evidences=evidences,
    )


def _check_ocf_profit_divergence(
    reports: Sequence[StockAnnualReport],
    meta: StockMetaRecord | None = None,
) -> CtCheckItem:
    threshold = "近3年累计经营现金流/归母净利润 < 0.5（红灯）；< 0.8（黄灯）"
    if is_financial_institution(meta):
        return CtCheckItem(
            rule_id="ocf_profit_divergence",
            title="现金流与利润背离",
            status="na",
            summary=(
                "金融行业结构特殊 — 不适用传统净现比指标（存贷款及同业资金变动计入经营现金流）。"
            ),
            threshold=threshold,
            value_text="不适用",
            evidences=[],
        )
    evidences: list[CtRuleEvidence] = []
    paired: list[tuple[int, float, float]] = []

    for report in reports[-_EVIDENCE_YEARS:]:
        ocf = report.ocf_yuan
        profit = report.net_profit_yuan
        ratio: float | None = None
        if ocf is not None and profit is not None:
            paired.append((report.report_year, ocf, profit))
            if profit > 0:
                ratio = finite_or_none(ocf / profit, 2)
        evidences.append(
            CtRuleEvidence(
                year=report.report_year,
                label=f"{report.report_year}年报",
                metrics={
                    "ocf_yuan": finite_or_none(ocf, 2),
                    "net_profit_yuan": finite_or_none(profit, 2),
                    "ocf_to_profit": ratio,
                },
            )
        )

    if not paired:
        return CtCheckItem(
            rule_id="ocf_profit_divergence",
            title="现金流与利润背离",
            status="na",
            summary="缺少经营现金流或净利润数据。",
            threshold=threshold,
            value_text="数据不足",
            evidences=evidences,
        )

    window = paired[-3:]
    sum_ocf = sum(row[1] for row in window)
    sum_profit = sum(row[2] for row in window)
    latest_ocf, latest_profit = window[-1][1], window[-1][2]
    latest_ratio = (latest_ocf / latest_profit) if latest_profit > 0 else None

    if sum_profit > 0:
        ratio_3y = round(sum_ocf / sum_profit, 2)
        value_text = f"近{len(window)}年净现比 {ratio_3y:.2f}"
        if ratio_3y < 0.5:
            status: SignalLight = "red"
            summary = (
                f"近 {len(window)} 年累计经营现金流 {_fmt_yi(sum_ocf)}，"
                f"仅占归母净利润 {_fmt_yi(sum_profit)} 的 {ratio_3y:.2f} 倍，盈利含金量偏低。"
            )
        elif ratio_3y < 0.8 or (latest_ratio is not None and latest_ratio < 0.6):
            status = "yellow"
            summary = (
                f"近 {len(window)} 年累计净现比 {ratio_3y:.2f}，"
                "阶段性回款或备货占用现金，需持续跟踪。"
            )
        else:
            status = "green"
            summary = f"近 {len(window)} 年累计净现比 {ratio_3y:.2f}，经营现金流对利润覆盖良好。"
    else:
        value_text = f"近{len(window)}年累计净利 {_fmt_yi(sum_profit)}"
        if sum_ocf < 0:
            status = "red"
            summary = (
                f"近 {len(window)} 年累计净利润 {_fmt_yi(sum_profit)} "
                f"且经营现金流 {_fmt_yi(sum_ocf)}，主业造血能力承压。"
            )
        else:
            status = "yellow"
            summary = (
                f"近 {len(window)} 年累计净利润 {_fmt_yi(sum_profit)}，"
                f"但经营现金流尚为正值 {_fmt_yi(sum_ocf)}。"
            )

    return CtCheckItem(
        rule_id="ocf_profit_divergence",
        title="现金流与利润背离",
        status=status,
        summary=summary,
        threshold=threshold,
        value_text=value_text,
        evidences=evidences,
    )


def _check_receivable_inventory_bloat(
    reports: Sequence[StockAnnualReport],
    meta: StockMetaRecord | None,
) -> CtCheckItem:
    threshold = (
        "(应收+存货)/营收 ≥ 80% 且占总资产 ≥ 35%，或增速显著背离（红灯）；占营收 ≥ 50%（黄灯）"
    )
    if is_financial_institution(meta):
        return CtCheckItem(
            rule_id="receivable_inventory_bloat",
            title="应收与存货膨胀",
            status="na",
            summary="金融行业结构特殊 — 不适用传统应收账款与存货周转指标。",
            threshold=threshold,
            value_text="不适用",
            evidences=[],
        )

    evidences: list[CtRuleEvidence] = []
    recent = list(reports[-_EVIDENCE_YEARS:])
    prev_rev: float | None = None
    prev_tied: float | None = None
    latest_tied_rev_pct: float | None = None
    latest_tied_assets_pct: float | None = None
    latest_growth_gap: float | None = None

    for idx, report in enumerate(recent):
        receivable = (
            report.note_accounts_rece_yuan
            if report.note_accounts_rece_yuan is not None
            else (report.accounts_receivable_yuan or 0.0)
        )
        inventory = report.inventory_yuan or 0.0
        tied = receivable + inventory
        tied_rev_pct = safe_pct(tied, report.revenue_yuan)
        tied_assets_pct = safe_pct(tied, report.total_assets_yuan)

        growth_gap: float | None = None
        if (
            prev_rev is not None
            and prev_tied is not None
            and prev_rev > 0
            and prev_tied > 0
            and report.revenue_yuan is not None
            and math.isfinite(report.revenue_yuan)
        ):
            rev_yoy = (report.revenue_yuan - prev_rev) / prev_rev * 100.0
            tied_yoy = (tied - prev_tied) / prev_tied * 100.0
            growth_gap = round(tied_yoy - rev_yoy, 1)

        if report.revenue_yuan is not None and math.isfinite(report.revenue_yuan):
            prev_rev = report.revenue_yuan
            prev_tied = tied
        if idx == len(recent) - 1:
            latest_tied_rev_pct = tied_rev_pct
            latest_tied_assets_pct = tied_assets_pct
            latest_growth_gap = growth_gap

        evidences.append(
            CtRuleEvidence(
                year=report.report_year,
                label=f"{report.report_year}年报",
                metrics={
                    "receivable_yuan": finite_or_none(receivable, 2),
                    "inventory_yuan": finite_or_none(inventory, 2),
                    "tied_to_revenue_pct": tied_rev_pct,
                    "tied_to_assets_pct": tied_assets_pct,
                    "growth_gap_pct": growth_gap,
                },
            )
        )

    if latest_tied_rev_pct is None or latest_tied_assets_pct is None:
        return CtCheckItem(
            rule_id="receivable_inventory_bloat",
            title="应收与存货膨胀",
            status="na",
            summary="缺少营业收入或总资产数据。",
            threshold=threshold,
            value_text="数据不足",
            evidences=evidences,
        )

    value_text = f"占营收 {latest_tied_rev_pct:.1f}% / 占资产 {latest_tied_assets_pct:.1f}%"
    if (latest_tied_rev_pct >= 80.0 and latest_tied_assets_pct >= 35.0) or (
        latest_growth_gap is not None and latest_growth_gap >= 30.0 and latest_tied_rev_pct >= 45.0
    ):
        status: SignalLight = "red"
        summary = (
            f"应收与存货合计占营收 {latest_tied_rev_pct:.1f}%（占总资产 "
            f"{latest_tied_assets_pct:.1f}%），营运资金占款过重或增速明显快于营收，"
            "存在坏账与跌价风险。"
        )
    elif (
        latest_tied_rev_pct >= 50.0
        or latest_tied_assets_pct >= 30.0
        or (
            latest_growth_gap is not None
            and latest_growth_gap >= 15.0
            and latest_tied_rev_pct >= 30.0
        )
    ):
        status = "yellow"
        summary = (
            f"应收与存货合计占营收 {latest_tied_rev_pct:.1f}%（占总资产 "
            f"{latest_tied_assets_pct:.1f}%），需关注下游回款账期与存货去化。"
        )
    else:
        status = "green"
        summary = (
            f"应收与存货合计占营收 {latest_tied_rev_pct:.1f}%，"
            f"占总资产 {latest_tied_assets_pct:.1f}%，周转占款可控。"
        )

    return CtCheckItem(
        rule_id="receivable_inventory_bloat",
        title="应收与存货膨胀",
        status=status,
        summary=summary,
        threshold=threshold,
        value_text=value_text,
        evidences=evidences,
    )


def _check_goodwill_overhang(reports: Sequence[StockAnnualReport]) -> CtCheckItem:
    threshold = "商誉/归母净资产 ≥ 30% 或商誉/总资产 ≥ 20%（红灯）；≥ 15% 或 ≥ 10%（黄灯）"
    evidences: list[CtRuleEvidence] = []
    recent = list(reports[-_EVIDENCE_YEARS:])
    latest_gw: float | None = None
    latest_equity: float | None = None
    latest_gw_eq_pct: float | None = None
    latest_gw_assets_pct: float | None = None

    for idx, report in enumerate(recent):
        equity = (
            report.parent_equity_yuan
            if report.parent_equity_yuan is not None
            else report.total_equity_yuan
        )
        has_bs = equity is not None or report.total_assets_yuan is not None
        gw = report.goodwill_yuan if report.goodwill_yuan is not None else (0.0 if has_bs else None)
        gw_eq_pct = safe_pct(gw, equity) if gw is not None else None
        gw_assets_pct = safe_pct(gw, report.total_assets_yuan) if gw is not None else None
        if idx == len(recent) - 1:
            latest_gw = gw
            latest_equity = equity
            latest_gw_eq_pct = gw_eq_pct
            latest_gw_assets_pct = gw_assets_pct
        evidences.append(
            CtRuleEvidence(
                year=report.report_year,
                label=f"{report.report_year}年报",
                metrics={
                    "goodwill_yuan": finite_or_none(gw, 2),
                    "parent_equity_yuan": finite_or_none(equity, 2),
                    "goodwill_to_equity_pct": gw_eq_pct,
                    "goodwill_to_assets_pct": gw_assets_pct,
                },
            )
        )

    if latest_gw is None:
        return CtCheckItem(
            rule_id="goodwill_overhang",
            title="商誉减值悬顶",
            status="na",
            summary="缺少商誉或净资产数据。",
            threshold=threshold,
            value_text="数据不足",
            evidences=evidences,
        )

    if latest_gw == 0.0:
        return CtCheckItem(
            rule_id="goodwill_overhang",
            title="商誉减值悬顶",
            status="green",
            summary="最新年报商誉为 0，无并购商誉减值包袱。",
            threshold=threshold,
            value_text="商誉 0.00亿元",
            evidences=evidences,
        )

    if latest_equity is not None and latest_equity <= 0 and latest_gw > 0:
        return CtCheckItem(
            rule_id="goodwill_overhang",
            title="商誉减值悬顶",
            status="red",
            summary="归母净资产为负且账面仍存在商誉，减值清零风险极高。",
            threshold=threshold,
            value_text=f"商誉 {_fmt_yi(latest_gw)}（净资产为负）",
            evidences=evidences,
        )

    if latest_gw_eq_pct is None and latest_gw_assets_pct is None:
        return CtCheckItem(
            rule_id="goodwill_overhang",
            title="商誉减值悬顶",
            status="na",
            summary="缺少商誉或净资产数据。",
            threshold=threshold,
            value_text="数据不足",
            evidences=evidences,
        )

    value_text = (
        f"占净资产 {_fmt_pct(latest_gw_eq_pct)}"
        if latest_gw_eq_pct is not None
        else f"占总资产 {_fmt_pct(latest_gw_assets_pct)}"
    )
    ratio_desc = (
        f"占归母净资产 {_fmt_pct(latest_gw_eq_pct)}"
        if latest_gw_eq_pct is not None
        else f"占总资产 {_fmt_pct(latest_gw_assets_pct)}"
    )
    if (latest_gw_eq_pct is not None and latest_gw_eq_pct >= 30.0) or (
        latest_gw_assets_pct is not None and latest_gw_assets_pct >= 20.0
    ):
        status: SignalLight = "red"
        summary = (
            f"账面商誉 {_fmt_yi(latest_gw)}，{ratio_desc}，"
            "并购商誉体量过大，存在一次性大额减值冲击风险。"
        )
    elif (latest_gw_eq_pct is not None and latest_gw_eq_pct >= 15.0) or (
        latest_gw_assets_pct is not None and latest_gw_assets_pct >= 10.0
    ):
        status = "yellow"
        summary = (
            f"账面商誉 {_fmt_yi(latest_gw)}，{ratio_desc}，需跟踪被并购标的业绩承诺与减值测试。"
        )
    else:
        status = "green"
        summary = f"商誉{ratio_desc}，并购减值包袱较轻。"

    return CtCheckItem(
        rule_id="goodwill_overhang",
        title="商誉减值悬顶",
        status=status,
        summary=summary,
        threshold=threshold,
        value_text=value_text,
        evidences=evidences,
    )


def _check_shareholder_pledge(pledge: StockPledgeSnapshot | None) -> CtCheckItem:
    threshold = "全市场质押比例 ≥ 30%（红灯）；≥ 15%（黄灯）；< 15%（绿灯）"
    if pledge is None:
        return CtCheckItem(
            rule_id="shareholder_pledge",
            title="股权质押比例",
            status="na",
            summary="暂未获取到有效股权质押比例数据。",
            threshold=threshold,
            value_text="未获取",
            evidences=[],
        )

    ratio = round(pledge.pledge_ratio_pct, 2)
    evidence = CtRuleEvidence(
        year=pledge.trade_date.year,
        label=pledge.trade_date.isoformat(),
        metrics={
            "pledge_ratio_pct": ratio,
            "pledge_market_cap_yuan": finite_or_none(pledge.pledge_market_cap_yuan, 2),
        },
    )
    value_text = f"{ratio:.2f}%"
    if ratio >= 30.0:
        status: SignalLight = "red"
        summary = (
            f"截至 {pledge.trade_date.isoformat()}，质押比例高达 {ratio:.2f}%，"
            "警惕股价下跌触发平仓踩踏风险。"
        )
    elif ratio >= 15.0:
        status = "yellow"
        summary = (
            f"截至 {pledge.trade_date.isoformat()}，质押比例为 {ratio:.2f}%，"
            "属于中等质押水平，需留意大股东流动性。"
        )
    else:
        status = "green"
        summary = (
            f"截至 {pledge.trade_date.isoformat()}，质押比例为 {ratio:.2f}%，股权质押风险较低。"
        )

    return CtCheckItem(
        rule_id="shareholder_pledge",
        title="股权质押比例",
        status=status,
        summary=summary,
        threshold=threshold,
        value_text=value_text,
        evidences=[evidence],
    )


def _classify_opinion(opinion: str) -> SignalLight:
    cleaned = opinion.strip()
    if not cleaned:
        return "na"
    if cleaned in _CLEAN_AUDIT_OPINIONS:
        return "green"
    if "无法表示" in cleaned or "否定" in cleaned:
        return "red"
    if "保留" in cleaned and "无保留" not in cleaned:
        return "red"
    return "yellow"


def _check_audit_opinion(reports: Sequence[StockAnnualReport]) -> CtCheckItem:
    threshold = (
        "非标保留/否定/无法表示意见（红灯）；带强调事项段或近3年曾非标（黄灯）；标准无保留（绿灯）"
    )
    evidences: list[CtRuleEvidence] = []
    opinions: list[tuple[int, str, SignalLight]] = []

    for report in reports[-_EVIDENCE_YEARS:]:
        raw = report.audit_opinion.strip() if report.audit_opinion else None
        item_status = _classify_opinion(raw) if raw else "na"
        if raw:
            opinions.append((report.report_year, raw, item_status))
        evidences.append(
            CtRuleEvidence(
                year=report.report_year,
                label=f"{report.report_year}年报",
                metrics={"audit_opinion": raw},
            )
        )

    if not opinions:
        return CtCheckItem(
            rule_id="audit_opinion",
            title="审计意见扫描",
            status="na",
            summary="年报暂未披露审计意见类型。",
            threshold=threshold,
            value_text="未披露",
            evidences=evidences,
        )

    latest_year, latest_text, latest_status = opinions[-1]
    prior_non_clean = [item for item in opinions[-3:-1] if item[2] in {"red", "yellow"}]

    if latest_status == "red":
        status: SignalLight = "red"
        summary = f"{latest_year}年报被出具「{latest_text}」，属于重大财务合规警示。"
    elif latest_status == "yellow":
        status = "yellow"
        summary = (
            f"{latest_year}年报审计意见为「{latest_text}」，需细读审计师强调事项或持续经营提示。"
        )
    elif prior_non_clean:
        prev_year, prev_text, _ = prior_non_clean[-1]
        status = "yellow"
        summary = (
            f"{latest_year}年报恢复「{latest_text}」，但 {prev_year} 年曾出现「{prev_text}」。"
        )
    else:
        status = "green"
        summary = f"近年年报均为「{latest_text}」，未见审计保留或异常事项。"

    return CtCheckItem(
        rule_id="audit_opinion",
        title="审计意见扫描",
        status=status,
        summary=summary,
        threshold=threshold,
        value_text=latest_text,
        evidences=evidences,
    )


def scan_financial_ct(
    reports: Sequence[StockAnnualReport],
    pledge: StockPledgeSnapshot | None = None,
    *,
    meta: StockMetaRecord | None = None,
) -> FinancialCtSection:
    """Run all 7 deterministic A-share CT rules against sorted annual reports and pledge state."""
    ordered = sort_reports_asc(reports)
    checks = [
        _check_dual_high_cash_debt(ordered, meta),
        _check_stalled_cip(ordered),
        _check_ocf_profit_divergence(ordered, meta),
        _check_receivable_inventory_bloat(ordered, meta),
        _check_goodwill_overhang(ordered),
        _check_shareholder_pledge(pledge),
        _check_audit_opinion(ordered),
    ]

    red_count = sum(1 for item in checks if item.status == "red")
    yellow_count = sum(1 for item in checks if item.status == "yellow")
    green_count = sum(1 for item in checks if item.status == "green")

    if red_count > 0:
        overall_status: SignalLight = "red"
    elif yellow_count > 0:
        overall_status = "yellow"
    elif green_count > 0:
        overall_status = "green"
    else:
        overall_status = "na"

    return FinancialCtSection(
        overall_status=overall_status,
        red_count=red_count,
        yellow_count=yellow_count,
        green_count=green_count,
        checks=checks,
    )
