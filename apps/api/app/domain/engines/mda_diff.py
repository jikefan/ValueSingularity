"""Pure domain engine for MD&A text diffing and accounting metric shift detection."""

from __future__ import annotations

import difflib
import re

from app.domain.models import (
    AnnualFinancialTrendPoint,
    MdaDiffHighlight,
    MdaMetricShift,
    SignalLight,
    StockSnapshotPayload,
)

_CLAUSE_SPLIT_RE = re.compile(r"[。；;\r\n]+")
_CLAUSE_NORM_RE = re.compile(r"[\s，,、：:（）()“”\"'‘’]+")
_CLEAN_BOILERPLATE_RE = re.compile(
    r"未发生[^，,。；;\r\n]*?(?:变更|变化|调整)"
    r"|未发生(?:重大)?(?:会计政策|会计估计)"
    r"|不存在[^，,。；;\r\n]*?退市(?:风险警示|风险)?"
    r"|无(?:重大|未决)?(?:诉讼|仲裁)(?:[、及与和]+(?:诉讼|仲裁))*"
    r"|持续经营能力正常"
    r"|不再亏损"
    r"|[^，,。；;\r\n]*?保持稳定"
    r"|(?:审计意见(?:为|均为|保持为?)?)?(?:标准)?无保留意见"
)

_MAX_CLAUSES = 800
_MAX_PAIR_COMPARE_CHARS = 400
_MAX_PAIRWISE_PRODUCT = 2500

_ACCOUNTING_POLICY_KEYWORDS: tuple[str, ...] = (
    "会计政策",
    "会计估计",
    "会计差错",
    "追溯调整",
    "重述",
    "坏账准备",
    "跌价准备",
    "减值准备",
    "减值测试",
    "商誉减值",
    "审计意见",
    "非标",
    "保留意见",
    "强调事项",
    "持续经营",
    "研发支出资本化",
    "资本化率",
    "公允价值",
    "重分类",
    "折旧年限",
    "折旧方法",
    "收入确认",
)

_SEVERE_RISK_KEYWORDS: tuple[str, ...] = (
    "重大不利",
    "立案调查",
    "行政处罚",
    "退市",
    "违约",
    "逾期",
    "停产",
    "大额减值",
    "计提减值",
    "资金占用",
    "违规担保",
    "诉讼",
    "仲裁",
)

_HEADWIND_RISK_KEYWORDS: tuple[str, ...] = (
    "需求不及预期",
    "需求疲软",
    "需求不足",
    "宏观承压",
    "行业下行",
    "价格战",
    "产能过剩",
    "竞争加剧",
    "库存承压",
    "毛利率下滑",
    "毛利下滑",
    "回款放缓",
    "汇率波动",
    "原材料涨价",
    "不确定性",
    "风险",
    "承压",
    "不及预期",
    "下调",
    "放缓",
    "下滑",
    "亏损",
)

_GUIDANCE_EXPANSION_KEYWORDS: tuple[str, ...] = (
    "产能扩张",
    "扩产",
    "高增长",
    "稳健增长",
    "快速增长",
    "超预期",
    "业绩目标",
    "业绩指引",
    "指引",
    "翻番",
    "市占率提升",
    "订单饱满",
    "供不应求",
    "高景气",
    "满产",
    "提价",
    "战略扩张",
    "稳步推进",
    "预计增长",
)

_SEVERITY_ORDER: dict[SignalLight, int] = {
    "red": 0,
    "yellow": 1,
    "green": 2,
    "na": 3,
}


def _fmt_yi(val: float | None) -> str:
    return f"{val / 1e8:.2f}亿元" if val is not None else "—"


def _fmt_pct(val: float | None) -> str:
    return f"{val:.2f}%" if val is not None else "—"


def _ratio_ocf_profit(point: AnnualFinancialTrendPoint) -> float | None:
    if point.ocf_yuan is None or point.net_profit_yuan is None:
        return None
    if point.net_profit_yuan <= 0:
        return None
    return round(point.ocf_yuan / point.net_profit_yuan, 2)


def compute_accounting_metric_shifts(
    snapshot: StockSnapshotPayload | None,
) -> list[MdaMetricShift]:
    """Compare the latest two annual periods on revenue, profit quality, margin, cash, and CT."""
    if snapshot is None:
        return []

    ordered = sort_reports_like(snapshot.annual_trends)
    shifts: list[MdaMetricShift] = []

    if len(ordered) >= 2:
        prev = ordered[-2]
        curr = ordered[-1]

        if prev.revenue_yuan is not None and curr.revenue_yuan is not None:
            yoy = (
                ((curr.revenue_yuan - prev.revenue_yuan) / abs(prev.revenue_yuan)) * 100.0
                if prev.revenue_yuan > 0
                else None
            )
            rev_sev: SignalLight = (
                "red"
                if (yoy is not None and yoy <= -15.0)
                else ("yellow" if (yoy is not None and yoy < 0.0) else "green")
            )
            delta_txt = f"{yoy:+.2f}%" if yoy is not None else "基数非正"
            interp = (
                f"{curr.year}年营收较{prev.year}年明显收缩，需排查下游需求与市场份额变化。"
                if rev_sev == "red"
                else (
                    f"{curr.year}年营收小幅回落，关注主业订单复苏节奏。"
                    if rev_sev == "yellow"
                    else f"{curr.year}年营收保持扩张或平稳。"
                )
            )
            shifts.append(
                MdaMetricShift(
                    metric_label="营业收入同比",
                    previous_text=f"{prev.year}年 {_fmt_yi(prev.revenue_yuan)}",
                    current_text=f"{curr.year}年 {_fmt_yi(curr.revenue_yuan)}",
                    delta_text=delta_txt,
                    severity=rev_sev,
                    interpretation=interp,
                )
            )

        if (
            prev.net_profit_yuan is not None
            and curr.net_profit_yuan is not None
            and prev.deduct_net_profit_yuan is not None
            and curr.deduct_net_profit_yuan is not None
        ):
            prev_gap = prev.net_profit_yuan - prev.deduct_net_profit_yuan
            curr_gap = curr.net_profit_yuan - curr.deduct_net_profit_yuan
            gap_delta = curr_gap - prev_gap
            non_rec_ratio = (
                abs(curr_gap) / max(1.0, abs(curr.net_profit_yuan))
                if curr.net_profit_yuan != 0
                else 0.0
            )
            breakeven_masked = curr.net_profit_yuan == 0 and curr.deduct_net_profit_yuan < 0
            sign_diverged = (
                curr.net_profit_yuan > 0 >= curr.deduct_net_profit_yuan
            ) or breakeven_masked
            if sign_diverged or (curr_gap > 0 and non_rec_ratio >= 0.30):
                prof_sev: SignalLight = "red"
                prof_interp = "归母净利润对非经常性损益依赖度偏高，主业扣非盈利承压。"
            elif curr_gap > 0 and (
                non_rec_ratio >= 0.15
                or (
                    curr.net_profit_yuan > prev.net_profit_yuan
                    and curr.deduct_net_profit_yuan < prev.deduct_net_profit_yuan
                )
            ):
                prof_sev = "yellow"
                prof_interp = "本期非经常性损益差额扩大，扣非利润增长弱于表观归母利润。"
            else:
                prof_sev = "green"
                prof_interp = "归母净利润与扣非净利润结构基本一致，非经常性扰动可控。"
            shifts.append(
                MdaMetricShift(
                    metric_label="归母净利 vs 扣非差额",
                    previous_text=(
                        f"{prev.year}年 归母 {_fmt_yi(prev.net_profit_yuan)} / "
                        f"扣非 {_fmt_yi(prev.deduct_net_profit_yuan)}"
                    ),
                    current_text=(
                        f"{curr.year}年 归母 {_fmt_yi(curr.net_profit_yuan)} / "
                        f"扣非 {_fmt_yi(curr.deduct_net_profit_yuan)}"
                    ),
                    delta_text=f"非经常差额变化 {gap_delta / 1e8:+.2f}亿元",
                    severity=prof_sev,
                    interpretation=prof_interp,
                )
            )

        if prev.gross_margin_pct is not None and curr.gross_margin_pct is not None:
            gm_delta = curr.gross_margin_pct - prev.gross_margin_pct
            gm_sev: SignalLight = (
                "red" if gm_delta <= -5.0 else ("yellow" if gm_delta <= -2.0 else "green")
            )
            gm_interp = (
                "毛利率大幅下滑，可能存在价格竞争加剧、产品降档或折旧上行压力。"
                if gm_sev == "red"
                else (
                    "毛利率小幅回落，需关注成本传导与产品结构变动。"
                    if gm_sev == "yellow"
                    else "毛利率保持稳定或提升，产品定价权未见明显松动。"
                )
            )
            shifts.append(
                MdaMetricShift(
                    metric_label="毛利率变化",
                    previous_text=f"{prev.year}年 {_fmt_pct(prev.gross_margin_pct)}",
                    current_text=f"{curr.year}年 {_fmt_pct(curr.gross_margin_pct)}",
                    delta_text=f"{gm_delta:+.2f} 个百分点",
                    severity=gm_sev,
                    interpretation=gm_interp,
                )
            )

        prev_ocf_ratio = _ratio_ocf_profit(prev)
        curr_ocf_ratio = _ratio_ocf_profit(curr)
        if prev.ocf_yuan is not None and curr.ocf_yuan is not None:
            if prev_ocf_ratio is not None and curr_ocf_ratio is not None:
                ocf_delta = curr_ocf_ratio - prev_ocf_ratio
                ocf_sev: SignalLight = (
                    "red"
                    if (curr_ocf_ratio < 0.5 or ocf_delta <= -0.4)
                    else ("yellow" if (curr_ocf_ratio < 0.8 or ocf_delta <= -0.2) else "green")
                )
                delta_str = f"{ocf_delta:+.2f} 倍"
                prev_str = f"{prev.year}年 {prev_ocf_ratio:.2f}倍"
                curr_str = f"{curr.year}年 {curr_ocf_ratio:.2f}倍"
            elif curr_ocf_ratio is not None:
                ocf_sev = (
                    "red"
                    if curr_ocf_ratio < 0.5
                    else ("yellow" if curr_ocf_ratio < 0.8 else "green")
                )
                prev_note = (
                    "净利非正"
                    if (prev.net_profit_yuan is not None and prev.net_profit_yuan <= 0)
                    else "净利缺失"
                )
                ocf_delta_yi = (curr.ocf_yuan - prev.ocf_yuan) / 1e8
                delta_str = f"本期净现比 {curr_ocf_ratio:.2f}倍（OCF 变化 {ocf_delta_yi:+.2f}亿元）"
                prev_str = f"{prev.year}年 OCF {_fmt_yi(prev.ocf_yuan)}（{prev_note}）"
                curr_str = f"{curr.year}年 {curr_ocf_ratio:.2f}倍（OCF {_fmt_yi(curr.ocf_yuan)}）"
            else:
                ocf_sev = "red" if curr.ocf_yuan < 0 else "yellow"
                delta_str = f"OCF 变化 {(curr.ocf_yuan - prev.ocf_yuan) / 1e8:+.2f}亿元"
                prev_str = f"{prev.year}年 OCF {_fmt_yi(prev.ocf_yuan)}"
                curr_str = f"{curr.year}年 OCF {_fmt_yi(curr.ocf_yuan)}"
            ocf_interp = (
                "净现比偏低或明显下行，账面利润与回款现金流背离扩大。"
                if ocf_sev in {"red", "yellow"}
                else "经营现金流对净利润覆盖良好，盈利回款扎实。"
            )
            shifts.append(
                MdaMetricShift(
                    metric_label="净现比变化",
                    previous_text=prev_str,
                    current_text=curr_str,
                    delta_text=delta_str,
                    severity=ocf_sev,
                    interpretation=ocf_interp,
                )
            )

        if prev.rd_ratio_pct is not None and curr.rd_ratio_pct is not None:
            rd_delta = curr.rd_ratio_pct - prev.rd_ratio_pct
            rd_sev: SignalLight = "yellow" if rd_delta <= -1.0 else "green"
            rd_interp = (
                "研发费用率显著下降，需核查是否出现研发投入收缩或会计资本化率提升。"
                if rd_sev == "yellow"
                else "研发费用率保持平稳或提升。"
            )
            shifts.append(
                MdaMetricShift(
                    metric_label="研发费用率变化",
                    previous_text=f"{prev.year}年 {_fmt_pct(prev.rd_ratio_pct)}",
                    current_text=f"{curr.year}年 {_fmt_pct(curr.rd_ratio_pct)}",
                    delta_text=f"{rd_delta:+.2f} 个百分点",
                    severity=rd_sev,
                    interpretation=rd_interp,
                )
            )

        if prev.net_cash_yuan is not None and curr.net_cash_yuan is not None:
            nc_delta = curr.net_cash_yuan - prev.net_cash_yuan
            if (prev.net_cash_yuan >= 0 > curr.net_cash_yuan) or (
                prev.net_cash_yuan > 0 and nc_delta / prev.net_cash_yuan <= -0.30
            ):
                nc_sev: SignalLight = "red"
            elif nc_delta < 0 and (abs(nc_delta) / max(1.0, abs(prev.net_cash_yuan)) >= 0.15):
                nc_sev = "yellow"
            else:
                nc_sev = "green"
            nc_interp = (
                "净现金明显消耗或由正转负，需关注举债扩张与资本开支对流动性的挤占。"
                if nc_sev == "red"
                else (
                    "净现金有所下降，建议核对分红、回购与资本支出节奏。"
                    if nc_sev == "yellow"
                    else "资产负债表净现金安全垫稳健或增厚。"
                )
            )
            shifts.append(
                MdaMetricShift(
                    metric_label="净现金变化",
                    previous_text=f"{prev.year}年 {_fmt_yi(prev.net_cash_yuan)}",
                    current_text=f"{curr.year}年 {_fmt_yi(curr.net_cash_yuan)}",
                    delta_text=f"{nc_delta / 1e8:+.2f}亿元",
                    severity=nc_sev,
                    interpretation=nc_interp,
                )
            )

    audit_check = next(
        (chk for chk in snapshot.financial_ct.checks if chk.rule_id == "audit_opinion"),
        None,
    )
    prev_opinion = "未披露"
    curr_opinion = snapshot.latest_audit_opinion or "未披露"
    prev_audit_year: int | None = ordered[-2].year if len(ordered) >= 2 else None
    curr_audit_year: int | None = ordered[-1].year if ordered else None
    if audit_check is not None and len(audit_check.evidences) >= 2:
        prev_ev = audit_check.evidences[-2]
        curr_ev = audit_check.evidences[-1]
        prev_audit_year = prev_ev.year
        curr_audit_year = curr_ev.year
        raw_prev = prev_ev.metrics.get("audit_opinion")
        raw_curr = curr_ev.metrics.get("audit_opinion")
        if isinstance(raw_prev, str) and raw_prev.strip():
            prev_opinion = raw_prev.strip()
        if isinstance(raw_curr, str) and raw_curr.strip():
            curr_opinion = raw_curr.strip()
    elif audit_check is not None and len(audit_check.evidences) == 1:
        curr_ev = audit_check.evidences[-1]
        curr_audit_year = curr_ev.year
        raw_curr = curr_ev.metrics.get("audit_opinion")
        if isinstance(raw_curr, str) and raw_curr.strip():
            curr_opinion = raw_curr.strip()

    ct_red = snapshot.financial_ct.red_count
    ct_yellow = snapshot.financial_ct.yellow_count
    opinion_changed = prev_opinion != curr_opinion and prev_opinion != "未披露"
    ct_sev: SignalLight = (
        "red"
        if ct_red > 0 or (audit_check is not None and audit_check.status == "red")
        else (
            "yellow"
            if ct_yellow > 0
            or opinion_changed
            or (audit_check is not None and audit_check.status == "yellow")
            else "green"
        )
    )
    prev_year_label = f"{prev_audit_year}年 " if prev_audit_year is not None else "上期快照 "
    curr_year_label = (
        f"{curr_audit_year}年 "
        if curr_audit_year is not None
        else f"快照({snapshot.as_of.isoformat()}) "
    )
    shifts.append(
        MdaMetricShift(
            metric_label="CT红灯与审计意见口径",
            previous_text=f"{prev_year_label}审计：{prev_opinion}",
            current_text=(
                f"{curr_year_label}审计：{curr_opinion}（红灯 {ct_red} / 黄灯 {ct_yellow}）"
            ),
            delta_text=(
                "审计口径变更" if opinion_changed else f"红灯 {ct_red} 项 / 黄灯 {ct_yellow} 项"
            ),
            severity=ct_sev,
            interpretation=(
                "财务排雷或审计意见存在警示信号，需优先核查会计附注与受限科目。"
                if ct_sev in {"red", "yellow"}
                else "财务排雷与审计意见均保持标准干净口径。"
            ),
        )
    )
    return shifts


def sort_reports_like(trends: list[AnnualFinancialTrendPoint]) -> list[AnnualFinancialTrendPoint]:
    by_year = {pt.year: pt for pt in trends}
    return [by_year[year] for year in sorted(by_year)]


def _split_clauses(raw_text: str) -> list[tuple[str, str]]:
    clauses: list[tuple[str, str]] = []
    for part in _CLAUSE_SPLIT_RE.split(raw_text):
        orig = part.strip()
        if not orig:
            continue
        norm = _CLAUSE_NORM_RE.sub("", orig)
        if not norm:
            continue
        clauses.append((orig, norm))
    return clauses


def _matched_keywords(text: str, vocab: tuple[str, ...]) -> list[str]:
    return [kw for kw in vocab if kw in text]


def _strip_clean_boilerplate(text: str) -> str:
    return _CLEAN_BOILERPLATE_RE.sub("", text)


def _classify_highlight(
    change_type: str,
    prev_text: str | None,
    curr_text: str | None,
) -> tuple[str, list[str], SignalLight]:
    prev = _strip_clean_boilerplate(prev_text or "")
    curr = _strip_clean_boilerplate(curr_text or "")

    curr_acct = _matched_keywords(curr, _ACCOUNTING_POLICY_KEYWORDS)
    prev_acct = _matched_keywords(prev, _ACCOUNTING_POLICY_KEYWORDS)
    acct_hits = list(dict.fromkeys([*curr_acct, *prev_acct]))

    curr_severe = _matched_keywords(curr, _SEVERE_RISK_KEYWORDS)
    curr_headwind = _matched_keywords(curr, _HEADWIND_RISK_KEYWORDS)
    prev_guidance = _matched_keywords(prev, _GUIDANCE_EXPANSION_KEYWORDS)
    curr_guidance = _matched_keywords(curr, _GUIDANCE_EXPANSION_KEYWORDS)

    if acct_hits:
        tags = [f"口径:{acct_hits[0]}", *(f"风险:{k}" for k in curr_severe[:2])]
        return "会计政策与审计口径变更", tags, "red"

    if curr_severe:
        return "重大风险与减值警示", [f"红线:{k}" for k in curr_severe[:3]], "red"

    if change_type == "removed" and prev_guidance:
        return "指引与扩张表述删减", [f"删减:{k}" for k in prev_guidance[:3]], "yellow"

    if change_type == "modified":
        removed_guidance = [kw for kw in prev_guidance if kw not in curr_guidance]
        if removed_guidance or curr_headwind:
            tags = [
                *(f"删除:{k}" for k in removed_guidance[:2]),
                *(f"新增:{k}" for k in curr_headwind[:2]),
            ]
            return "表述口径软化或风险加码", tags or ["口径修改"], "yellow"
        return "经营表述调整", ["措辞修改"], "green"

    if change_type == "added":
        if curr_headwind:
            return "新增需求或经营承压提示", [f"新增:{k}" for k in curr_headwind[:3]], "yellow"
        return "常规经营信息补充", ["常规新增"], "green"

    return "常规经营表述删减", ["常规删减"], "green"


def _bounded_similarity(
    left: str,
    right: str,
    *,
    min_threshold: float,
    matcher: difflib.SequenceMatcher[str] | None = None,
) -> float:
    sm = matcher or difflib.SequenceMatcher(None, "", "", autojunk=False)
    sm.set_seqs(left[:_MAX_PAIR_COMPARE_CHARS], right[:_MAX_PAIR_COMPARE_CHARS])
    if sm.real_quick_ratio() < min_threshold or sm.quick_ratio() < min_threshold:
        return 0.0
    return sm.ratio()


def _pair_replaced_block(
    prev_block: list[tuple[str, str]],
    curr_block: list[tuple[str, str]],
) -> list[tuple[str, str | None, str | None]]:
    if len(prev_block) == 1 and len(curr_block) == 1:
        p_orig, p_norm = prev_block[0]
        c_orig, c_norm = curr_block[0]
        if _bounded_similarity(p_norm, c_norm, min_threshold=0.35) >= 0.35:
            return [("modified", p_orig, c_orig)]
        return [("removed", p_orig, None), ("added", None, c_orig)]

    if len(prev_block) * len(curr_block) > _MAX_PAIRWISE_PRODUCT:
        sm: difflib.SequenceMatcher[str] = difflib.SequenceMatcher(None, "", "", autojunk=False)
        common = min(len(prev_block), len(curr_block))
        events: list[tuple[str, str | None, str | None]] = []
        for idx in range(common):
            p_orig, p_norm = prev_block[idx]
            c_orig, c_norm = curr_block[idx]
            if _bounded_similarity(p_norm, c_norm, min_threshold=0.35, matcher=sm) >= 0.35:
                events.append(("modified", p_orig, c_orig))
            else:
                events.append(("removed", p_orig, None))
                events.append(("added", None, c_orig))
        for p_orig, _ in prev_block[common:]:
            events.append(("removed", p_orig, None))
        for c_orig, _ in curr_block[common:]:
            events.append(("added", None, c_orig))
        return events

    sm = difflib.SequenceMatcher(None, "", "", autojunk=False)
    scored_pairs: list[tuple[float, int, int]] = []
    for j, (_, c_norm) in enumerate(curr_block):
        sm.set_seq2(c_norm[:_MAX_PAIR_COMPARE_CHARS])
        for i, (_, p_norm) in enumerate(prev_block):
            sm.set_seq1(p_norm[:_MAX_PAIR_COMPARE_CHARS])
            if sm.real_quick_ratio() < 0.40 or sm.quick_ratio() < 0.40:
                continue
            ratio = sm.ratio()
            if ratio >= 0.40:
                scored_pairs.append((ratio, i, j))
    scored_pairs.sort(key=lambda item: (-item[0], item[1], item[2]))

    used_prev: set[int] = set()
    used_curr: set[int] = set()
    matched: list[tuple[int, int]] = []
    for _, i, j in scored_pairs:
        if i in used_prev or j in used_curr:
            continue
        used_prev.add(i)
        used_curr.add(j)
        matched.append((i, j))

    matched.sort()
    events = []
    for i, j in matched:
        events.append(("modified", prev_block[i][0], curr_block[j][0]))
    for i, (p_orig, _) in enumerate(prev_block):
        if i not in used_prev:
            events.append(("removed", p_orig, None))
    for j, (c_orig, _) in enumerate(curr_block):
        if j not in used_curr:
            events.append(("added", None, c_orig))
    return events


def _trim_identical_edges(
    prev_clauses: list[tuple[str, str]],
    curr_clauses: list[tuple[str, str]],
) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Strip common identical prefix/suffix in O(N) before bounded clause diffing."""
    min_len = min(len(prev_clauses), len(curr_clauses))
    prefix = 0
    while prefix < min_len and prev_clauses[prefix][1] == curr_clauses[prefix][1]:
        prefix += 1

    prev_rem = len(prev_clauses) - prefix
    curr_rem = len(curr_clauses) - prefix
    max_suffix = min(prev_rem, curr_rem)
    suffix = 0
    while (
        suffix < max_suffix
        and prev_clauses[len(prev_clauses) - 1 - suffix][1]
        == curr_clauses[len(curr_clauses) - 1 - suffix][1]
    ):
        suffix += 1

    prev_end = len(prev_clauses) - suffix
    curr_end = len(curr_clauses) - suffix
    return prev_clauses[prefix:prev_end], curr_clauses[prefix:curr_end]


def compute_text_mda_diff(
    previous_text: str,
    current_text: str,
    *,
    has_snapshot: bool = True,
) -> tuple[list[MdaDiffHighlight], str]:
    """Diff two MD&A text blocks by clause, tag policy/risk shifts, and summarize."""
    prev_clauses = _split_clauses(previous_text)
    curr_clauses = _split_clauses(current_text)

    if not prev_clauses and not curr_clauses:
        if not has_snapshot:
            return [], "尚未同步财报快照且未提供年报文本，暂无可对比变化。"
        return [], "未提供管理层讨论与分析原文，当前仅基于已同步财报快照生成定量口径变化对比。"

    prev_clauses, curr_clauses = _trim_identical_edges(prev_clauses, curr_clauses)
    prev_clauses = prev_clauses[:_MAX_CLAUSES]
    curr_clauses = curr_clauses[:_MAX_CLAUSES]

    prev_norms = [item[1] for item in prev_clauses]
    curr_norms = [item[1] for item in curr_clauses]
    matcher = difflib.SequenceMatcher(None, prev_norms, curr_norms, autojunk=False)

    raw_events: list[tuple[str, str | None, str | None]] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if tag == "insert":
            for c_orig, _ in curr_clauses[j1:j2]:
                raw_events.append(("added", None, c_orig))
        elif tag == "delete":
            for p_orig, _ in prev_clauses[i1:i2]:
                raw_events.append(("removed", p_orig, None))
        elif tag == "replace":
            raw_events.extend(_pair_replaced_block(prev_clauses[i1:i2], curr_clauses[j1:j2]))

    if not raw_events:
        return [], "两期管理层讨论与分析核心条款完全一致，未发现口径增删或措辞变化。"

    indexed_highlights: list[tuple[int, int, MdaDiffHighlight]] = []
    for order_idx, (change_type, prev_excerpt, curr_excerpt) in enumerate(raw_events):
        category, tags, severity = _classify_highlight(change_type, prev_excerpt, curr_excerpt)
        if change_type == "added":
            literal_type: str = "added"
        elif change_type == "removed":
            literal_type = "removed"
        else:
            literal_type = "modified"
        item = MdaDiffHighlight(
            change_type=literal_type,  # type: ignore[arg-type]
            category=category,
            previous_excerpt=prev_excerpt,
            current_excerpt=curr_excerpt,
            signal_tags=tags,
            severity=severity,
        )
        indexed_highlights.append((_SEVERITY_ORDER[severity], order_idx, item))

    indexed_highlights.sort(key=lambda row: (row[0], row[1]))
    highlights = [row[2] for row in indexed_highlights]

    added_cnt = sum(1 for h in highlights if h.change_type == "added")
    removed_cnt = sum(1 for h in highlights if h.change_type == "removed")
    modified_cnt = sum(1 for h in highlights if h.change_type == "modified")
    red_cnt = sum(1 for h in highlights if h.severity == "red")
    yellow_cnt = sum(1 for h in highlights if h.severity == "yellow")

    summary = (
        f"共识别文本变更 {len(highlights)} 处（新增 {added_cnt} 处、删除 {removed_cnt} 处、"
        f"修改 {modified_cnt} 处），其中高敏感会计/风险提示 {red_cnt} 处、"
        f"次级经营/指引口径变化 {yellow_cnt} 处。"
    )
    return highlights, summary
