"""Pure domain engine for Watchlist Strike-Zone Sentinel & Journal Falsify Radar."""

from __future__ import annotations

import hashlib
import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Literal
from uuid import UUID

from app.domain.engines._helpers import finite_or_none
from app.domain.models import (
    AnnualFinancialTrendPoint,
    FalsifyRule,
    JournalAction,
    JournalEntryItem,
    StockSnapshotPayload,
    TriggeredAlertCandidate,
    WatchlistItem,
)

_OP_SYMBOLS: dict[Literal["lt", "lte", "gt", "gte", "eq"], str] = {
    "lt": "<",
    "lte": "<=",
    "gt": ">",
    "gte": ">=",
    "eq": "=",
}

_ANNUAL_TREND_FIELDS: dict[str, str] = {
    "roe": "roe_pct",
    "roe_pct": "roe_pct",
    "净资产收益率": "roe_pct",
    "gross_margin": "gross_margin_pct",
    "gross_margin_pct": "gross_margin_pct",
    "毛利率": "gross_margin_pct",
    "net_margin": "net_margin_pct",
    "net_margin_pct": "net_margin_pct",
    "净利率": "net_margin_pct",
    "net_profit": "net_profit_yuan",
    "net_profit_yuan": "net_profit_yuan",
    "净利润": "net_profit_yuan",
    "归母净利润": "net_profit_yuan",
    "deduct_net_profit": "deduct_net_profit_yuan",
    "deduct_net_profit_yuan": "deduct_net_profit_yuan",
    "扣非净利润": "deduct_net_profit_yuan",
    "revenue": "revenue_yuan",
    "revenue_yuan": "revenue_yuan",
    "营业收入": "revenue_yuan",
    "营收": "revenue_yuan",
    "ocf": "ocf_yuan",
    "ocf_yuan": "ocf_yuan",
    "经营现金流": "ocf_yuan",
    "fcf": "fcf_yuan",
    "fcf_yuan": "fcf_yuan",
    "自由现金流": "fcf_yuan",
    "net_cash": "net_cash_yuan",
    "net_cash_yuan": "net_cash_yuan",
    "净现金": "net_cash_yuan",
    "rd_ratio": "rd_ratio_pct",
    "rd_ratio_pct": "rd_ratio_pct",
    "研发费用率": "rd_ratio_pct",
}


def _extract_dividend_yield(snap: StockSnapshotPayload) -> float | None:
    if snap.valuation.dividend_yield_pct is not None:
        return snap.valuation.dividend_yield_pct
    return snap.shareholder_return.current_dividend_yield_pct


def _extract_pe_percentile(snap: StockSnapshotPayload) -> float | None:
    if snap.valuation.pe_percentile_10y is not None:
        return snap.valuation.pe_percentile_10y
    return snap.valuation.pe_percentile_5y


def _extract_gross_margin_latest(snap: StockSnapshotPayload) -> float | None:
    if snap.moat.gross_margin_latest_pct is not None:
        return snap.moat.gross_margin_latest_pct
    for point in reversed(snap.annual_trends):
        if point.gross_margin_pct is not None:
            return point.gross_margin_pct
    return None


_SCALAR_EXTRACTORS: dict[str, Callable[[StockSnapshotPayload], float | int | None]] = {
    "ct_red_count": lambda s: s.financial_ct.red_count,
    "ct_red": lambda s: s.financial_ct.red_count,
    "red_count": lambda s: s.financial_ct.red_count,
    "financial_ct.red_count": lambda s: s.financial_ct.red_count,
    "排雷红灯": lambda s: s.financial_ct.red_count,
    "红灯数": lambda s: s.financial_ct.red_count,
    "ct红灯": lambda s: s.financial_ct.red_count,
    "ct_yellow_count": lambda s: s.financial_ct.yellow_count,
    "ct_yellow": lambda s: s.financial_ct.yellow_count,
    "yellow_count": lambda s: s.financial_ct.yellow_count,
    "financial_ct.yellow_count": lambda s: s.financial_ct.yellow_count,
    "排雷黄灯": lambda s: s.financial_ct.yellow_count,
    "黄灯数": lambda s: s.financial_ct.yellow_count,
    "ct黄灯": lambda s: s.financial_ct.yellow_count,
    "pe_ttm": lambda s: s.valuation.pe_ttm,
    "pe": lambda s: s.valuation.pe_ttm,
    "valuation.pe_ttm": lambda s: s.valuation.pe_ttm,
    "市盈率": lambda s: s.valuation.pe_ttm,
    "动态市盈率": lambda s: s.valuation.pe_ttm,
    "pe_percentile_10y": _extract_pe_percentile,
    "pe_percentile": _extract_pe_percentile,
    "valuation.pe_percentile_10y": _extract_pe_percentile,
    "pe分位": _extract_pe_percentile,
    "市盈率分位": _extract_pe_percentile,
    "pe_percentile_5y": lambda s: s.valuation.pe_percentile_5y,
    "pb": lambda s: s.valuation.pb,
    "valuation.pb": lambda s: s.valuation.pb,
    "市净率": lambda s: s.valuation.pb,
    "pb_percentile_10y": lambda s: s.valuation.pb_percentile_10y,
    "pb_percentile": lambda s: s.valuation.pb_percentile_10y,
    "市净率分位": lambda s: s.valuation.pb_percentile_10y,
    "close": lambda s: s.valuation.close,
    "price": lambda s: s.valuation.close,
    "valuation.close": lambda s: s.valuation.close,
    "收盘价": lambda s: s.valuation.close,
    "现价": lambda s: s.valuation.close,
    "股价": lambda s: s.valuation.close,
    "dividend_yield_pct": _extract_dividend_yield,
    "dividend_yield": _extract_dividend_yield,
    "valuation.dividend_yield_pct": _extract_dividend_yield,
    "股息率": _extract_dividend_yield,
    "implied_fcf_cagr_pct": lambda s: s.reverse_dcf.implied_fcf_cagr_pct,
    "implied_fcf_cagr": lambda s: s.reverse_dcf.implied_fcf_cagr_pct,
    "reverse_dcf.implied_fcf_cagr_pct": lambda s: s.reverse_dcf.implied_fcf_cagr_pct,
    "隐含增速": lambda s: s.reverse_dcf.implied_fcf_cagr_pct,
    "隐含fcf增速": lambda s: s.reverse_dcf.implied_fcf_cagr_pct,
    "roe_5y_avg_pct": lambda s: s.moat.roe_5y_avg_pct,
    "roe_5y_avg": lambda s: s.moat.roe_5y_avg_pct,
    "moat.roe_5y_avg_pct": lambda s: s.moat.roe_5y_avg_pct,
    "roe5年均值": lambda s: s.moat.roe_5y_avg_pct,
    "5年平均roe": lambda s: s.moat.roe_5y_avg_pct,
    "gross_margin_latest_pct": _extract_gross_margin_latest,
    "moat.gross_margin_latest_pct": _extract_gross_margin_latest,
    "net_cash_to_mv_pct": lambda s: s.peer_metrics.net_cash_to_mv_pct,
    "net_cash_to_mv": lambda s: s.peer_metrics.net_cash_to_mv_pct,
    "peer_metrics.net_cash_to_mv_pct": lambda s: s.peer_metrics.net_cash_to_mv_pct,
    "净现金市值比": lambda s: s.peer_metrics.net_cash_to_mv_pct,
    "ocf_to_profit_5y_pct": lambda s: s.peer_metrics.ocf_to_profit_5y_pct,
    "ocf_to_profit": lambda s: s.peer_metrics.ocf_to_profit_5y_pct,
    "peer_metrics.ocf_to_profit_5y_pct": lambda s: s.peer_metrics.ocf_to_profit_5y_pct,
    "净现比": lambda s: s.peer_metrics.ocf_to_profit_5y_pct,
    "现金流利润比": lambda s: s.peer_metrics.ocf_to_profit_5y_pct,
    "pledge_ratio_pct": lambda s: s.pledge_ratio_pct,
    "pledge_ratio": lambda s: s.pledge_ratio_pct,
    "质押率": lambda s: s.pledge_ratio_pct,
    "股权质押率": lambda s: s.pledge_ratio_pct,
    "total_score": lambda s: s.radar.total_score,
    "score": lambda s: s.radar.total_score,
    "radar.total_score": lambda s: s.radar.total_score,
    "综合评分": lambda s: s.radar.total_score,
    "雷达评分": lambda s: s.radar.total_score,
    "shareholder_yield_pct": lambda s: s.peer_metrics.shareholder_yield_pct,
    "shareholder_yield": lambda s: s.peer_metrics.shareholder_yield_pct,
    "股东回报率": lambda s: s.peer_metrics.shareholder_yield_pct,
    "fcf_coverage_ratio": lambda s: s.shareholder_return.fcf_coverage_ratio,
    "自由现金流覆盖倍数": lambda s: s.shareholder_return.fcf_coverage_ratio,
    "revenue_cagr_3y_pct": lambda s: s.growth.revenue_cagr_3y_pct,
    "revenue_cagr_5y_pct": lambda s: s.growth.revenue_cagr_5y_pct,
    "profit_cagr_5y_pct": lambda s: s.growth.profit_cagr_5y_pct,
}

_ANNUAL_FALLBACK_SCALAR: dict[str, Callable[[StockSnapshotPayload], float | None]] = {
    "roe_pct": lambda s: s.moat.roe_5y_avg_pct,
    "gross_margin_pct": lambda s: s.moat.gross_margin_latest_pct,
}


@dataclass(frozen=True, slots=True)
class SentinelEvaluationResult:
    evaluated_rules: int
    candidates: list[TriggeredAlertCandidate]


def _normalize_metric_key(metric: str) -> str:
    return metric.strip().lower().replace("-", "_").replace(" ", "_")


def _compare(actual: float, op: Literal["lt", "lte", "gt", "gte", "eq"], target: float) -> bool:
    if not (math.isfinite(actual) and math.isfinite(target)):
        return False
    if op == "lt":
        return actual < target
    if op == "lte":
        return actual <= target
    if op == "gt":
        return actual > target
    if op == "gte":
        return actual >= target
    return math.isclose(actual, target, rel_tol=1e-9, abs_tol=1e-9)


def _canonical_num(value: float) -> str:
    if not math.isfinite(value):
        return "NaN"
    if value == 0:
        return "0"
    try:
        dec = Decimal(str(value)).normalize()
        if abs(dec.adjusted()) > 18:
            return repr(value)
        rendered = format(dec, "f")
    except (InvalidOperation, ValueError):
        return repr(value)
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return "0" if rendered in {"", "-0"} else rendered


def _format_num(value: float) -> str:
    if not math.isfinite(value):
        return "N/A"
    if value == 0:
        return "0"
    if abs(value) < 0.0001:
        return _canonical_num(value)
    if abs(value) < 10 or not math.isclose(value, round(value, 2), rel_tol=0.0, abs_tol=1e-6):
        rendered = f"{value:.4f}".rstrip("0").rstrip(".")
    else:
        rendered = f"{value:.2f}".rstrip("0").rstrip(".")
    return "0" if rendered in {"", "-0"} else rendered


def _ordered_annual_points(
    trends: Sequence[AnnualFinancialTrendPoint],
) -> list[AnnualFinancialTrendPoint]:
    by_year: dict[int, AnnualFinancialTrendPoint] = {p.year: p for p in trends}
    return [by_year[year] for year in sorted(by_year)]


def _evaluate_single_rule(
    rule: FalsifyRule,
    snapshot: StockSnapshotPayload,
) -> tuple[str, str] | None:
    raw_key = rule.metric.strip().lower()
    norm_key = _normalize_metric_key(rule.metric)
    op_symbol = _OP_SYMBOLS[rule.op]

    annual_field = _ANNUAL_TREND_FIELDS.get(raw_key) or _ANNUAL_TREND_FIELDS.get(norm_key)
    if annual_field is not None:
        ordered = _ordered_annual_points(snapshot.annual_trends)
        if len(ordered) >= rule.periods:
            window = ordered[-rule.periods :]
            is_consecutive = all(
                window[i].year == window[i - 1].year + 1 for i in range(1, len(window))
            )
            if not is_consecutive:
                return None
            values: list[float] = []
            for point in window:
                val = getattr(point, annual_field)
                if val is None or not math.isfinite(float(val)):
                    return None
                values.append(float(val))
            if all(_compare(val, rule.op, rule.value) for val in values):
                latest_val = values[-1]
                val_text = _format_num(rule.value)
                canonical = (
                    f"rule:{annual_field}:{rule.op}:{_canonical_num(rule.value)}:{rule.periods}"
                )
                if rule.periods > 1:
                    text = (
                        f"{rule.metric} 连续 {rule.periods} 年 {op_symbol} "
                        f"{val_text} (最近 {_format_num(latest_val)})"
                    )
                else:
                    text = f"{rule.metric} {op_symbol} {val_text} (当前 {_format_num(latest_val)})"
                return text, canonical
            return None

        if rule.periods > 1:
            return None

        fallback_fn = _ANNUAL_FALLBACK_SCALAR.get(annual_field)
        if fallback_fn is None:
            return None
        fallback_val = fallback_fn(snapshot)
        if fallback_val is None or not math.isfinite(fallback_val):
            return None
        if _compare(float(fallback_val), rule.op, rule.value):
            canonical = f"rule:{annual_field}:{rule.op}:{_canonical_num(rule.value)}:1"
            text = (
                f"{rule.metric} {op_symbol} {_format_num(rule.value)} "
                f"(当前 {_format_num(float(fallback_val))})"
            )
            return text, canonical
        return None

    # Scalar extractors evaluate only the latest snapshot and never synthesize multi-period series.
    if rule.periods > 1:
        return None
    extractor = _SCALAR_EXTRACTORS.get(raw_key) or _SCALAR_EXTRACTORS.get(norm_key)
    if extractor is None:
        return None
    raw_val = extractor(snapshot)
    if raw_val is None or not math.isfinite(float(raw_val)):
        return None
    actual = float(raw_val)
    if _compare(actual, rule.op, rule.value):
        canonical_key = norm_key or raw_key
        canonical = f"rule:{canonical_key}:{rule.op}:{_canonical_num(rule.value)}:1"
        text = f"{rule.metric} {op_symbol} {_format_num(rule.value)} (当前 {_format_num(actual)})"
        return text, canonical
    return None


def _evaluate_entry_falsify_details(
    entry: JournalEntryItem,
    snapshot: StockSnapshotPayload | None,
) -> list[tuple[str, str]]:
    if snapshot is None:
        return []
    details: list[tuple[str, str]] = []
    for rule in entry.falsify_rules or ():
        matched = _evaluate_single_rule(rule, snapshot)
        if matched is not None:
            details.append(matched)

    if entry.snapshot is not None and entry.snapshot.ct_red_count is not None:
        baseline_red = max(0, entry.snapshot.ct_red_count)
        if snapshot.financial_ct.red_count > baseline_red:
            details.append(
                (
                    f"排雷红灯增加 ({baseline_red} -> {snapshot.financial_ct.red_count})",
                    f"ct_red_gt:{baseline_red}",
                )
            )
    return details


def evaluate_entry_falsify(
    entry: JournalEntryItem,
    snapshot: StockSnapshotPayload | None,
) -> list[str]:
    """Evaluate structured falsify rules and baseline CT deterioration for one journal entry."""
    return [text for text, _ in _evaluate_entry_falsify_details(entry, snapshot)]


def _active_holding_entries(entries: Sequence[JournalEntryItem]) -> list[JournalEntryItem]:
    by_code: dict[str, list[JournalEntryItem]] = {}
    for entry in entries:
        by_code.setdefault(entry.code, []).append(entry)

    active_all: list[JournalEntryItem] = []
    for code in sorted(by_code):
        chronological = sorted(by_code[code], key=lambda item: (item.created_at, item.id))
        active_for_code: list[JournalEntryItem] = []
        for entry in chronological:
            if entry.action in {JournalAction.BUY, JournalAction.ADD}:
                active_for_code.append(entry)
            elif entry.action == JournalAction.SELL:
                active_for_code.clear()
        active_all.extend(active_for_code)
    return active_all


def _signature_digest(keys: Sequence[str]) -> str:
    joined = "|".join(sorted(keys))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:12]


def _evaluate_watchlist_item(
    user_id: UUID,
    item: WatchlistItem,
    snapshot: StockSnapshotPayload,
) -> tuple[int, TriggeredAlertCandidate | None]:
    rules_checked = 0
    matched_texts: list[str] = []
    canonical_keys: list[str] = []

    current_price = finite_or_none(snapshot.valuation.close)
    current_pe_pct = finite_or_none(_extract_pe_percentile(snapshot))
    current_div_yield = finite_or_none(_extract_dividend_yield(snapshot))

    if item.target_price is not None:
        rules_checked += 1
        if (
            current_price is not None
            and math.isfinite(item.target_price)
            and current_price <= item.target_price
        ):
            matched_texts.append(
                f"现价 {_format_num(current_price)} <= 目标价 {_format_num(item.target_price)}"
            )
            canonical_keys.append(f"price<={_canonical_num(item.target_price)}")

    if item.target_pe_percentile is not None:
        rules_checked += 1
        if (
            current_pe_pct is not None
            and math.isfinite(item.target_pe_percentile)
            and current_pe_pct <= item.target_pe_percentile
        ):
            target_pe_text = _format_num(item.target_pe_percentile)
            matched_texts.append(f"PE分位 {_format_num(current_pe_pct)}% <= 目标 {target_pe_text}%")
            canonical_keys.append(f"pe_pct<={_canonical_num(item.target_pe_percentile)}")

    if item.target_dividend_yield is not None:
        rules_checked += 1
        if (
            current_div_yield is not None
            and math.isfinite(item.target_dividend_yield)
            and current_div_yield >= item.target_dividend_yield
        ):
            target_div_text = _format_num(item.target_dividend_yield)
            matched_texts.append(
                f"股息率 {_format_num(current_div_yield)}% >= 目标 {target_div_text}%"
            )
            canonical_keys.append(f"div_yield>={_canonical_num(item.target_dividend_yield)}")

    if not matched_texts:
        return rules_checked, None

    stock_name = item.name or snapshot.name
    rule_signature = f"wl:{_signature_digest(canonical_keys)}"
    candidate = TriggeredAlertCandidate(
        user_id=user_id,
        source_type="watchlist_sentinel",
        code=item.code,
        stock_name=stock_name,
        trigger_date=snapshot.as_of,
        rule_signature=rule_signature,
        matched_conditions=matched_texts,
        detail=f"{stock_name}({item.code}) 命中自选击球区: {'；'.join(matched_texts)}",
        current_price=current_price,
        current_pe_percentile=current_pe_pct,
        current_dividend_yield_pct=current_div_yield,
    )
    return rules_checked, candidate


def evaluate_user_alerts(
    user_id: UUID,
    watchlist: Sequence[WatchlistItem],
    journal_entries: Sequence[JournalEntryItem],
    snapshots_by_code: Mapping[str, StockSnapshotPayload],
) -> SentinelEvaluationResult:
    """Evaluate watchlist strike-zone rules and active holding falsify conditions."""
    evaluated_rules = 0
    candidates: list[TriggeredAlertCandidate] = []

    for item in watchlist:
        if not item.alert_enabled:
            continue
        snapshot = snapshots_by_code.get(item.code)
        if snapshot is None:
            continue
        checked, candidate = _evaluate_watchlist_item(user_id, item, snapshot)
        evaluated_rules += checked
        if candidate is not None:
            candidates.append(candidate)

    for entry in _active_holding_entries(journal_entries):
        snapshot = snapshots_by_code.get(entry.code)
        if snapshot is None:
            continue
        rule_count = len(entry.falsify_rules or ())
        if entry.snapshot is not None and entry.snapshot.ct_red_count is not None:
            rule_count += 1
        evaluated_rules += rule_count

        details = _evaluate_entry_falsify_details(entry, snapshot)
        if not details:
            continue

        matched_texts = [text for text, _ in details]
        canonical_keys = [key for _, key in details]
        stock_name = entry.name or snapshot.name
        rule_signature = f"jf:{entry.id}:{_signature_digest(canonical_keys)}"
        candidates.append(
            TriggeredAlertCandidate(
                user_id=user_id,
                source_type="journal_falsify",
                code=entry.code,
                stock_name=stock_name,
                trigger_date=snapshot.as_of,
                rule_signature=rule_signature,
                matched_conditions=matched_texts,
                detail=f"{stock_name}({entry.code}) 触发持仓否证红线: {'；'.join(matched_texts)}",
                current_price=finite_or_none(snapshot.valuation.close),
                current_pe_percentile=finite_or_none(_extract_pe_percentile(snapshot)),
                current_dividend_yield_pct=finite_or_none(_extract_dividend_yield(snapshot)),
            )
        )

    return SentinelEvaluationResult(evaluated_rules=evaluated_rules, candidates=candidates)
