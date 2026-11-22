"""Journal service — orchestration only, no SQL or HTTP details."""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import date
from uuid import UUID

from app.domain.engines import build_decision_ledger
from app.domain.errors import JournalEntryNotFoundError, MarketSnapshotUnavailableError
from app.domain.models import (
    DecisionLedgerReport,
    IndexQuote,
    JournalAction,
    JournalCreate,
    JournalEntryItem,
    JournalTimeCapsule,
    MarketOverview,
    StockSnapshotPayload,
    UserEventCreate,
)
from app.domain.ports import (
    JournalRepository,
    MarketRepository,
    StockMetaRepository,
    StockSnapshotRepository,
)

_BENCHMARK_CODE = "000300"


def _find_benchmark_quote(overview: MarketOverview | None, code: str) -> IndexQuote | None:
    if overview is None:
        return None
    for quote in overview.benchmark_indices:
        if quote.code == code:
            return quote
    for quote in overview.indices:
        if quote.code == code:
            return quote
    return None


def _valid_journal_price(value: float | None) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    if 0.001 <= value <= 999_999_999.999:
        return float(value)
    return None


def _build_time_capsule(
    stock_snap: StockSnapshotPayload | None,
    *,
    overview_as_of: date | None,
    benchmark_code: str,
    benchmark_price: float | None,
    benchmark_as_of: date | None = None,
) -> JournalTimeCapsule:
    if stock_snap is None:
        return JournalTimeCapsule(
            as_of=overview_as_of,
            benchmark_code=benchmark_code,
            benchmark_price=benchmark_price,
            benchmark_as_of=benchmark_as_of,
        )

    pe_pct = (
        stock_snap.valuation.pe_percentile_10y
        if stock_snap.valuation.pe_percentile_10y is not None
        else stock_snap.valuation.pe_percentile_5y
    )
    div_yield = (
        stock_snap.valuation.dividend_yield_pct
        if stock_snap.valuation.dividend_yield_pct is not None
        else stock_snap.shareholder_return.current_dividend_yield_pct
    )
    return JournalTimeCapsule(
        as_of=stock_snap.as_of,
        close=stock_snap.valuation.close,
        pe_ttm=stock_snap.valuation.pe_ttm,
        pe_percentile_10y=pe_pct,
        pb=stock_snap.valuation.pb,
        dividend_yield_pct=div_yield,
        implied_fcf_cagr_pct=stock_snap.reverse_dcf.implied_fcf_cagr_pct,
        roe_5y_avg_pct=stock_snap.moat.roe_5y_avg_pct,
        ct_red_count=stock_snap.financial_ct.red_count,
        ct_yellow_count=stock_snap.financial_ct.yellow_count,
        total_score=stock_snap.radar.total_score,
        benchmark_code=benchmark_code,
        benchmark_price=benchmark_price,
        benchmark_as_of=benchmark_as_of,
    )


class JournalService:
    def __init__(
        self,
        repository: JournalRepository,
        stock_meta: StockMetaRepository | None = None,
        snapshot_repo: StockSnapshotRepository | None = None,
        market_repo: MarketRepository | None = None,
        *,
        record_audit_event: bool = True,
    ) -> None:
        self._repository = repository
        self._stock_meta = stock_meta
        self._snapshot_repo = snapshot_repo
        self._market_repo = market_repo
        self._record_audit_event = record_audit_event

    async def list(
        self,
        user_id: UUID,
        *,
        code: str | None = None,
        actions: Sequence[JournalAction] | None = None,
        limit: int = 50,
    ) -> list[JournalEntryItem]:
        return await self._repository.list(user_id, code=code, actions=actions, limit=limit)

    async def create(self, user_id: UUID, payload: JournalCreate) -> JournalEntryItem:
        stock_snap: StockSnapshotPayload | None = None
        if self._snapshot_repo is not None:
            stock_snap = await self._snapshot_repo.get_snapshot(payload.code)

        market_overview: MarketOverview | None = None
        if self._market_repo is not None:
            try:
                market_overview = await self._market_repo.overview()
            except MarketSnapshotUnavailableError:
                market_overview = None

        bench_quote = _find_benchmark_quote(market_overview, payload.benchmark_code)

        updates: dict[str, object] = {}
        if payload.name is None:
            resolved_name: str | None = None
            if self._stock_meta is not None:
                resolved_name = await self._stock_meta.get_name(payload.code)
            if resolved_name is None and stock_snap is not None:
                resolved_name = stock_snap.name
            if resolved_name is not None:
                updates["name"] = resolved_name

        if payload.price is None and stock_snap is not None:
            auto_price = _valid_journal_price(stock_snap.valuation.close)
            if auto_price is not None:
                updates["price"] = auto_price

        auto_bench_filled = False
        if payload.benchmark_price is None and bench_quote is not None:
            auto_bench = _valid_journal_price(bench_quote.price)
            if auto_bench is not None:
                updates["benchmark_price"] = auto_bench
                auto_bench_filled = True

        effective_payload = payload.model_copy(update=updates) if updates else payload

        overview_as_of = market_overview.as_of if market_overview is not None else None
        capsule: JournalTimeCapsule | None = None
        if stock_snap is not None or bench_quote is not None:
            capsule = _build_time_capsule(
                stock_snap,
                overview_as_of=overview_as_of,
                benchmark_code=effective_payload.benchmark_code,
                benchmark_price=effective_payload.benchmark_price,
                benchmark_as_of=overview_as_of if auto_bench_filled else None,
            )

        audit_event = (
            UserEventCreate(
                type="journal_created",
                code=effective_payload.code,
                meta={"action": effective_payload.action.value},
            )
            if self._record_audit_event
            else None
        )
        return await self._repository.create(
            user_id,
            effective_payload,
            snapshot=capsule,
            audit_event=audit_event,
        )

    async def ledger(self, user_id: UUID, *, limit: int = 200) -> DecisionLedgerReport:
        entries = await self._repository.list(user_id, limit=limit)
        codes = list(dict.fromkeys(entry.code for entry in entries))
        snapshots_by_code = (
            await self._snapshot_repo.get_snapshots_for_compare(codes)
            if self._snapshot_repo is not None and codes
            else {}
        )

        market_overview: MarketOverview | None = None
        if self._market_repo is not None:
            try:
                market_overview = await self._market_repo.overview()
            except MarketSnapshotUnavailableError:
                market_overview = None

        bench_quote = _find_benchmark_quote(market_overview, _BENCHMARK_CODE)
        return build_decision_ledger(
            entries,
            snapshots_by_code,
            current_benchmark_price=bench_quote.price if bench_quote is not None else None,
            benchmark_as_of=market_overview.as_of if market_overview is not None else None,
            benchmark_code=_BENCHMARK_CODE,
        )

    async def remove(self, user_id: UUID, entry_id: int) -> None:
        if not await self._repository.remove(user_id, entry_id):
            raise JournalEntryNotFoundError(entry_id)


__all__ = ["JournalEntryNotFoundError", "JournalService"]
