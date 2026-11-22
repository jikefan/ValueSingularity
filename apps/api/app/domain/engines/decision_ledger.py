"""Pure domain engine for Decision Time Capsule comparison & CSI 300 Beta attribution."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime

from app.domain.engines._helpers import finite_or_none
from app.domain.engines.sentinel_radar import evaluate_entry_falsify
from app.domain.models import (
    ActionLedgerRow,
    DecisionLedgerReport,
    EmotionLedgerRow,
    JournalAction,
    JournalEntryComparison,
    JournalEntryItem,
    StockSnapshotPayload,
)

_ACTION_ORDER: tuple[JournalAction, ...] = (
    JournalAction.BUY,
    JournalAction.ADD,
    JournalAction.TRIM,
    JournalAction.SELL,
    JournalAction.PASS,
)
_BULLISH_ACTIONS = frozenset({JournalAction.BUY, JournalAction.ADD})


def _ensure_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def _compute_return_pct(entry_val: float | None, current_val: float | None) -> float | None:
    if entry_val is None or current_val is None or entry_val <= 0 or current_val <= 0:
        return None
    return finite_or_none(((current_val - entry_val) / entry_val) * 100.0, 2)


def _is_entry_win(
    action: JournalAction,
    stock_return_pct: float | None,
    excess_return_pct: float | None,
) -> bool:
    if stock_return_pct is None:
        return False
    metric = excess_return_pct if excess_return_pct is not None else stock_return_pct
    if action in _BULLISH_ACTIONS:
        return metric > 0
    return metric < 0


def _aggregate_stats(
    rows: Sequence[tuple[JournalEntryComparison, bool]],
) -> tuple[int, int, int, float | None, float | None, float | None]:
    total_count = len(rows)
    comparable = [item for item, _ in rows if item.stock_return_pct is not None]
    comparable_count = len(comparable)
    win_count = sum(1 for item, won in rows if item.stock_return_pct is not None and won)

    win_rate_pct = (
        finite_or_none((win_count / comparable_count) * 100.0, 1) if comparable_count > 0 else None
    )
    stock_returns = [
        item.stock_return_pct for item in comparable if item.stock_return_pct is not None
    ]
    avg_stock_return_pct = (
        finite_or_none(sum(stock_returns) / len(stock_returns), 2) if stock_returns else None
    )
    excess_returns = [
        item.excess_return_pct for item in comparable if item.excess_return_pct is not None
    ]
    avg_excess_return_pct = (
        finite_or_none(sum(excess_returns) / len(excess_returns), 2) if excess_returns else None
    )
    return (
        total_count,
        comparable_count,
        win_count,
        win_rate_pct,
        avg_stock_return_pct,
        avg_excess_return_pct,
    )


def build_decision_ledger(
    entries: Sequence[JournalEntryItem],
    snapshots_by_code: Mapping[str, StockSnapshotPayload],
    *,
    current_benchmark_price: float | None,
    benchmark_as_of: date | None,
    benchmark_code: str = "000300",
    reference_now: datetime | None = None,
) -> DecisionLedgerReport:
    """Build decision quality ledger attributing stock returns against CSI 300 Beta."""
    ref_utc = _ensure_utc(reference_now) if reference_now is not None else datetime.now(UTC)
    sanitized_bench = finite_or_none(current_benchmark_price)
    if sanitized_bench is not None and sanitized_bench <= 0:
        sanitized_bench = None

    ordered_entries = sorted(
        entries,
        key=lambda item: (_ensure_utc(item.created_at), item.id),
        reverse=True,
    )

    scored_rows: list[tuple[JournalEntryComparison, bool]] = []
    by_emotion_buckets: dict[str, list[tuple[JournalEntryComparison, bool]]] = {}
    by_action_buckets: dict[JournalAction, list[tuple[JournalEntryComparison, bool]]] = {}
    pass_count = 0
    pass_avoided_loss_count = 0

    for entry in ordered_entries:
        snap = snapshots_by_code.get(entry.code)
        capsule = entry.snapshot

        raw_entry_price = (
            entry.price
            if entry.price is not None
            else (capsule.close if capsule is not None else None)
        )
        entry_price = finite_or_none(raw_entry_price)
        current_price = finite_or_none(snap.valuation.close if snap is not None else None)
        stock_return_pct = _compute_return_pct(entry_price, current_price)

        entry_benchmark_price = finite_or_none(
            entry.benchmark_price
            if entry.benchmark_price is not None
            else (capsule.benchmark_price if capsule is not None else None)
        )
        entry_current_benchmark = (
            sanitized_bench if entry.benchmark_code == benchmark_code else None
        )
        benchmark_return_pct = _compute_return_pct(entry_benchmark_price, entry_current_benchmark)
        excess_return_pct = (
            finite_or_none(stock_return_pct - benchmark_return_pct, 2)
            if stock_return_pct is not None and benchmark_return_pct is not None
            else None
        )

        entry_dt = _ensure_utc(entry.created_at)
        days_held = max(0, (ref_utc.date() - entry_dt.date()).days)
        triggers = evaluate_entry_falsify(entry, snap)

        comparison = JournalEntryComparison(
            id=entry.id,
            code=entry.code,
            name=entry.name or (snap.name if snap is not None else None),
            action=entry.action,
            emotion=entry.emotion,
            created_at=entry.created_at,
            entry_price=entry_price,
            current_price=current_price,
            stock_return_pct=stock_return_pct,
            entry_benchmark_price=entry_benchmark_price,
            current_benchmark_price=entry_current_benchmark,
            benchmark_return_pct=benchmark_return_pct,
            excess_return_pct=excess_return_pct,
            entry_pe_ttm=finite_or_none(capsule.pe_ttm if capsule is not None else None),
            current_pe_ttm=finite_or_none(snap.valuation.pe_ttm if snap is not None else None),
            entry_score=capsule.total_score if capsule is not None else None,
            current_score=snap.radar.total_score if snap is not None else None,
            days_held=days_held,
            falsify_triggered=bool(triggers),
            falsify_triggers=triggers,
        )

        won = _is_entry_win(entry.action, stock_return_pct, excess_return_pct)
        row_pair = (comparison, won)
        scored_rows.append(row_pair)

        emotion_label = (entry.emotion or "").strip() or "未标注"
        by_emotion_buckets.setdefault(emotion_label, []).append(row_pair)
        by_action_buckets.setdefault(entry.action, []).append(row_pair)

        if entry.action == JournalAction.PASS:
            pass_count += 1
            if stock_return_pct is not None and stock_return_pct < 0:
                pass_avoided_loss_count += 1

    (
        total_entries,
        comparable_count,
        win_count,
        win_rate_pct,
        avg_stock_return_pct,
        avg_excess_return_pct,
    ) = _aggregate_stats(scored_rows)

    emotion_rows: list[EmotionLedgerRow] = []
    for emotion_label, bucket in by_emotion_buckets.items():
        tot, comp, wins, win_rate, avg_stk, avg_exc = _aggregate_stats(bucket)
        emotion_rows.append(
            EmotionLedgerRow(
                emotion=emotion_label,
                total_count=tot,
                comparable_count=comp,
                win_count=wins,
                win_rate_pct=win_rate,
                avg_stock_return_pct=avg_stk,
                avg_excess_return_pct=avg_exc,
            )
        )
    emotion_rows.sort(key=lambda r: (-r.total_count, r.emotion))

    action_rows: list[ActionLedgerRow] = []
    for action in _ACTION_ORDER:
        action_bucket = by_action_buckets.get(action)
        if not action_bucket:
            continue
        tot, comp, wins, win_rate, avg_stk, avg_exc = _aggregate_stats(action_bucket)
        action_rows.append(
            ActionLedgerRow(
                action=action,
                total_count=tot,
                comparable_count=comp,
                win_count=wins,
                win_rate_pct=win_rate,
                avg_stock_return_pct=avg_stk,
                avg_excess_return_pct=avg_exc,
            )
        )

    return DecisionLedgerReport(
        total_entries=total_entries,
        comparable_count=comparable_count,
        win_count=win_count,
        win_rate_pct=win_rate_pct,
        avg_stock_return_pct=avg_stock_return_pct,
        avg_excess_return_pct=avg_excess_return_pct,
        pass_count=pass_count,
        pass_avoided_loss_count=pass_avoided_loss_count,
        current_benchmark_code=benchmark_code,
        current_benchmark_price=sanitized_bench,
        benchmark_as_of=benchmark_as_of,
        by_emotion=emotion_rows,
        by_action=action_rows,
        items=[item for item, _ in scored_rows],
    )
