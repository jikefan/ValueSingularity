"""Domain models — the API contract.

Every field here is part of the public contract; the web client mirrors these in
``apps/web/src/types/api.ts``. Keep them free of framework and storage details.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class TemperatureLevel(StrEnum):
    """A-share market temperature bucket, from cold to hot."""

    COLD = "cold"
    COOL = "cool"
    NEUTRAL = "neutral"
    WARM = "warm"
    HOT = "hot"


class IndexQuote(BaseModel):
    code: str
    name: str
    price: float
    change_pct: float = Field(description="涨跌幅，百分数（-1.2 表示 -1.2%）")


class MarketTemperature(BaseModel):
    score: float = Field(ge=0, le=100, description="0=冰点，100=过热")
    level: TemperatureLevel
    pe_median: float = Field(description="全市场 PE 中位数")
    pe_percentile: float = Field(ge=0, le=100, description="历史分位，百分数")
    bond_yield: float = Field(description="十年国债收益率，百分数")
    equity_bond_spread: float = Field(description="股债性价比（EP - 国债收益率），百分数")
    comment: str


class IndustryFlow(BaseModel):
    name: str
    change_pct: float
    net_inflow: float = Field(description="净流入，单位：元")
    companies: int = Field(ge=0)


class MarketOverview(BaseModel):
    generated_at: datetime
    indices: list[IndexQuote]
    temperature: MarketTemperature
    hot_industries: list[IndustryFlow]


class Health(BaseModel):
    status: str
    version: str
