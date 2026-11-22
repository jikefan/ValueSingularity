"""In-memory market repository.

Used as a fast, deterministic test double for API contract tests and local
unit tests without requiring PostgreSQL or network access.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from app.domain.errors import MarketSnapshotUnavailableError
from app.domain.models import (
    IndexQuote,
    IndustryFlow,
    MarketOverview,
    MarketTemperature,
    TemperatureLevel,
)


def default_market_overview() -> MarketOverview:
    return MarketOverview(
        schema_version=1,
        as_of=date(2026, 11, 18),
        data_source="memory",
        generated_at=datetime.now(UTC),
        indices=[
            IndexQuote(code="000001", name="上证指数", price=3218.42, change_pct=0.62),
            IndexQuote(code="399001", name="深证成指", price=10142.07, change_pct=0.91),
            IndexQuote(code="399006", name="创业板指", price=2071.55, change_pct=-0.24),
            IndexQuote(code="000688", name="科创50", price=1042.18, change_pct=1.35),
        ],
        benchmark_indices=[
            IndexQuote(code="000300", name="沪深300", price=3980.0, change_pct=0.52),
        ],
        temperature=MarketTemperature(
            score=38.0,
            level=TemperatureLevel.COOL,
            pe_median=24.6,
            pe_percentile=31.0,
            bond_yield=2.18,
            equity_bond_spread=1.89,
            comment="估值处于近十年偏低区间，股债性价比偏向股票，但成交未放量。",
        ),
        hot_industries=[
            IndustryFlow(name="半导体", change_pct=2.41, net_inflow=3.12e9, companies=168),
            IndustryFlow(name="电力设备", change_pct=1.77, net_inflow=2.05e9, companies=312),
            IndustryFlow(name="医药生物", change_pct=1.02, net_inflow=8.4e8, companies=421),
            IndustryFlow(name="银行", change_pct=-0.35, net_inflow=-6.1e8, companies=42),
        ],
    )


class MemoryMarketRepository:
    def __init__(
        self,
        initial: MarketOverview | None = None,
        *,
        allow_missing: bool = False,
    ) -> None:
        self._snapshot: MarketOverview | None = (
            initial if initial is not None or allow_missing else default_market_overview()
        )

    async def overview(self) -> MarketOverview:
        if self._snapshot is None:
            raise MarketSnapshotUnavailableError()
        return self._snapshot

    async def save_overview(self, snapshot: MarketOverview) -> None:
        self._snapshot = snapshot
