"""Pure deterministic market valuation and temperature calculation engine."""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import UTC, date, datetime

from app.domain.models import (
    IndexQuote,
    IndustryFlow,
    MacroRateRow,
    MarketFeedBundle,
    MarketOverview,
    MarketTemperature,
    TemperatureLevel,
)

_BENCHMARK_INDEX_NAMES: dict[str, str] = {
    "000300": "沪深300",
}

_LEVEL_COMMENTS: dict[TemperatureLevel, str] = {
    TemperatureLevel.COLD: (
        "全市场估值处于近十年冰点区间，股债性价比显著偏向股票，具备充裕安全边际。"
    ),
    TemperatureLevel.COOL: "估值处于近十年偏低区间，股债性价比偏向股票，适合耐心分批布局。",
    TemperatureLevel.NEUTRAL: (
        "全市场估值处于近十年中枢附近，结构分化为主，宜精选标的严守安全边际。"
    ),
    TemperatureLevel.WARM: "全市场估值进入偏高区间，股债性价比走弱，需控制仓位并警惕估值透支。",
    TemperatureLevel.HOT: "全市场估值处于近十年过热区间，安全边际明显收敛，应严控回撤风险。",
}


def subtract_years(anchor: date, years: int) -> date:
    """Subtract calendar years safely, clamping Feb 29 to Feb 28 on non-leap years."""
    try:
        return anchor.replace(year=anchor.year - years)
    except ValueError:
        return anchor.replace(year=anchor.year - years, day=28)


def _classify_temperature(score: float) -> TemperatureLevel:
    if score < 20.0:
        return TemperatureLevel.COLD
    if score < 40.0:
        return TemperatureLevel.COOL
    if score < 60.0:
        return TemperatureLevel.NEUTRAL
    if score < 80.0:
        return TemperatureLevel.WARM
    return TemperatureLevel.HOT


def compute_market_temperature(
    as_of: date,
    history: Sequence[MacroRateRow],
    *,
    lookback_years: int = 10,
) -> MarketTemperature:
    """Compute market temperature from trailing macro yield and all-A median PE history."""
    cutoff = subtract_years(as_of, lookback_years)
    deduped_by_date: dict[date, MacroRateRow] = {}
    for row in history:
        if not (math.isfinite(row.market_pe_median) and math.isfinite(row.cn_10y_bond_yield)):
            raise ValueError(f"{row.trade_date.isoformat()} 存在非有限宏观估值数值")
        if row.market_pe_median <= 0:
            raise ValueError(f"{row.trade_date.isoformat()} 全市场 PE 中位数必须大于 0")
        if cutoff <= row.trade_date <= as_of:
            deduped_by_date[row.trade_date] = row

    if not deduped_by_date:
        raise ValueError(f"缺少 {as_of.isoformat()} 前 {lookback_years} 年内的有效宏观估值历史")

    ordered = [deduped_by_date[d] for d in sorted(deduped_by_date)]
    latest = ordered[-1]

    # Resample to 1 observation per calendar month so daily syncs do not outweigh older years.
    by_month: dict[tuple[int, int], MacroRateRow] = {}
    for row in ordered:
        by_month[(row.trade_date.year, row.trade_date.month)] = row
    sampled = list(by_month.values())
    if sampled[-1].trade_date != latest.trade_date:
        sampled.append(latest)

    ep = 100.0 / latest.market_pe_median
    equity_bond_spread = round(ep - latest.cn_10y_bond_yield, 2)

    pe_values = [row.market_pe_median for row in sampled]
    less_count = sum(1 for value in pe_values if value < latest.market_pe_median)
    equal_count = sum(1 for value in pe_values if value == latest.market_pe_median)
    pe_percentile = round(
        max(0.0, min(100.0, ((less_count + 0.5 * equal_count) / len(pe_values)) * 100.0)),
        1,
    )

    # Map spread [-1%, +4%] onto [100, 0] heat so negative spread raises market temperature.
    spread_heat = max(0.0, min(100.0, ((4.0 - equity_bond_spread) / 5.0) * 100.0))
    score = round(max(0.0, min(100.0, 0.70 * pe_percentile + 0.30 * spread_heat)), 1)
    level = _classify_temperature(score)

    return MarketTemperature(
        score=score,
        level=level,
        pe_median=round(latest.market_pe_median, 2),
        pe_percentile=pe_percentile,
        bond_yield=round(latest.cn_10y_bond_yield, 2),
        equity_bond_spread=equity_bond_spread,
        comment=_LEVEL_COMMENTS[level],
    )


def build_market_overview(
    bundle: MarketFeedBundle,
    macro_history: Sequence[MacroRateRow],
    generated_at: datetime | None = None,
) -> MarketOverview:
    """Assemble a persisted MarketOverview snapshot from a feed bundle and macro history."""
    temperature = compute_market_temperature(bundle.as_of, macro_history)
    deduped_flows: dict[str, int] = {}
    unique_flows: list[IndustryFlow] = []
    for flow in bundle.hot_industries:
        if flow.name not in deduped_flows:
            deduped_flows[flow.name] = len(unique_flows)
            unique_flows.append(flow)
    sorted_industries = sorted(unique_flows, key=lambda item: (-item.net_inflow, item.name))

    overview_codes = {q.code for q in bundle.indices}
    benchmark_indices: list[IndexQuote] = []
    seen_benchmarks: set[str] = set()
    for row in bundle.index_daily:
        if (
            row.trade_date == bundle.as_of
            and row.code in _BENCHMARK_INDEX_NAMES
            and row.code not in overview_codes
            and row.code not in seen_benchmarks
        ):
            seen_benchmarks.add(row.code)
            benchmark_indices.append(
                IndexQuote(
                    code=row.code,
                    name=_BENCHMARK_INDEX_NAMES[row.code],
                    price=row.close,
                    change_pct=row.change_pct,
                )
            )

    return MarketOverview(
        schema_version=1,
        as_of=bundle.as_of,
        data_source=bundle.data_source,
        generated_at=generated_at if generated_at is not None else datetime.now(UTC),
        indices=list(bundle.indices),
        benchmark_indices=benchmark_indices,
        temperature=temperature,
        hot_industries=sorted_industries,
        cross_asset=bundle.cross_asset,
    )
