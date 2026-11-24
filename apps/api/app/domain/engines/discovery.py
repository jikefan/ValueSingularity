"""Pure live value discovery & macro cross-asset regime engine."""

from __future__ import annotations

import math
from collections.abc import Sequence

from app.domain.engines.screener import is_financial_institution_from_snapshot
from app.domain.models import (
    CrossAssetMacroSnapshot,
    DiscoveryCandidateBuckets,
    DiscoveryStockPick,
    DiscoveryThemeCard,
    DiscoveryThemeMetric,
    EarningsQualityTag,
    MarketDiscoveryResponse,
    MarketOverview,
    SignalLight,
    StockSnapshotPayload,
    StyleRegimeIndex,
    TemperatureLevel,
)

_KNOWN_GOLD_CODES = frozenset(
    {"600547", "601899", "600489", "002155", "600988", "000975", "601069"}
)
_GOLD_NAME_KEYWORDS: tuple[str, ...] = (
    "黄金",
    "金矿",
    "紫金",
    "山金",
    "赤峰",
    "银泰",
    "恒邦",
    "招金",
)
_TECH_INDUSTRIES = frozenset({"半导体", "电子", "计算机", "通信", "传媒", "软件开发", "消费电子"})
_TECH_STYLE_CODES = frozenset({"sh000688", "sz399006", ".IXIC"})


def _fmt_num(val: float | None, suffix: str = "", ndigits: int = 2) -> str:
    if val is None or not math.isfinite(val):
        return "—"
    return f"{val:.{ndigits}f}{suffix}"


def _fmt_signed(val: float | None, suffix: str = "", ndigits: int = 2) -> str:
    if val is None or not math.isfinite(val):
        return "—"
    sign = "+" if val > 0 else ""
    return f"{sign}{val:.{ndigits}f}{suffix}"


def _quality_fields(
    snap: StockSnapshotPayload,
) -> tuple[EarningsQualityTag | None, str | None, float | None, float | None, float | None]:
    f = snap.forensics
    pm = snap.peer_metrics
    tag = f.earnings_quality_tag if f is not None else pm.earnings_quality_tag
    label = f.earnings_quality_label if f is not None else pm.earnings_quality_label
    invest_share = f.invest_profit_share_3y_pct if f is not None else pm.invest_profit_share_3y_pct
    inv_ratio = f.investment_assets_ratio_pct if f is not None else pm.investment_assets_ratio_pct
    non_rec = f.non_recurring_share_3y_pct if f is not None else None
    return tag, label, invest_share, inv_ratio, non_rec


def _dividend_yield(snap: StockSnapshotPayload) -> float | None:
    if snap.valuation.dividend_yield_pct is not None:
        return snap.valuation.dividend_yield_pct
    return snap.shareholder_return.current_dividend_yield_pct


def _is_gold_stock(snap: StockSnapshotPayload) -> bool:
    if snap.code in _KNOWN_GOLD_CODES:
        return True
    if any(kw in snap.name for kw in ("黄金", "金矿")):
        return True
    if snap.industry_sw2 and any(kw in snap.industry_sw2 for kw in ("黄金", "贵金属")):
        return True
    return snap.industry_sw1 == "有色金属" and any(kw in snap.name for kw in _GOLD_NAME_KEYWORDS)


def _make_pick(
    snap: StockSnapshotPayload,
    *,
    cn_10y_bond_yield: float | None,
    reason: str,
) -> DiscoveryStockPick:
    is_fin = is_financial_institution_from_snapshot(snap)
    div_yield = _dividend_yield(snap)
    div_spread = (
        round(div_yield - cn_10y_bond_yield, 2)
        if div_yield is not None
        and cn_10y_bond_yield is not None
        and math.isfinite(cn_10y_bond_yield)
        else None
    )
    eq_tag, eq_label, invest_share, inv_ratio, _ = _quality_fields(snap)
    return DiscoveryStockPick(
        code=snap.code,
        name=snap.name,
        industry_sw1=snap.industry_sw1,
        close=snap.valuation.close,
        pe_ttm=snap.valuation.pe_ttm,
        pe_percentile_10y=snap.valuation.pe_percentile_10y,
        pb=snap.valuation.pb,
        dividend_yield_pct=div_yield,
        dividend_spread_over_bond_pct=div_spread,
        roe_5y_avg_pct=snap.moat.roe_5y_avg_pct,
        net_cash_to_mv_pct=snap.peer_metrics.net_cash_to_mv_pct,
        graham_margin_pct=snap.valuation.graham_margin_pct,
        fcf_coverage_ratio=snap.shareholder_return.fcf_coverage_ratio,
        ct_red_count=snap.financial_ct.red_count,
        total_score=snap.radar.total_score,
        is_financial=is_fin,
        earnings_quality_tag=eq_tag,
        earnings_quality_label=eq_label,
        invest_profit_share_3y_pct=invest_share,
        investment_assets_ratio_pct=inv_ratio,
        reason=reason,
    )


def _build_buckets(
    snapshots: Sequence[StockSnapshotPayload],
    *,
    cn_10y_bond_yield: float | None,
) -> DiscoveryCandidateBuckets:
    dividend_candidates: list[tuple[tuple[int, int, float, str], DiscoveryStockPick]] = []
    gold_candidates: list[tuple[tuple[int, int, int, str], DiscoveryStockPick]] = []
    core_cow_candidates: list[tuple[tuple[int, float, int, str], DiscoveryStockPick]] = []
    caution_candidates: list[tuple[tuple[float, str], DiscoveryStockPick]] = []
    deep_value_candidates: list[tuple[tuple[int, int, float, int, str], DiscoveryStockPick]] = []

    for snap in snapshots:
        forensics_rank = 0 if snap.forensics is not None else 1
        is_fin = is_financial_institution_from_snapshot(snap)
        div_yield = _dividend_yield(snap)
        div_spread = (
            round(div_yield - cn_10y_bond_yield, 2)
            if div_yield is not None and cn_10y_bond_yield is not None
            else None
        )
        fcf_cov = snap.shareholder_return.fcf_coverage_ratio
        eq_tag, eq_label, invest_share, inv_ratio, non_rec_share = _quality_fields(snap)
        is_bad_quality = eq_tag in {"investment_driven", "subsidy_inflated"}
        has_caution = not is_fin and (
            is_bad_quality
            or (invest_share is not None and invest_share >= 30.0)
            or (non_rec_share is not None and non_rec_share >= 30.0)
            or (inv_ratio is not None and inv_ratio >= 40.0)
        )

        if (
            div_yield is not None
            and div_yield >= 3.0
            and snap.financial_ct.red_count == 0
            and not has_caution
            and (is_fin or (fcf_cov is not None and fcf_cov >= 0.8))
        ):
            spread_txt = (
                f"（较十年国债 {_fmt_signed(div_spread, '%')}）" if div_spread is not None else ""
            )
            cov_txt = "金融分红稳健" if is_fin else f"FCF 覆盖 {_fmt_num(fcf_cov, 'x')}"
            dividend_candidates.append(
                (
                    (
                        forensics_rank,
                        0 if (snap.valuation.total_mv_yuan or 0) >= 300e8 else 1,
                        -(min(div_yield, 8.0) * 8.0 + snap.radar.total_score * 0.5),
                        snap.code,
                    ),
                    _make_pick(
                        snap,
                        cn_10y_bond_yield=cn_10y_bond_yield,
                        reason=f"股息率 {div_yield:.2f}%{spread_txt}，{cov_txt}，CT 零红灯。",
                    ),
                )
            )

        if _is_gold_stock(snap):
            sector_label = snap.industry_sw2 or snap.industry_sw1 or "黄金贵金属"
            gold_candidates.append(
                (
                    (
                        forensics_rank,
                        -snap.radar.total_score,
                        snap.financial_ct.red_count,
                        snap.code,
                    ),
                    _make_pick(
                        snap,
                        cn_10y_bond_yield=cn_10y_bond_yield,
                        reason=(
                            f"{sector_label}资源标的，PE {_fmt_num(snap.valuation.pe_ttm, 'x')}，"
                            f"ROE {_fmt_num(snap.moat.roe_5y_avg_pct, '%')}，"
                            f"评分 {snap.radar.total_score}。"
                        ),
                    ),
                )
            )

        if not is_fin and snap.financial_ct.red_count == 0:
            ocf_pct = snap.peer_metrics.ocf_to_profit_5y_pct
            roe = snap.moat.roe_5y_avg_pct
            qualifies_cow = (
                eq_tag == "core_cash_cow"
                if eq_tag is not None
                else (roe is not None and roe >= 12.0 and ocf_pct is not None and ocf_pct >= 80.0)
            )
            if qualifies_cow:
                core_share = (
                    snap.forensics.core_profit_share_3y_pct if snap.forensics is not None else None
                )
                core_txt = (
                    f"主业利润占比 {_fmt_num(core_share, '%', 1)}、"
                    if core_share is not None
                    else ""
                )
                core_cow_candidates.append(
                    (
                        (forensics_rank, -(roe or 0.0), -snap.radar.total_score, snap.code),
                        _make_pick(
                            snap,
                            cn_10y_bond_yield=cn_10y_bond_yield,
                            reason=(
                                f"{eq_label or '主业现金牛'}：{core_txt}"
                                f"5年均值 ROE {_fmt_num(roe, '%', 1)}，CT 零红灯。"
                            ),
                        ),
                    )
                )

        if has_caution:
            severity = max(invest_share or 0.0, non_rec_share or 0.0, inv_ratio or 0.0)
            caution_parts: list[str] = []
            if invest_share is not None and (invest_share >= 30.0 or eq_tag == "investment_driven"):
                caution_parts.append(f"近3年投资收益占营业利润 {invest_share:.1f}%")
            if inv_ratio is not None and inv_ratio >= 25.0:
                caution_parts.append(f"表内投资资产占总资产 {inv_ratio:.1f}%")
            if non_rec_share is not None and (
                non_rec_share >= 30.0 or eq_tag == "subsidy_inflated"
            ):
                caution_parts.append(f"非经常性/补贴占比 {non_rec_share:.1f}%")
            caution_candidates.append(
                (
                    (-severity, snap.code),
                    _make_pick(
                        snap,
                        cn_10y_bond_yield=cn_10y_bond_yield,
                        reason=f"{eq_label or '盈利结构警示'}："
                        + ("，".join(caution_parts) if caution_parts else "主业现金转化偏弱")
                        + "。",
                    ),
                )
            )

        pe_pct = snap.valuation.pe_percentile_10y
        pb_pct = snap.valuation.pb_percentile_10y
        net_cash_mv = snap.peer_metrics.net_cash_to_mv_pct
        graham_margin = snap.valuation.graham_margin_pct
        if (
            snap.financial_ct.red_count == 0
            and not has_caution
            and (
                (pe_pct is not None and pe_pct <= 35.0)
                or (is_fin and pb_pct is not None and pb_pct <= 35.0)
                or (net_cash_mv is not None and net_cash_mv >= 25.0)
                or (graham_margin is not None and graham_margin >= 20.0)
            )
        ):
            dv_reasons: list[str] = []
            if pe_pct is not None and pe_pct <= 35.0:
                dv_reasons.append(f"PE 10年分位 {pe_pct:.1f}%")
            elif is_fin and pb_pct is not None and pb_pct <= 35.0:
                dv_reasons.append(f"PB 10年分位 {pb_pct:.1f}%")
            if net_cash_mv is not None and net_cash_mv >= 20.0:
                dv_reasons.append(f"净现金/市值 {net_cash_mv:.1f}%")
            if graham_margin is not None and graham_margin >= 15.0:
                dv_reasons.append(f"格雷厄姆折扣 {graham_margin:.1f}%")
            deep_value_candidates.append(
                (
                    (
                        forensics_rank,
                        -snap.radar.valuation_margin,
                        -(net_cash_mv or 0.0),
                        -snap.radar.total_score,
                        snap.code,
                    ),
                    _make_pick(
                        snap,
                        cn_10y_bond_yield=cn_10y_bond_yield,
                        reason="，".join(dv_reasons) + "，CT 零红灯。",
                    ),
                )
            )

    dividend_candidates.sort(key=lambda pair: pair[0])
    gold_candidates.sort(key=lambda pair: pair[0])
    core_cow_candidates.sort(key=lambda pair: pair[0])
    caution_candidates.sort(key=lambda pair: pair[0])
    deep_value_candidates.sort(key=lambda pair: pair[0])

    return DiscoveryCandidateBuckets(
        dividend_fortresses=[item[1] for item in dividend_candidates[:12]],
        gold_resources=[item[1] for item in gold_candidates[:12]],
        core_cash_cows=[item[1] for item in core_cow_candidates[:12]],
        investment_cautions=[item[1] for item in caution_candidates[:12]],
        deep_value=[item[1] for item in deep_value_candidates[:12]],
    )


def _build_gold_fed_theme(
    macro: CrossAssetMacroSnapshot | None,
    gold_picks: Sequence[DiscoveryStockPick],
) -> DiscoveryThemeCard:
    us_2y = macro.us_2y_yield if macro else None
    us_2y_bps = macro.us_2y_change_20d_bps if macro else None
    us_10y = macro.us_10y_yield if macro else None
    real_yield = macro.us_real_yield_proxy_pct if macro else None
    gold_px = macro.gold_price_cny if macro else None
    gold_pct = macro.gold_percentile_1y if macro else None
    etf_tonnes = macro.gold_etf_tonnes if macro else None
    etf_delta = macro.gold_etf_delta_tonnes if macro else None

    if us_2y is None and gold_px is None and real_yield is None:
        signal: SignalLight = "na"
        verdict = "跨资产利率与黄金序列待同步"
        summary = "暂未获取美债收益率或黄金价格序列，请运行 market sync 同步跨资产数据。"
    else:
        easing_signal = (
            (us_2y_bps is not None and us_2y_bps <= -15.0)
            or (real_yield is not None and real_yield <= 1.2)
            or (etf_delta is not None and etf_delta > 0 and (us_2y_bps is None or us_2y_bps <= 5.0))
        )
        restrictive_signal = (
            real_yield is not None
            and real_yield >= 2.0
            and us_2y_bps is not None
            and us_2y_bps >= 15.0
        )
        if easing_signal:
            signal = "green"
            verdict = "宽松酝酿·赔率占优"
            pct_note = (
                f"当前金价处于近1年 {gold_pct:.1f}% 高分位，宜逢回撤分批布局避免追高。"
                if gold_pct is not None and gold_pct >= 80.0
                else f"当前金价处于近1年 {gold_pct:.1f}% 分位，下行空间相对受限。"
                if gold_pct is not None
                else "美元短端利率走弱支撑配置赔率。"
            )
            rate_parts: list[str] = []
            if us_2y is not None:
                bps_note = (
                    f"（20日 {_fmt_signed(us_2y_bps, 'bps', 1)}）" if us_2y_bps is not None else ""
                )
                rate_parts.append(f"2Y 美债 {us_2y:.2f}%{bps_note}")
            if real_yield is not None:
                rate_parts.append(f"实际利率代理 {real_yield:.2f}%")
            rate_prefix = "，".join(rate_parts) + "；" if rate_parts else ""
            summary = f"{rate_prefix}{pct_note}"
        elif restrictive_signal:
            signal = "red"
            verdict = "高实际利率压制"
            summary = (
                f"2Y 美债近20日上行 {_fmt_signed(us_2y_bps, 'bps', 1)} 至 {_fmt_num(us_2y, '%')}，"
                f"美国实际利率代理达 {_fmt_num(real_yield, '%')}，黄金短线面临利率重定价压制。"
            )
        else:
            signal = "yellow"
            verdict = "利率见顶·逢低定投"
            neutral_parts: list[str] = []
            if us_2y is not None:
                neutral_parts.append(f"2Y 美债 {us_2y:.2f}%")
            if us_10y is not None:
                neutral_parts.append(f"10Y 美债 {us_10y:.2f}%")
            if real_yield is not None:
                neutral_parts.append(f"实际利率代理 {real_yield:.2f}%")
            if gold_px is not None:
                neutral_parts.append(f"金价 {gold_px:.2f} 元/克")
            prefix = "、".join(neutral_parts) + "，" if neutral_parts else ""
            summary = f"{prefix}政策拐点前后适合作为组合非对称对冲仓位。"

    metrics = [
        DiscoveryThemeMetric(
            label="美债 2Y / 20D变动",
            value_text=f"{_fmt_num(us_2y, '%')} ({_fmt_signed(us_2y_bps, 'bps', 1)})",
            tone="green"
            if us_2y_bps is not None and us_2y_bps <= -15.0
            else "red"
            if us_2y_bps is not None and us_2y_bps >= 15.0
            else "yellow"
            if us_2y is not None
            else "na",
        ),
        DiscoveryThemeMetric(
            label="美国实际利率代理",
            value_text=_fmt_num(real_yield, "%"),
            tone="green"
            if real_yield is not None and real_yield <= 1.2
            else "red"
            if real_yield is not None and real_yield >= 2.0
            else "yellow"
            if real_yield is not None
            else "na",
        ),
        DiscoveryThemeMetric(
            label=f"{macro.gold_symbol if macro and macro.gold_symbol else 'Au99.99'} / 1Y分位",
            value_text=f"{_fmt_num(gold_px, '元/克')} ({_fmt_num(gold_pct, '%', 1)})",
            tone="yellow"
            if gold_pct is not None and gold_pct >= 85.0
            else "green"
            if gold_px is not None
            else "na",
        ),
        DiscoveryThemeMetric(
            label="SPDR 黄金 ETF 持仓",
            value_text=(
                f"{_fmt_num(etf_tonnes, '吨')} ({_fmt_signed(etf_delta, '吨')})"
                if etf_tonnes is not None
                else "—"
            ),
            tone="green"
            if etf_delta is not None and etf_delta > 0
            else "yellow"
            if etf_tonnes is not None
            else "na",
        ),
    ]
    picks = list(gold_picks[:5])
    return DiscoveryThemeCard(
        theme_id="gold_fed_cycle",
        title="美联储政策预期 × 黄金配置赔率",
        subtitle="以美债 2Y 政策利率锚、实际利率与 SPDR 持仓验证黄金避险与货币周期赔率",
        signal=signal,
        verdict=verdict,
        regime_summary=summary,
        metrics=metrics,
        picks=picks,
        compare_codes=[p.code for p in picks],
    )


def _find_style(styles: Sequence[StyleRegimeIndex], code: str) -> StyleRegimeIndex | None:
    for item in styles:
        if item.code == code:
            return item
    return None


def _resolve_cn_10y_anchor(overview: MarketOverview) -> float:
    if overview.cross_asset and overview.cross_asset.cn_10y_yield is not None:
        return overview.cross_asset.cn_10y_yield
    return overview.temperature.bond_yield


def _build_tech_dividend_theme(
    overview: MarketOverview,
    dividend_picks: Sequence[DiscoveryStockPick],
    *,
    cn_10y_bond_yield: float | None = None,
) -> DiscoveryThemeCard:
    styles = overview.cross_asset.style_indices if overview.cross_asset else []
    star50 = _find_style(styles, "sh000688")
    chinext = _find_style(styles, "sz399006")
    nasdaq = _find_style(styles, ".IXIC")
    dividend_idx = _find_style(styles, "sh000015")

    tech_indices = [idx for idx in (star50, chinext, nasdaq) if idx is not None]
    drawdowns = [idx.drawdown_60d_pct for idx in tech_indices if idx.drawdown_60d_pct is not None]
    worst_drawdown = min(drawdowns) if drawdowns else None
    tech_20d_vals = [idx.change_20d_pct for idx in tech_indices if idx.change_20d_pct is not None]
    avg_tech_20d = sum(tech_20d_vals) / len(tech_20d_vals) if tech_20d_vals else None

    div_20d = dividend_idx.change_20d_pct if dividend_idx else None
    div_vs_tech_20d = (
        round(div_20d - avg_tech_20d, 2)
        if div_20d is not None and avg_tech_20d is not None
        else None
    )

    tech_outflows = [
        flow
        for flow in overview.hot_industries
        if flow.name in _TECH_INDUSTRIES and flow.net_inflow < 0
    ]
    spreads = [
        p.dividend_spread_over_bond_pct
        for p in dividend_picks
        if p.dividend_spread_over_bond_pct is not None
    ]
    max_spread = max(spreads) if spreads else None
    cn_10y = (
        cn_10y_bond_yield if cn_10y_bond_yield is not None else _resolve_cn_10y_anchor(overview)
    )

    tech_pullback = (worst_drawdown is not None and worst_drawdown <= -8.0) or (
        avg_tech_20d is not None and avg_tech_20d <= -5.0
    )
    if tech_pullback and (
        (div_vs_tech_20d is not None and div_vs_tech_20d > 0)
        or (max_spread is not None and max_spread >= 2.0)
    ):
        signal: SignalLight = "green"
        verdict = "科技成长回撤·红利股债利差占优"
    elif max_spread is not None and max_spread >= 2.0:
        signal = "green"
        verdict = "红利相对十年国债利差充裕（+200bps+）"
    elif styles:
        signal = "yellow"
        verdict = "成长与红利风格拉锯·严选现金流安全垫"
    else:
        signal = "na"
        verdict = "风格指数序列待同步"

    outflow_txt = (
        f"前三大净流出行业中出现科技板块（{'、'.join(f.name for f in tech_outflows[:3])}），"
        if tech_outflows
        else ""
    )
    spread_summary = (
        f"头部红利堡垒股息率较十年国债（{cn_10y:.2f}%）最高溢价 {_fmt_signed(max_spread, '%')}。"
        if max_spread is not None
        else f"当前中国十年国债收益率 {cn_10y:.2f}%，可优先筛选 FCF 覆盖充足的高股息标的。"
    )
    style_parts: list[str] = []
    if worst_drawdown is not None:
        style_parts.append(f"科创50/创业板/纳指近60日最大回撤 {_fmt_num(worst_drawdown, '%')}")
    if div_vs_tech_20d is not None:
        style_parts.append(f"上证红利近20日相对科技超额 {_fmt_signed(div_vs_tech_20d, '%')}")
    elif div_20d is not None:
        style_parts.append(f"上证红利近20日涨跌 {_fmt_signed(div_20d, '%')}")
    style_prefix = "，".join(style_parts) + "；" if style_parts else "主风格指数序列暂未完整同步；"
    regime_summary = f"{style_prefix}{outflow_txt}{spread_summary}"

    metrics = [
        DiscoveryThemeMetric(
            label="科创50 60D回撤 / 20D",
            value_text=(
                f"{_fmt_num(star50.drawdown_60d_pct, '%')} / "
                f"{_fmt_signed(star50.change_20d_pct, '%')}"
                if star50 is not None
                else "—"
            ),
            tone="yellow"
            if star50 and star50.drawdown_60d_pct is not None and star50.drawdown_60d_pct <= -8.0
            else "green"
            if star50 is not None
            else "na",
        ),
        DiscoveryThemeMetric(
            label="上证红利 20D / 相对科技",
            value_text=(
                f"{_fmt_signed(div_20d, '%')} ({_fmt_signed(div_vs_tech_20d, '%')})"
                if dividend_idx is not None
                else "—"
            ),
            tone="green"
            if div_vs_tech_20d is not None and div_vs_tech_20d > 0
            else "yellow"
            if dividend_idx is not None
            else "na",
        ),
        DiscoveryThemeMetric(
            label="纳斯达克 20D / 60D回撤",
            value_text=(
                f"{_fmt_signed(nasdaq.change_20d_pct, '%')} / "
                f"{_fmt_num(nasdaq.drawdown_60d_pct, '%')}"
                if nasdaq is not None
                else "—"
            ),
            tone="yellow"
            if nasdaq and nasdaq.drawdown_60d_pct is not None and nasdaq.drawdown_60d_pct <= -8.0
            else "green"
            if nasdaq is not None
            else "na",
        ),
        DiscoveryThemeMetric(
            label="最高股息-国债利差",
            value_text=_fmt_signed(max_spread, "%"),
            tone="green"
            if max_spread is not None and max_spread >= 2.0
            else "yellow"
            if max_spread is not None
            else "na",
        ),
    ]
    picks = list(dividend_picks[:5])
    return DiscoveryThemeCard(
        theme_id="tech_vs_dividend_rotation",
        title="科技成长回撤 × 红利避风港切换",
        subtitle="跟踪科创50/创业板/纳斯达克回撤节奏与上证红利相对国债利差（+200bps+）",
        signal=signal,
        verdict=verdict,
        regime_summary=regime_summary,
        metrics=metrics,
        picks=picks,
        compare_codes=[p.code for p in picks],
    )


def _build_quality_radar_theme(
    *,
    synced_count: int,
    core_cows: Sequence[DiscoveryStockPick],
    cautions: Sequence[DiscoveryStockPick],
) -> DiscoveryThemeCard:
    if synced_count == 0:
        signal: SignalLight = "na"
        verdict = "等待同步个股快照"
        summary = "暂未同步个股快照，同步核心标的池后将自动剥离主业现金牛与投资收益依赖股。"
    elif core_cows and cautions:
        signal = "green"
        verdict = f"识别 {len(core_cows)} 只主业现金牛 · 标红 {len(cautions)} 只投资/补贴依赖"
        summary = (
            "系统已剔除投资收益、公允价值变动与政府补助干扰，在「扣非」之上进一步识别"
            "联营合营投资收益掩盖主业亏损的样本，避免误把金融投资周期当作主业护城河。"
        )
    elif cautions:
        signal = "yellow"
        verdict = f"预警 {len(cautions)} 只投资收益或非经占比偏高标的"
        summary = (
            "当前样本池中发现部分标的盈利高度依赖对外投资或一次性收益，"
            "建议优先核查主业核心营业利润。"
        )
    elif core_cows:
        signal = "green"
        verdict = f"精选 {len(core_cows)} 只高纯度主业现金牛"
        summary = "入选标的近3年主业核心利润占比与经营现金流转化均处于高水平。"
    else:
        signal = "yellow"
        verdict = "当前池内标的盈利结构分化温和"
        summary = "建议补充或重同步带完整利润拆解科目的个股以激活主业透视雷达。"

    picks = list(core_cows[:5])
    caution_picks = list(cautions[:5])
    compare_codes = [p.code for p in [*picks[:3], *caution_picks[:2]]][:5]
    metrics = [
        DiscoveryThemeMetric(
            label="主业现金牛样本",
            value_text=f"{len(core_cows)} 只",
            tone="green" if core_cows else "na",
        ),
        DiscoveryThemeMetric(
            label="投资/补贴依赖预警",
            value_text=f"{len(cautions)} 只",
            tone="yellow" if cautions else "green" if synced_count > 0 else "na",
        ),
    ]
    return DiscoveryThemeCard(
        theme_id="earnings_quality_radar",
        title="主业造血现金牛 vs 投资收益依赖排查",
        subtitle="拆解营业利润中的主业经营、对外股权/证券投资收益与政府补助，穿透真实盈利质量",
        signal=signal,
        verdict=verdict,
        regime_summary=summary,
        metrics=metrics,
        picks=picks,
        caution_picks=caution_picks,
        compare_codes=compare_codes,
    )


def _build_deep_value_theme(
    overview: MarketOverview,
    deep_value_picks: Sequence[DiscoveryStockPick],
) -> DiscoveryThemeCard:
    temp = overview.temperature
    picks = list(deep_value_picks[:5])
    if not picks:
        signal: SignalLight = "na"
        verdict = "暂未筛选出低估值零红灯深度价值候选"
    elif temp.level in {TemperatureLevel.COLD, TemperatureLevel.COOL}:
        signal = "green"
        verdict = f"市场温度 {temp.score:.1f}（{temp.level.value}）· 深度价值安全边际充裕"
    else:
        signal = "yellow"
        verdict = f"市场温度 {temp.score:.1f} · 精选 {len(picks)} 只低分位/高净现金安全垫"

    summary = (
        f"全市场 PE 中位数 {temp.pe_median:.2f}（历史 {temp.pe_percentile:.1f}% 分位），"
        f"股债性价比 {temp.equity_bond_spread:.2f}%；深度价值池聚焦 CT 零红灯、"
        "估值处于近10年低分位或净现金充沛标的。"
    )
    metrics = [
        DiscoveryThemeMetric(
            label="市场温度 / 分位",
            value_text=f"{temp.score:.1f} ({temp.pe_percentile:.1f}%)",
            tone="green"
            if temp.level in {TemperatureLevel.COLD, TemperatureLevel.COOL}
            else "yellow",
        ),
        DiscoveryThemeMetric(
            label="股债性价比",
            value_text=_fmt_signed(temp.equity_bond_spread, "%"),
            tone="green" if temp.equity_bond_spread >= 2.0 else "yellow",
        ),
        DiscoveryThemeMetric(
            label="深度价值候选",
            value_text=f"{len(deep_value_picks)} 只",
            tone="green" if picks else "na",
        ),
    ]
    return DiscoveryThemeCard(
        theme_id="deep_value_fortress",
        title="高净现金与低估值安全边际",
        subtitle="筛选 CT 零红灯、PE/PB 处于近十年低分位且具备净现金或格雷厄姆折扣保护的标的",
        signal=signal,
        verdict=verdict,
        regime_summary=summary,
        metrics=metrics,
        picks=picks,
        compare_codes=[p.code for p in picks],
    )


def build_market_discovery_board(
    overview: MarketOverview,
    snapshots: Sequence[StockSnapshotPayload],
) -> MarketDiscoveryResponse:
    """Synthesize live cross-asset regime telemetry and bottom-up synced candidate buckets."""
    cn_10y = _resolve_cn_10y_anchor(overview)
    buckets = _build_buckets(snapshots, cn_10y_bond_yield=cn_10y)

    themes = [
        _build_gold_fed_theme(overview.cross_asset, buckets.gold_resources),
        _build_tech_dividend_theme(
            overview,
            buckets.dividend_fortresses,
            cn_10y_bond_yield=cn_10y,
        ),
        _build_quality_radar_theme(
            synced_count=len(snapshots),
            core_cows=buckets.core_cash_cows,
            cautions=buckets.investment_cautions,
        ),
        _build_deep_value_theme(overview, buckets.deep_value),
    ]
    return MarketDiscoveryResponse(
        as_of=overview.as_of,
        generated_at=overview.generated_at,
        synced_stock_count=len(snapshots),
        temperature=overview.temperature,
        cross_asset=overview.cross_asset,
        themes=themes,
        candidate_buckets=buckets,
    )
