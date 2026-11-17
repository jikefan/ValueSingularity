"""In-memory market repository.

Phase 0 fixture: lets the API contract and the web client be built and tested
before the akshare adapter lands. Replace with ``adapters/akshare`` later; the
service and routes do not change.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.domain.models import (
    IndexQuote,
    IndustryFlow,
    MarketOverview,
    MarketTemperature,
    TemperatureLevel,
)


class MemoryMarketRepository:
    def overview(self) -> MarketOverview:
        return MarketOverview(
            generated_at=datetime.now(UTC),
            indices=[
                IndexQuote(code="000001", name="上证指数", price=3218.42, change_pct=0.62),
                IndexQuote(code="399001", name="深证成指", price=10142.07, change_pct=0.91),
                IndexQuote(code="399006", name="创业板指", price=2071.55, change_pct=-0.24),
                IndexQuote(code="000688", name="科创50", price=1042.18, change_pct=1.35),
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
