from __future__ import annotations

import json
import logging
import socket
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any
from uuid import uuid4

import httpx
import pytest

from app.adapters.llm.openai_compatible import OpenAiCompatibleLlmAdapter
from app.domain.engines import (
    COMPLIANCE_NOTICE,
    build_deterministic_challenges,
    build_stock_snapshot,
    collect_allowed_snapshot_numbers,
    compute_accounting_metric_shifts,
    compute_text_mda_diff,
    contains_forbidden_advice,
    trim_snapshot_context,
    verify_llm_challenges,
    verify_mda_summary,
)
from app.domain.models import (
    AuthenticatedUser,
    CitedMetricFact,
    DevilsAdvocateChallenge,
    DevilsAdvocateRequest,
    FalsifyRule,
    JournalAction,
    MdaDiffHighlight,
    MdaDiffRequest,
    MdaMetricShift,
    PlanTier,
    StockAnnualReport,
    StockDailyBar,
    StockDetail,
    StockDividendRecord,
    StockEquityFinancingRecord,
    StockFactBundle,
    StockMetaRecord,
    StockPledgeSnapshot,
    StockRepurchaseRecord,
    StockSnapshotPayload,
    StoredAiConfig,
    UserEventCreate,
    UserEventItem,
)
from app.domain.url_safety import mask_secret, validate_public_http_url
from app.services.ai import AiPartnerService


def _build_eval_snapshot(
    *,
    code: str = "600519",
    name: str = "测试龙头",
    exchange: str = "SH",
    industry_sw1: str | None = "食品饮料",
    as_of: date = date(2026, 11, 20),
    close: float = 150.0,
    total_mv_yuan: float = 1800e8,
    pe_ttm: float = 18.0,
    pb: float = 3.5,
    historical_pes: list[float] | None = None,
    revenues: list[float] | None = None,
    profits: list[float] | None = None,
    deduct_profits: list[float] | None = None,
    ocfs: list[float] | None = None,
    capex_yuan: float = 20e8,
    total_assets_yuan: float = 2000e8,
    equity_yuan: float = 1200e8,
    monetary_funds_yuan: float = 400e8,
    short_loan_yuan: float = 0.0,
    cip_yuan: float = 20e8,
    fixed_asset_yuan: float = 400e8,
    accounts_receivable_yuan: float = 50e8,
    inventory_yuan: float = 100e8,
    goodwill_yuan: float = 0.0,
    audit_opinion: str = "标准无保留意见",
    dividend_cash_annual_yuan: float = 100e8,
    repurchase_total_yuan: float = 0.0,
    equity_financing_total_yuan: float = 0.0,
    pledge_ratio_pct: float = 1.0,
) -> tuple[StockMetaRecord, StockSnapshotPayload]:
    meta = StockMetaRecord(
        code=code,
        name=name,
        exchange=exchange,  # type: ignore[arg-type]
        industry_sw1=industry_sw1,
    )
    pe_series = historical_pes or [14.0, 16.0, 18.0, 20.0, 24.0, 28.0, pe_ttm]
    bars: list[StockDailyBar] = []
    for idx, pe_val in enumerate(pe_series):
        trade_d = date(2020 + idx, 11, 20) if idx < len(pe_series) - 1 else as_of
        if trade_d > as_of:
            trade_d = date(as_of.year - (len(pe_series) - 1 - idx), 6, 15)
        bars.append(
            StockDailyBar(
                code=code,
                trade_date=trade_d,
                open=close,
                high=close,
                low=close,
                close=close,
                total_mv_yuan=total_mv_yuan,
                pe_ttm=pe_val,
                pb=pb,
            )
        )

    years = [2021, 2022, 2023, 2024, 2025]
    rev_vals = revenues or [800e8, 880e8, 960e8, 1050e8, 1150e8]
    prof_vals = profits or [200e8, 220e8, 240e8, 265e8, 290e8]
    deduct_vals = deduct_profits or [p * 0.95 for p in prof_vals]
    ocf_vals = ocfs or [p * 1.1 for p in prof_vals]

    reports = [
        StockAnnualReport(
            code=code,
            report_year=yr,
            report_date=date(yr, 12, 31),
            audit_opinion=audit_opinion if yr == 2025 else "标准无保留意见",
            revenue_yuan=rev_vals[idx],
            operate_cost_yuan=rev_vals[idx] * 0.55,
            net_profit_yuan=prof_vals[idx],
            deduct_net_profit_yuan=deduct_vals[idx],
            research_expense_yuan=rev_vals[idx] * 0.04,
            total_assets_yuan=total_assets_yuan,
            total_equity_yuan=equity_yuan,
            parent_equity_yuan=equity_yuan,
            monetary_funds_yuan=monetary_funds_yuan,
            short_loan_yuan=short_loan_yuan,
            cip_yuan=cip_yuan,
            fixed_asset_yuan=fixed_asset_yuan,
            accounts_receivable_yuan=accounts_receivable_yuan,
            inventory_yuan=inventory_yuan,
            goodwill_yuan=goodwill_yuan,
            ocf_yuan=ocf_vals[idx],
            capex_yuan=capex_yuan,
        )
        for idx, yr in enumerate(years)
    ]

    dividends = [
        StockDividendRecord(
            code=code,
            report_date=date(yr, 12, 31),
            report_year=yr,
            plan_progress="实施分配",
            cash_per_10_shares=10.0,
            total_shares=10e8,
            dividend_cash_total_yuan=dividend_cash_annual_yuan,
            dividend_yield_pct=round((dividend_cash_annual_yuan / total_mv_yuan) * 100.0, 2),
        )
        for yr in years
        if dividend_cash_annual_yuan > 0
    ]
    repurchases = (
        [
            StockRepurchaseRecord(
                code=code,
                event_date=date(2025, 9, 1),
                year=2025,
                progress="实施完成",
                repurchased_amount_yuan=repurchase_total_yuan,
            )
        ]
        if repurchase_total_yuan > 0
        else []
    )
    financings = (
        [
            StockEquityFinancingRecord(
                code=code,
                year=2025,
                event_date=date(2025, 6, 1),
                source="add_stock",
                financing_type="定向增发",
                amount_yuan=equity_financing_total_yuan,
            )
        ]
        if equity_financing_total_yuan > 0
        else []
    )
    bundle = StockFactBundle(
        code=code,
        as_of=as_of,
        data_source="eval_fixture",
        daily_bars=bars,
        annual_reports=reports,
        dividends=dividends,
        repurchases=repurchases,
        pledge=StockPledgeSnapshot(code=code, trade_date=as_of, pledge_ratio_pct=pledge_ratio_pct),
        equity_financings=financings,
    )
    snapshot = build_stock_snapshot(
        meta, bundle, generated_at=datetime(2026, 11, 20, 8, 0, tzinfo=UTC)
    )
    return meta, snapshot


class _InMemoryAiRepo:
    def __init__(self) -> None:
        self.config = StoredAiConfig()
        self.usage = 0

    async def get_config(self, user_id: Any) -> StoredAiConfig:
        return self.config

    async def save_config(self, user_id: Any, config: StoredAiConfig) -> StoredAiConfig:
        self.config = config
        return config

    async def get_usage_today(self, user_id: Any, day_shanghai: str) -> int:
        return self.usage

    async def try_consume_quota(
        self, user_id: Any, day_shanghai: str, daily_limit: int
    ) -> tuple[bool, int]:
        if self.usage >= daily_limit:
            return False, self.usage
        self.usage += 1
        return True, self.usage

    async def refund_quota(self, user_id: Any, day_shanghai: str) -> int:
        self.usage = max(0, self.usage - 1)
        return self.usage

    async def release_read_transaction(self) -> None:
        return None


class _InMemoryStockMetaRepo:
    def __init__(self, metas: dict[str, StockMetaRecord], snapped: set[str]) -> None:
        self._metas = metas
        self._snapped = snapped

    async def upsert_many(self, items: Sequence[StockMetaRecord]) -> int:
        return 0

    async def search(self, query: str, *, limit: int = 10) -> list[StockMetaRecord]:
        return []

    async def get_detail(self, code: str) -> StockDetail | None:
        meta = self._metas.get(code)
        if meta is None:
            return None
        return StockDetail(
            **meta.model_dump(exclude={"snapshot_available"}),
            snapshot_available=code in self._snapped,
        )

    async def get_name(self, code: str) -> str | None:
        meta = self._metas.get(code)
        return meta.name if meta else None

    async def list_by_codes(self, codes: Sequence[str]) -> list[StockMetaRecord]:
        return [self._metas[c] for c in codes if c in self._metas]

    async def list_watched_codes(self, *, limit: int | None = None) -> list[str]:
        return []

    async def list_active_codes(self, *, limit: int | None = None) -> list[str]:
        return list(self._metas)


class _InMemorySnapshotRepo:
    def __init__(self, snapshots: dict[str, StockSnapshotPayload]) -> None:
        self._snapshots = snapshots

    async def get_snapshot(self, code: str) -> StockSnapshotPayload | None:
        return self._snapshots.get(code)

    async def get_snapshots_for_compare(
        self, codes: Sequence[str]
    ) -> dict[str, StockSnapshotPayload]:
        return {c: self._snapshots[c] for c in codes if c in self._snapshots}

    async def list_all_snapshots(self) -> list[StockSnapshotPayload]:
        return [self._snapshots[c] for c in sorted(self._snapshots)]

    async def save_snapshot(self, snapshot: StockSnapshotPayload) -> None:
        self._snapshots[snapshot.code] = snapshot


class _InMemoryEventRepo:
    def __init__(self) -> None:
        self.events: list[UserEventCreate] = []

    async def list(self, user_id: Any, *, limit: int = 50) -> list[UserEventItem]:
        return []

    async def record(self, user_id: Any, payload: UserEventCreate) -> UserEventItem:
        self.events.append(payload)
        return UserEventItem(
            id=len(self.events),
            type=payload.type,
            code=payload.code,
            meta=payload.meta,
            ts=datetime.now(UTC),
        )


class _StubLlmPort:
    def __init__(
        self,
        *,
        challenges: list[DevilsAdvocateChallenge] | None = None,
        mda_summary: str = "",
    ) -> None:
        self._challenges = challenges or []
        self._mda_summary = mda_summary

    async def generate_challenges(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_seconds: float,
        context: Mapping[str, Any],
    ) -> list[DevilsAdvocateChallenge]:
        return list(self._challenges)

    async def summarize_mda_diff(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_seconds: float,
        code: str,
        stock_name: str,
        previous_period_label: str,
        current_period_label: str,
        metric_shifts: Sequence[MdaMetricShift],
        text_highlights: Sequence[MdaDiffHighlight],
    ) -> str:
        return self._mda_summary


@dataclass(frozen=True)
class EvalScenario:
    scenario_id: str
    meta: StockMetaRecord
    snapshot: StockSnapshotPayload | None
    action: JournalAction
    reason: str
    falsify_condition: str
    expected_keywords: tuple[str, ...]


def _make_20_scenarios() -> list[EvalScenario]:
    scenarios: list[EvalScenario] = []

    m1, s1 = _build_eval_snapshot(
        code="600519",
        name="现金牛龙头",
        close=1400.0,
        total_mv_yuan=17500e8,
        pe_ttm=19.0,
        pb=6.5,
        revenues=[1000e8, 1120e8, 1250e8, 1400e8, 1580e8],
        profits=[450e8, 510e8, 580e8, 660e8, 750e8],
        ocfs=[500e8, 560e8, 630e8, 710e8, 800e8],
        capex_yuan=30e8,
        total_assets_yuan=2800e8,
        equity_yuan=2200e8,
        monetary_funds_yuan=1400e8,
        dividend_cash_annual_yuan=350e8,
    )
    scenarios.append(
        EvalScenario(
            "S01_cash_cow",
            m1,
            s1,
            JournalAction.BUY,
            "高 ROE 现金牛，品牌定价权极强，自由现金流长期充沛。",
            "连续2年ROE低于18%或排雷红灯大于0",
            ("估值", "ROE", "现金"),
        )
    )

    m2, s2 = _build_eval_snapshot(
        code="600102",
        name="存贷双高样本",
        monetary_funds_yuan=800e8,
        short_loan_yuan=600e8,
        total_assets_yuan=2000e8,
        equity_yuan=1000e8,
    )
    scenarios.append(
        EvalScenario(
            "S02_dual_high_cash_debt",
            m2,
            s2,
            JournalAction.BUY,
            "账面货币资金丰厚且低估值。",
            "货币资金受限比例超过30%或利息覆灭",
            ("存贷双高",),
        )
    )

    m3, s3 = _build_eval_snapshot(
        code="002103",
        name="在建工程滞留样本",
        exchange="SZ",
        cip_yuan=500e8,
        fixed_asset_yuan=800e8,
        total_assets_yuan=2000e8,
    )
    scenarios.append(
        EvalScenario(
            "S03_stalled_cip",
            m3,
            s3,
            JournalAction.BUY,
            "新产线即将投产带来产能放量。",
            "在建工程转固后毛利率跌破25%连续2年",
            ("在建工程",),
        )
    )

    m4, s4 = _build_eval_snapshot(
        code="300104",
        name="高商誉样本",
        exchange="SZ",
        goodwill_yuan=800e8,
        equity_yuan=1800e8,
        total_assets_yuan=3200e8,
    )
    scenarios.append(
        EvalScenario(
            "S04_goodwill_overhang",
            m4,
            s4,
            JournalAction.ADD,
            "并购整合带来规模协同效应。",
            "被并购子公司触发大额商誉减值且ROE跌破8%",
            ("商誉",),
        )
    )

    m5, s5 = _build_eval_snapshot(
        code="002105",
        name="高质押样本",
        exchange="SZ",
        pledge_ratio_pct=42.5,
    )
    scenarios.append(
        EvalScenario(
            "S05_high_pledge",
            m5,
            s5,
            JournalAction.BUY,
            "大股东专注主业，当前市值具吸引力。",
            "股权质押率超过45%或触发被动减持",
            ("质押", "42.50%"),
        )
    )

    m6, s6 = _build_eval_snapshot(
        code="601106",
        name="伪高股息样本",
        total_mv_yuan=1500e8,
        ocfs=[40e8, 40e8, 40e8, 40e8, 40e8],
        capex_yuan=30e8,
        dividend_cash_annual_yuan=120e8,
    )
    scenarios.append(
        EvalScenario(
            "S06_fake_high_dividend",
            m6,
            s6,
            JournalAction.BUY,
            "静态股息率超过8%，拟作为高股息红利配置。",
            "自由现金流对分红覆盖持续低于0.6倍",
            ("伪高股息", "FCF覆盖"),
        )
    )

    m7, s7 = _build_eval_snapshot(
        code="600107",
        name="回购再融资稀释样本",
        dividend_cash_annual_yuan=30e8,
        repurchase_total_yuan=50e8,
        equity_financing_total_yuan=260e8,
    )
    scenarios.append(
        EvalScenario(
            "S07_buyback_dilution",
            m7,
            s7,
            JournalAction.BUY,
            "公司年内实施股份回购与现金分红。",
            "累计股权再融资持续高于分红回购总和",
            ("再融资",),
        )
    )

    m8, s8 = _build_eval_snapshot(
        code="300108",
        name="逆向估值过高样本",
        exchange="SZ",
        total_mv_yuan=10000e8,
        revenues=[1000e8, 1000e8, 1000e8, 1000e8, 1000e8],
        profits=[150e8, 150e8, 150e8, 150e8, 150e8],
        ocfs=[150e8, 150e8, 150e8, 150e8, 150e8],
        capex_yuan=50e8,
    )
    scenarios.append(
        EvalScenario(
            "S08_reverse_dcf_over_optimism",
            m8,
            s8,
            JournalAction.BUY,
            "赛道空间广阔，给予成长溢价。",
            "季度营收增速低于10%且DCF隐含增速超25%",
            ("逆向 DCF",),
        )
    )

    m9, s9 = _build_eval_snapshot(
        code="600109",
        name="估值高分位样本",
        close=120.0,
        pe_ttm=42.0,
        pb=7.5,
        historical_pes=[12.0, 15.0, 18.0, 22.0, 25.0, 28.0, 42.0],
    )
    scenarios.append(
        EvalScenario(
            "S09_peak_pe_valuation",
            m9,
            s9,
            JournalAction.BUY,
            "行业景气度高，预期业绩继续加速。",
            "PE分位高于85%且安全边际持续为负",
            ("估值分位",),
        )
    )

    m10, s10 = _build_eval_snapshot(
        code="601110",
        name="低PE周期高点样本",
        close=25.0,
        pe_ttm=7.5,
        pb=1.8,
        historical_pes=[10.0, 14.0, 18.0, 24.0, 30.0, 15.0, 7.5],
        profits=[30e8, 25e8, 120e8, 280e8, 420e8],
        ocfs=[40e8, 35e8, 130e8, 290e8, 440e8],
        equity_yuan=1200e8,
    )
    scenarios.append(
        EvalScenario(
            "S10_cyclical_low_pe_trap",
            m10,
            s10,
            JournalAction.BUY,
            "当前 PE 不足 8 倍，估值看似极为便宜。",
            "ROE 回落至 8% 以下且产品价格下跌超 15%",
            ("周期", "7.50x"),
        )
    )

    m11, s11 = _build_eval_snapshot(
        code="000111",
        name="现金流背离样本",
        exchange="SZ",
        profits=[400e8, 420e8, 450e8, 480e8, 500e8],
        ocfs=[80e8, 90e8, 100e8, 110e8, 100e8],
    )
    scenarios.append(
        EvalScenario(
            "S11_ocf_profit_divergence",
            m11,
            s11,
            JournalAction.BUY,
            "连续五年净利润稳定增长。",
            "近5年净现比长期低于60%",
            ("现金流",),
        )
    )

    m12, s12 = _build_eval_snapshot(
        code="002112",
        name="应收存货膨胀样本",
        exchange="SZ",
        revenues=[1000e8, 1000e8, 1000e8, 1000e8, 1000e8],
        accounts_receivable_yuan=550e8,
        inventory_yuan=400e8,
        total_assets_yuan=2200e8,
    )
    scenarios.append(
        EvalScenario(
            "S12_receivable_inventory_bloat",
            m12,
            s12,
            JournalAction.BUY,
            "下游客户均为大型集成商，订单充沛。",
            "应收与存货占营收超过80%且回款周期拉长",
            ("占款",),
        )
    )

    m13, s13 = _build_eval_snapshot(
        code="688113",
        name="负自由现金流样本",
        ocfs=[100e8, 110e8, 120e8, 120e8, 130e8],
        capex_yuan=260e8,
    )
    scenarios.append(
        EvalScenario(
            "S13_negative_fcf",
            m13,
            s13,
            JournalAction.BUY,
            "重资产逆周期扩产锁定未来产能。",
            "连续2年自由现金流低于0且有息负债升高",
            ("自由现金流为负",),
        )
    )

    m14, s14 = _build_eval_snapshot(
        code="600114",
        name="非标审计样本",
        audit_opinion="保留意见",
    )
    scenarios.append(
        EvalScenario(
            "S14_non_standard_audit",
            m14,
            s14,
            JournalAction.BUY,
            "市场对年报一次性事项反应过度。",
            "审计师再次出具非标准审计意见",
            ("审计意见",),
        )
    )

    m15, s15 = _build_eval_snapshot(
        code="000115",
        name="营收收缩样本",
        exchange="SZ",
        revenues=[1500e8, 1380e8, 1220e8, 1050e8, 900e8],
        profits=[180e8, 150e8, 120e8, 95e8, 80e8],
        ocfs=[190e8, 160e8, 130e8, 100e8, 85e8],
    )
    scenarios.append(
        EvalScenario(
            "S15_shrinking_revenue",
            m15,
            s15,
            JournalAction.BUY,
            "公司通过降本增效维持盈利。",
            "近3年营收持续萎缩且ROE跌破10%",
            ("收缩",),
        )
    )

    m16, s16 = _build_eval_snapshot(
        code="600036",
        name="银行业样本",
        industry_sw1="银行",
        close=38.0,
        pb=0.85,
        pe_ttm=6.2,
        monetary_funds_yuan=2000e8,
        short_loan_yuan=1800e8,
        total_assets_yuan=5000e8,
    )
    scenarios.append(
        EvalScenario(
            "S16_bank_equity_exemption",
            m16,
            s16,
            JournalAction.BUY,
            "股息率稳定且市净率低于 1 倍。",
            "连续2年ROE跌破8%或不良率显著抬头",
            ("银行", "豁免"),
        )
    )

    m17 = StockMetaRecord(
        code="300750",
        name="未同步样本",
        exchange="SZ",
        industry_sw1="电力设备",
        is_st=False,
    )
    scenarios.append(
        EvalScenario(
            "S17_unsynced_stock_metadata",
            m17,
            None,
            JournalAction.BUY,
            "锂电全球龙头长期赛道逻辑。",
            "ROE低于12%或排雷红灯大于0",
            ("未同步",),
        )
    )

    m18, s18 = _build_eval_snapshot(code="600118", name="空泛否证样本")
    scenarios.append(
        EvalScenario(
            "S18_vague_falsify_condition",
            m18,
            s18,
            JournalAction.ADD,
            "看涨",
            "跌了就卖",
            ("否证条件",),
        )
    )

    m19, s19 = _build_eval_snapshot(
        code="000858", name="卖出情绪核验样本", exchange="SZ", pe_ttm=14.0
    )
    scenarios.append(
        EvalScenario(
            "S19_sell_action_counter_probe",
            m19,
            s19,
            JournalAction.SELL,
            "短期股价回调引发担忧，准备全部卖出止损。",
            "基本面ROE跌破12%且净现比低于70%",
            ("情绪",),
        )
    )

    m20, s20 = _build_eval_snapshot(
        code="000333",
        name="放弃决策核验样本",
        exchange="SZ",
        pe_ttm=13.5,
        pledge_ratio_pct=18.0,
    )
    scenarios.append(
        EvalScenario(
            "S20_pass_action_blind_spot",
            m20,
            s20,
            JournalAction.PASS,
            "短期竞争存在不确定性，暂先观望。",
            "PE跌破12倍且质押率降至10%以下可重新评估",
            ("观察",),
        )
    )
    return scenarios


EVAL_SCENARIOS = _make_20_scenarios()
assert len(EVAL_SCENARIOS) == 20


@pytest.mark.parametrize("scenario", EVAL_SCENARIOS, ids=[s.scenario_id for s in EVAL_SCENARIOS])
def test_20_scenario_deterministic_eval_suite(scenario: EvalScenario) -> None:
    challenges = build_deterministic_challenges(
        scenario.meta,
        scenario.snapshot,
        action=scenario.action,
        reason=scenario.reason,
        falsify_condition=scenario.falsify_condition,
    )
    assert len(challenges) == 3
    assert [c.index for c in challenges] == [1, 2, 3]
    assert len({c.title for c in challenges}) == 3

    combined_text = " ".join(
        f"{c.title} {c.thesis} " + " ".join(f"{f.label} {f.value_text}" for f in c.cited_facts)
        for c in challenges
    )
    assert contains_forbidden_advice(combined_text) is None
    assert contains_forbidden_advice(COMPLIANCE_NOTICE) is None

    ok, err = verify_llm_challenges(
        challenges,
        scenario.snapshot,
        stock_code=scenario.meta.code,
        stock_name=scenario.meta.name,
    )
    assert ok is True, f"{scenario.scenario_id} failed self-grounding check: {err}"

    for expected_kw in scenario.expected_keywords:
        assert expected_kw in combined_text, (
            f"{scenario.scenario_id} missing expected keyword {expected_kw!r}"
        )


async def test_mock_llm_hallucination_and_forbidden_advice_fallback() -> None:
    meta, snapshot = _build_eval_snapshot(
        code="600519",
        name="贵州茅台",
        close=1500.0,
        pe_ttm=20.0,
    )
    user = AuthenticatedUser(id=uuid4(), plan_tier=PlanTier.FREE)
    ai_repo = _InMemoryAiRepo()
    meta_repo = _InMemoryStockMetaRepo({meta.code: meta}, {meta.code})
    snap_repo = _InMemorySnapshotRepo({meta.code: snapshot})
    event_repo = _InMemoryEventRepo()

    hallucinating_llm = _StubLlmPort(
        challenges=[
            DevilsAdvocateChallenge(
                index=1,
                title="虚构数字测试",
                thesis="公司 PE 为 20.00 倍，但核心子公司亏损达 987.65 亿元。",
                cited_facts=[
                    CitedMetricFact(
                        label="PE(TTM)", value_text="20.00x", source_section="valuation"
                    )
                ],
            ),
            DevilsAdvocateChallenge(
                index=2,
                title="第二条",
                thesis="当前收盘价 1500.00 元。",
                cited_facts=[
                    CitedMetricFact(
                        label="收盘价", value_text="1500.00元", source_section="valuation"
                    )
                ],
            ),
            DevilsAdvocateChallenge(
                index=3,
                title="第三条",
                thesis="当前排雷红灯 0 项。",
                cited_facts=[
                    CitedMetricFact(label="红灯", value_text="0", source_section="financial_ct")
                ],
            ),
        ]
    )
    svc_hallucinate = AiPartnerService(
        ai_repo=ai_repo,
        stock_meta=meta_repo,
        snapshot_repo=snap_repo,
        event_repo=event_repo,
        llm_client=hallucinating_llm,
        platform_llm_base_url="https://api.openai.com/v1",
        platform_llm_api_key="sk-platform-1234",
    )
    resp1 = await svc_hallucinate.run_devils_advocate(
        user,
        DevilsAdvocateRequest(
            code="600519",
            action=JournalAction.BUY,
            reason="优质消费龙头，盈利能力稳健。",
            falsify_condition="连续2年ROE低于18%",
            mode="auto",
        ),
    )
    assert resp1.mode == "deterministic_fallback"
    assert resp1.fallback_reason is not None and "987.65" in resp1.fallback_reason
    assert len(resp1.challenges) == 3

    advice_llm = _StubLlmPort(
        challenges=[
            DevilsAdvocateChallenge(
                index=1,
                title="合规越线",
                thesis="当前 PE 为 20.00x，强烈推荐并建议买入，目标价 2500 元。",
                cited_facts=[
                    CitedMetricFact(
                        label="PE(TTM)", value_text="20.00x", source_section="valuation"
                    )
                ],
            ),
            DevilsAdvocateChallenge(
                index=2,
                title="第二条",
                thesis="当前收盘价 1500.00 元。",
                cited_facts=[
                    CitedMetricFact(
                        label="收盘价", value_text="1500.00元", source_section="valuation"
                    )
                ],
            ),
            DevilsAdvocateChallenge(
                index=3,
                title="第三条",
                thesis="排雷红灯 0 项。",
                cited_facts=[
                    CitedMetricFact(label="红灯", value_text="0", source_section="financial_ct")
                ],
            ),
        ],
        mda_summary="公司基本面极其稳健，建议买入并给出目标价 2000 元。",
    )
    svc_advice = AiPartnerService(
        ai_repo=ai_repo,
        stock_meta=meta_repo,
        snapshot_repo=snap_repo,
        event_repo=event_repo,
        llm_client=advice_llm,
        platform_llm_base_url="https://api.openai.com/v1",
        platform_llm_api_key="sk-platform-1234",
    )
    resp2 = await svc_advice.run_devils_advocate(
        user,
        DevilsAdvocateRequest(
            code="600519",
            reason="长期护城河扎实",
            falsify_condition="连续2年ROE低于15%",
            mode="auto",
        ),
    )
    assert resp2.mode == "deterministic_fallback"
    assert resp2.fallback_reason is not None and "违规" in resp2.fallback_reason

    mda_resp = await svc_advice.run_mda_diff(
        user,
        MdaDiffRequest(
            code="600519",
            previous_text="公司产能扩张稳步推进，预计增长保持强劲。研发支出全部费用化处理。",
            current_text="受下游需求不及预期影响，公司面临价格战与库存承压。本期变更研发支出资本化比例，并补提大额减值准备。",
            mode="auto",
        ),
    )
    assert mda_resp.mode == "deterministic_fallback"
    assert contains_forbidden_advice(mda_resp.summary) is None
    assert "建议买入" not in mda_resp.summary
    assert any(h.severity == "red" for h in mda_resp.text_highlights)


def test_mda_diff_policy_risk_guidance_and_accounting_shifts() -> None:
    _, snapshot = _build_eval_snapshot(
        code="600519",
        revenues=[1000e8, 1020e8, 1050e8, 1100e8, 900e8],
        profits=[200e8, 210e8, 220e8, 230e8, 180e8],
        deduct_profits=[195e8, 205e8, 215e8, 225e8, 100e8],
        ocfs=[220e8, 220e8, 230e8, 240e8, 70e8],
    )
    shifts = compute_accounting_metric_shifts(snapshot)
    labels = {s.metric_label: s for s in shifts}
    assert "营业收入同比" in labels and labels["营业收入同比"].severity == "red"
    assert "归母净利 vs 扣非差额" in labels and labels["归母净利 vs 扣非差额"].severity == "red"
    assert "净现比变化" in labels and labels["净现比变化"].severity == "red"

    prev_text = (
        "公司核心产品订单饱满，产能扩张稳步推进。\n"
        "公司坚持稳健增长战略，市占率提升明显。\n"
        "报告期内坏账准备计提比例保持稳定。"
    )
    curr_text = (
        "报告期内受行业下行影响，下游需求不及预期且市场价格战加剧。\n"
        "公司变更坏账准备会计估计，并计提大额减值准备。\n"
        "公司优化内部研发费用管控。"
    )
    highlights, summary = compute_text_mda_diff(prev_text, curr_text)
    assert any(h.severity == "red" and "会计政策" in h.category for h in highlights)
    assert any(h.change_type == "removed" and h.severity == "yellow" for h in highlights)
    assert any(h.change_type == "added" and h.severity == "yellow" for h in highlights)
    assert "高敏感" in summary

    ok, err = verify_mda_summary("2025年营收 900.00亿元，本期新增 2 处高风险变更。", snapshot)
    assert ok is True, err
    ok_bad, _ = verify_mda_summary("建议买入，目标价 2000 元。", snapshot)
    assert ok_bad is False
    ok_hallucinated, _ = verify_mda_summary("本期海外收入暴增 777.88%。", snapshot)
    assert ok_hallucinated is False


def test_context_trimming_secret_masking_and_ssrf_url_helpers() -> None:
    meta, snapshot = _build_eval_snapshot(code="600519", pe_ttm=21.5)
    ctx = trim_snapshot_context(
        meta,
        snapshot,
        action=JournalAction.BUY,
        reason="估值合理，自由现金流扎实",
        falsify_condition="ROE跌破15%",
    )
    assert ctx["snapshot_available"] is True
    assert "history" not in ctx["valuation"]
    assert "formula_notes" not in ctx
    assert len(ctx["recent_annual_trends"]) <= 3

    all_nums, metric_nums = collect_allowed_snapshot_numbers(snapshot)
    assert "21.5" in metric_nums
    assert "21.50" in all_nums

    assert mask_secret("sk-proj-abcdef1234") == "sk-****1234"
    assert mask_secret("my-secret-token-9876") == "****9876"
    assert mask_secret("sk-1234") == "sk-****"
    assert mask_secret("abcd") == "****"
    assert mask_secret(None) is None
    assert validate_public_http_url("https://api.openai.com/v1") == "https://api.openai.com/v1"
    with pytest.raises(ValueError):
        validate_public_http_url("http://127.0.0.1:8080/v1")


async def test_llm_adapter_ssrf_rebinding_secret_hygiene_and_400_retry(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    calls = 0

    def bad_handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={})

    adapter_ssrf = OpenAiCompatibleLlmAdapter(transport=httpx.MockTransport(bad_handler))
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda _h, port, *_a, **_kw: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", int(port)))
        ],
    )
    with pytest.raises(ValueError):
        await adapter_ssrf.generate_challenges(
            base_url="https://rebind.example.com/v1",
            api_key="sk-super-secret-key-1234",
            model="gpt-4o-mini",
            timeout_seconds=5.0,
            context={"stock": {"code": "600519"}},
        )
    assert calls == 0

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda _h, port, *_a, **_kw: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", int(port)))
        ],
    )
    attempt = 0

    def retry_handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempt
        attempt += 1
        assert request.headers["Authorization"] == "Bearer sk-super-secret-key-1234"
        if attempt == 1:
            return httpx.Response(400, json={"error": "response_format unsupported"})
        llm_payload = {
            "challenges": [
                {
                    "index": 1,
                    "title": "风险1",
                    "thesis": "现价 150.00 元",
                    "cited_facts": [
                        {
                            "label": "现价",
                            "value_text": "150.00元",
                            "source_section": "valuation",
                        }
                    ],
                },
                {
                    "index": 2,
                    "title": "风险2",
                    "thesis": "PE 18.00x",
                    "cited_facts": [
                        {"label": "PE", "value_text": "18.00x", "source_section": "valuation"}
                    ],
                },
                {
                    "index": 3,
                    "title": "风险3",
                    "thesis": "红灯 0 项",
                    "cited_facts": [
                        {"label": "红灯", "value_text": "0", "source_section": "financial_ct"}
                    ],
                },
            ]
        }
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(llm_payload)}}]},
        )

    caplog.set_level(logging.DEBUG)
    adapter_ok = OpenAiCompatibleLlmAdapter(transport=httpx.MockTransport(retry_handler))
    res = await adapter_ok.generate_challenges(
        base_url="https://api.openai.com/v1",
        api_key="sk-super-secret-key-1234",
        model="gpt-4o-mini",
        timeout_seconds=5.0,
        context={"stock": {"code": "600519"}},
    )
    assert attempt == 2
    assert len(res) == 3
    assert "sk-super-secret-key-1234" not in caplog.text


async def test_shanghai_midnight_rollover_and_prefer_rule_only() -> None:
    meta, snapshot = _build_eval_snapshot(code="600519", close=1500.0, pe_ttm=20.0)
    user = AuthenticatedUser(id=uuid4(), plan_tier=PlanTier.FREE)
    current_now = datetime(2026, 11, 22, 15, 59, tzinfo=UTC)  # 23:59 CST

    class _RolloverRepo(_InMemoryAiRepo):
        def __init__(self) -> None:
            super().__init__()
            self.by_day: dict[str, int] = {}

        async def get_usage_today(self, user_id: Any, day_shanghai: str) -> int:
            return self.by_day.get(day_shanghai, 0)

        async def try_consume_quota(
            self, user_id: Any, day_shanghai: str, daily_limit: int
        ) -> tuple[bool, int]:
            used = self.by_day.get(day_shanghai, 0)
            if used >= daily_limit:
                return False, used
            self.by_day[day_shanghai] = used + 1
            return True, used + 1

        async def refund_quota(self, user_id: Any, day_shanghai: str) -> int:
            used = self.by_day.get(day_shanghai, 0)
            self.by_day[day_shanghai] = max(0, used - 1)
            return self.by_day[day_shanghai]

    ai_repo = _RolloverRepo()
    llm = _StubLlmPort(
        challenges=[
            DevilsAdvocateChallenge(
                index=1,
                title="c1",
                thesis="收盘价 1500.00 元",
                cited_facts=[
                    CitedMetricFact(
                        label="收盘价", value_text="1500.00元", source_section="valuation"
                    )
                ],
            ),
            DevilsAdvocateChallenge(
                index=2,
                title="c2",
                thesis="PE 20.00x",
                cited_facts=[
                    CitedMetricFact(label="PE", value_text="20.00x", source_section="valuation")
                ],
            ),
            DevilsAdvocateChallenge(
                index=3,
                title="c3",
                thesis="红灯 0 项",
                cited_facts=[
                    CitedMetricFact(label="红灯", value_text="0", source_section="financial_ct")
                ],
            ),
        ]
    )
    svc = AiPartnerService(
        ai_repo=ai_repo,
        stock_meta=_InMemoryStockMetaRepo({meta.code: meta}, {meta.code}),
        snapshot_repo=_InMemorySnapshotRepo({meta.code: snapshot}),
        event_repo=_InMemoryEventRepo(),
        llm_client=llm,
        platform_llm_base_url="https://api.openai.com/v1",
        platform_llm_api_key="sk-platform-1234",
        clock=lambda: current_now,
    )
    r1 = await svc.run_devils_advocate(
        user,
        DevilsAdvocateRequest(code="600519", reason="现金牛", mode="auto"),
    )
    assert r1.quota.resets_at_shanghai == "2026-11-22 24:00 CST"
    assert r1.quota.used_today == 1

    # Advance 2 minutes across midnight CST (16:01 UTC = 00:01 CST next day).
    current_now = datetime(2026, 11, 22, 16, 1, tzinfo=UTC)
    r2 = await svc.run_devils_advocate(
        user,
        DevilsAdvocateRequest(code="600519", reason="现金牛", mode="auto"),
    )
    assert r2.quota.resets_at_shanghai == "2026-11-23 24:00 CST"
    assert r2.quota.used_today == 1

    ai_repo.config = StoredAiConfig(prefer_rule_only=True)
    r3 = await svc.run_devils_advocate(
        user,
        DevilsAdvocateRequest(code="600519", reason="现金牛", mode="auto"),
    )
    assert r3.mode == "deterministic"
    assert r3.quota.used_today == 1


_CANONICAL_FRONTEND_METRICS = frozenset(
    {
        "ct_red_count",
        "pe_ttm",
        "pe_percentile_10y",
        "pb",
        "close",
        "dividend_yield_pct",
        "implied_fcf_cagr_pct",
        "roe_5y_avg_pct",
        "roe_pct",
        "pledge_ratio_pct",
        "gross_margin_pct",
        "net_margin_pct",
        "net_profit_yuan",
        "revenue_yuan",
        "fcf_yuan",
        "ocf_yuan",
        "ocf_to_profit_5y_pct",
        "fcf_coverage_ratio",
        "total_score",
    }
)


def test_deterministic_canonical_metrics_pb_peak_bank_and_actions() -> None:
    for scenario in EVAL_SCENARIOS:
        challenges = build_deterministic_challenges(
            scenario.meta,
            scenario.snapshot,
            action=scenario.action,
            reason=scenario.reason,
            falsify_condition=scenario.falsify_condition,
        )
        for ch in challenges:
            if ch.suggested_falsify_rule is not None:
                assert ch.suggested_falsify_rule.metric in _CANONICAL_FRONTEND_METRICS, (
                    f"{scenario.scenario_id}: non-canonical metric "
                    f"{ch.suggested_falsify_rule.metric!r}"
                )

    # High PB percentile without high PE must cite pb + pb_percentile_10y and emit pb rule.
    meta_pb, snap_pb = _build_eval_snapshot(
        code="600201",
        name="高PB样本",
        pe_ttm=18.0,
        pb=4.2,
        historical_pes=[10.0, 14.0, 18.0, 24.0, 30.0, 35.0, 18.0],
    )
    snap_pb = snap_pb.model_copy(
        update={
            "valuation": snap_pb.valuation.model_copy(
                update={
                    "pe_percentile_10y": 40.0,
                    "pb": 4.2,
                    "pb_percentile_10y": 88.0,
                }
            )
        }
    )
    pb_challenges = build_deterministic_challenges(
        meta_pb,
        snap_pb,
        action=JournalAction.BUY,
        reason="长期基本面稳健，核心产品壁垒扎实",
        falsify_condition="连续2年ROE低于12%",
    )
    pb_val = next(c for c in pb_challenges if "估值分位" in c.title)
    pb_labels = {f.label for f in pb_val.cited_facts}
    assert "市净率 PB" in pb_labels and "PB 10年分位" in pb_labels
    assert "4.20x" in pb_val.thesis and "88.0%" in pb_val.thesis
    assert pb_val.suggested_falsify_rule is not None
    assert pb_val.suggested_falsify_rule.metric in {"pb", "pb_percentile_10y"}
    ok_pb, err_pb = verify_llm_challenges(
        pb_challenges, snap_pb, stock_code=meta_pb.code, stock_name=meta_pb.name
    )
    assert ok_pb is True, err_pb

    # Bank exemption (000001): skip industrial ocf_profit_divergence / baseline_cash / fcf rules.
    meta_bank, snap_bank = _build_eval_snapshot(
        code="000001",
        name="平安银行",
        exchange="SZ",
        industry_sw1="银行",
        close=11.2,
        pb=0.62,
        pe_ttm=4.8,
        profits=[350e8, 380e8, 420e8, 450e8, 460e8],
        ocfs=[-200e8, -150e8, 100e8, -300e8, -100e8],
        dividend_cash_annual_yuan=120e8,
    )
    bank_challenges = build_deterministic_challenges(
        meta_bank,
        snap_bank,
        action=JournalAction.BUY,
        reason="低估值高股息银行龙头配置价值凸显",
        falsify_condition="连续2年ROE低于8%或分红率显著下调",
    )
    bank_text = " ".join(
        f"{c.title} {c.thesis} " + " ".join(f"{f.label} {f.value_text}" for f in c.cited_facts)
        for c in bank_challenges
    )
    assert "净现比" not in bank_text
    assert "自由现金流" not in bank_text
    for ch in bank_challenges:
        if ch.suggested_falsify_rule is not None:
            assert ch.suggested_falsify_rule.metric in {
                "pb",
                "dividend_yield_pct",
                "roe_pct",
                "ct_red_count",
                "pe_percentile_10y",
            }
    ok_bank, err_bank = verify_llm_challenges(
        bank_challenges, snap_bank, stock_code=meta_bank.code, stock_name=meta_bank.name
    )
    assert ok_bank is True, err_bank

    # SELL/TRIM/PASS counter-thesis never crowded out even when 3 red CT alerts exist.
    meta_red, snap_red = _build_eval_snapshot(
        code="600999",
        name="多红灯样本",
        monetary_funds_yuan=800e8,
        short_loan_yuan=600e8,
        cip_yuan=500e8,
        fixed_asset_yuan=800e8,
        goodwill_yuan=900e8,
        equity_yuan=1500e8,
        total_assets_yuan=2000e8,
        pledge_ratio_pct=45.0,
    )
    for act in (JournalAction.SELL, JournalAction.TRIM, JournalAction.PASS):
        act_challenges = build_deterministic_challenges(
            meta_red,
            snap_red,
            action=act,
            reason="短",
            falsify_condition="不好就卖",
        )
        assert act_challenges[0].index == 1
        assert "踏空" in act_challenges[0].title or "观察清单" in act_challenges[0].title
        assert "入库前" not in " ".join(c.thesis for c in act_challenges)

        unsynced_act = build_deterministic_challenges(
            meta_red,
            None,
            action=act,
            reason="先观望",
            falsify_condition="看情况",
        )
        assert f"({act.value})" not in unsynced_act[2].title
        ok_u, err_u = verify_llm_challenges(
            unsynced_act, None, stock_code=meta_red.code, stock_name=meta_red.name
        )
        assert ok_u is True, err_u


def test_grounding_cjk_boundaries_rounding_obfuscation_and_compliance() -> None:
    meta, snapshot = _build_eval_snapshot(
        code="600429",
        name="三元股份",
        as_of=date(2026, 11, 20),
        close=1500.0,
        pe_ttm=18.35,
        revenues=[2000e8, 2100e8, 2300e8, 2500e8, 2660e8],
    )
    # CJK thousands commas, ISO dates, year labels, and exact Decimal rounding (18.35 -> 18.4).
    valid_challenges = [
        DevilsAdvocateChallenge(
            index=1,
            title="截至2026-11-20的估值水位",
            thesis="三元股份在2025年报后最新收盘价达1,500元，PE(TTM)约18.4x需防范回撤。",
            cited_facts=[
                CitedMetricFact(label="现价", value_text="1,500元", source_section="valuation"),
                CitedMetricFact(label="PE(TTM)", value_text="18.35x", source_section="valuation"),
            ],
            suggested_falsify_rule=FalsifyRule(metric="pe_ttm", op="gte", value=25.0, periods=1),
        ),
        DevilsAdvocateChallenge(
            index=2,
            title="营收规模参照",
            thesis="在2025年报口径下营收2,660亿元。",
            cited_facts=[
                CitedMetricFact(
                    label="2025年营收", value_text="2,660亿元", source_section="annual_trends"
                )
            ],
        ),
        DevilsAdvocateChallenge(
            index=3,
            title="排雷基线",
            thesis="当前排雷红灯0项。",
            cited_facts=[
                CitedMetricFact(label="红灯数", value_text="0", source_section="financial_ct")
            ],
        ),
    ]
    ok, err = verify_llm_challenges(
        valid_challenges, snapshot, stock_code=meta.code, stock_name=meta.name
    )
    assert ok is True, err

    # Reject 18.3 vs 18.4 mismatch when PE is 18.30 (must not widen tolerance).
    _, snap_183 = _build_eval_snapshot(code="600519", pe_ttm=18.3, close=1500.0)
    _, snap_183 = (
        snap_183.code,
        snap_183.model_copy(
            update={
                "radar": snap_183.radar.model_copy(update={"total_score": 70}),
            }
        ),
    )
    mismatch_ch = [
        DevilsAdvocateChallenge(
            index=1,
            title="精度错配",
            thesis="三元股份最新收盘价 1500.00 元，对应 18.4 倍有误。",
            cited_facts=[
                CitedMetricFact(label="PE", value_text="18.30x", source_section="valuation")
            ],
        ),
        *valid_challenges[1:],
    ]
    ok_mismatch, _ = verify_llm_challenges(
        mismatch_ch, snap_183, stock_code="600519", stock_name="贵州茅台"
    )
    assert ok_mismatch is False

    # Reject obfuscation & unsupported rule metrics & ungrounded labels/sections/advice.
    bad_variants = [
        ("scientific", "现价 1.5e3 元，PE 18.35x。"),
        ("separated_minus", "净利为 - 50.00 亿元，PE 18.35x。"),
        ("digit_space", "现价 1 500 元，PE 18.35x。"),
        ("unicode_numeral", "风险①显示 PE 18.35x，净利 10² 亿元。"),
        ("chinese_numeral", "亏损二十亿元，PE 18.35x。"),
        ("bad_year", "预计2099年报PE 18.35x。"),
        ("bad_date", "截至2099-01-01，PE 18.35x。"),
        ("bad_duration", "过去77年PE 18.35x。"),
    ]
    for tag, bad_thesis in bad_variants:
        bad_ch = [
            DevilsAdvocateChallenge(
                index=1,
                title="异常测试",
                thesis=bad_thesis,
                cited_facts=[
                    CitedMetricFact(
                        label="PE(TTM)", value_text="18.35x", source_section="valuation"
                    )
                ],
            ),
            *valid_challenges[1:],
        ]
        ok_bad, _ = verify_llm_challenges(
            bad_ch, snapshot, stock_code=meta.code, stock_name=meta.name
        )
        assert ok_bad is False, f"{tag} should have been rejected"

    # Reject ungrounded number inside fact.label, unsupported metric, and forbidden advice in label.
    bad_label_ch = [
        valid_challenges[0].model_copy(
            update={
                "cited_facts": [
                    CitedMetricFact(
                        label="99年均值PE", value_text="18.35x", source_section="valuation"
                    )
                ]
            }
        ),
        *valid_challenges[1:],
    ]
    assert verify_llm_challenges(bad_label_ch, snapshot)[0] is False

    bad_metric_ch = [
        valid_challenges[0].model_copy(
            update={
                "suggested_falsify_rule": FalsifyRule(
                    metric="target_price_custom", op="lt", value=10.0, periods=1
                )
            }
        ),
        *valid_challenges[1:],
    ]
    assert verify_llm_challenges(bad_metric_ch, snapshot)[0] is False

    bad_section_advice_ch = [
        valid_challenges[0].model_copy(
            update={
                "cited_facts": [
                    CitedMetricFact(label="PE", value_text="18.35x", source_section="target_price")
                ]
            }
        ),
        *valid_challenges[1:],
    ]
    assert verify_llm_challenges(bad_section_advice_ch, snapshot)[0] is False

    # verify_mda_summary when snapshot is None must verify text_numbers and scrub name/code.
    ok_mda_none, err_mda_none = verify_mda_summary(
        "三元股份(600429)在2025年报毛利率为12.50%。",
        None,
        previous_text="毛利率12.5%",
        current_text="保持12.5%",
        stock_code="600429",
        stock_name="三元股份",
        previous_period_label="2024年报",
        current_period_label="2025年报",
    )
    assert ok_mda_none is True, err_mda_none
    assert (
        verify_mda_summary(
            "三元股份在2099年报毛利率为12.50%。",
            None,
            previous_text="毛利率12.5%",
            current_text="保持12.5%",
            stock_code="600429",
            stock_name="三元股份",
            previous_period_label="2024年报",
            current_period_label="2025年报",
        )[0]
        is False
    )
    assert (
        verify_mda_summary(
            "三元股份新增 99 处高风险变更，营收 888.88 亿元。",
            None,
            previous_text="业务平稳",
            current_text="需求放缓",
            stock_code="600429",
            stock_name="三元股份",
        )[0]
        is False
    )
    assert (
        verify_mda_summary(
            "2025年营收 900.00亿元，本期新增 99 处高风险变更。",
            snapshot,
        )[0]
        is False
    )

    # Compliance bypass hardening.
    for bad_phrase in (
        "建议投资者积极买入",
        "建**议**买**入**",
        "建\u200b议·买·入",
        "目*标*股*价 500 元",
        "评级为买入",
        "维持买入",
        "维持增持",
        "维持持有",
        "维持卖出",
        "维持减持",
        "强烈看多",
        "recommend to buy",
        "should buy",
        "should sell",
        "ｓｈｏｕｌｄ　ｓｅｌｌ",
    ):
        assert contains_forbidden_advice(bad_phrase) is not None, bad_phrase
    assert contains_forbidden_advice("建议先同步行情与年报序列后再审视估值安全垫。") is None


async def test_mda_diff_bounds_turnaround_breakeven_boilerplate_and_service_guards(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio
    import time

    from app.domain.models import AnnualFinancialTrendPoint, FinancialCtSection

    # 1. Quadratic guard: 80x80 replaced block finishes well under 1s.
    prev_big = "。".join(f"旧版条款第{idx}号业务描述与客户结构说明" for idx in range(80))
    curr_big = "。".join(f"新版条款第{idx}号调整内容与供应链说明" for idx in range(80))
    t0 = time.monotonic()
    big_highlights, _ = compute_text_mda_diff(prev_big, curr_big)
    elapsed = time.monotonic() - t0
    assert elapsed < 1.0
    assert len(big_highlights) >= 80

    # 2. Clean/negated boilerplate is not misclassified as red/yellow.
    clean_curr = (
        "本报告期未发生会计政策变更。"
        "公司未发生重大折旧年限变更，不存在退市风险。"
        "报告期内无重大诉讼，持续经营能力正常，主业不再亏损。"
        "坏账准备计提比例保持稳定，审计意见为标准无保留意见。"
    )
    clean_highlights, _ = compute_text_mda_diff("", clean_curr)
    assert all(h.severity == "green" for h in clean_highlights)

    # 3. Turnaround healthy OCF ratio -> green; breakeven masking -> red; explicit years.
    _, snap_turnaround = _build_eval_snapshot(
        code="600519", profits=[100e8, 100e8, 100e8, -50e8, 100e8]
    )
    snap_turnaround = snap_turnaround.model_copy(
        update={
            "annual_trends": [
                AnnualFinancialTrendPoint(
                    year=2024,
                    revenue_yuan=900e8,
                    net_profit_yuan=-50e8,
                    deduct_net_profit_yuan=-60e8,
                    ocf_yuan=20e8,
                    fcf_yuan=10e8,
                    net_cash_yuan=100e8,
                    gross_margin_pct=30.0,
                    rd_ratio_pct=4.0,
                ),
                AnnualFinancialTrendPoint(
                    year=2025,
                    revenue_yuan=1000e8,
                    net_profit_yuan=0.0,
                    deduct_net_profit_yuan=-80e8,
                    ocf_yuan=120e8,
                    fcf_yuan=100e8,
                    net_cash_yuan=150e8,
                    gross_margin_pct=31.0,
                    rd_ratio_pct=4.2,
                ),
            ],
            "financial_ct": FinancialCtSection(
                overall_status="green", red_count=0, yellow_count=0, green_count=1, checks=[]
            ),
        }
    )
    shifts_breakeven = compute_accounting_metric_shifts(snap_turnaround)
    by_label = {s.metric_label: s for s in shifts_breakeven}
    assert by_label["归母净利 vs 扣非差额"].severity == "red"
    assert "2024年" in by_label["归母净利 vs 扣非差额"].previous_text
    assert "2025年" in by_label["归母净利 vs 扣非差额"].current_text
    assert "2024年" in by_label["CT红灯与审计意见口径"].previous_text
    assert "2025年" in by_label["CT红灯与审计意见口径"].current_text

    snap_healthy_turn = snap_turnaround.model_copy(
        update={
            "annual_trends": [
                snap_turnaround.annual_trends[0],
                snap_turnaround.annual_trends[1].model_copy(
                    update={"net_profit_yuan": 100e8, "deduct_net_profit_yuan": 95e8}
                ),
            ]
        }
    )
    shifts_turn = compute_accounting_metric_shifts(snap_healthy_turn)
    assert next(s for s in shifts_turn if s.metric_label == "净现比变化").severity == "green"

    # 4. Unsynced + empty texts honest message; asyncio.to_thread usage; llm_client=None guard;
    #    partial preferences preservation; platform quota refund on upstream exception.
    meta_u = StockMetaRecord(code="300750", name="宁德时代", exchange="SZ", industry_sw1="电力设备")
    ai_repo = _InMemoryAiRepo()
    ai_repo.config = StoredAiConfig(
        prefer_rule_only=False,
        byok_enabled=True,
        byok_base_url="https://api.openai.com/v1",
        byok_api_key="sk-byok-1234",
        byok_model="gpt-4.1-mini",
    )
    user = AuthenticatedUser(id=uuid4(), plan_tier=PlanTier.FREE)
    svc_no_llm = AiPartnerService(
        ai_repo=ai_repo,
        stock_meta=_InMemoryStockMetaRepo({meta_u.code: meta_u}, set()),
        snapshot_repo=_InMemorySnapshotRepo({}),
        event_repo=_InMemoryEventRepo(),
        llm_client=None,
    )
    empty_unsynced = await svc_no_llm.run_mda_diff(user, MdaDiffRequest(code="300750"))
    assert empty_unsynced.summary == "尚未同步财报快照且未提供年报文本，暂无可对比变化。"

    # Must not raise AssertionError or consume quota when byok_active=True and llm_client=None.
    da_no_llm = await svc_no_llm.run_devils_advocate(
        user, DevilsAdvocateRequest(code="300750", reason="测试")
    )
    assert da_no_llm.mode == "deterministic"
    assert da_no_llm.quota.used_today == 0

    from app.domain.models import AiPreferencesUpdate

    updated_prefs = await svc_no_llm.update_preferences(
        user, AiPreferencesUpdate(prefer_rule_only=True)
    )
    assert updated_prefs.prefer_rule_only is True
    assert updated_prefs.byok_enabled is True
    assert updated_prefs.byok_model == "gpt-4.1-mini"

    # Verify asyncio.to_thread + quota refund + release_read_transaction.
    to_thread_calls: list[Any] = []
    orig_to_thread = asyncio.to_thread

    async def spy_to_thread(fn: Any, *args: Any, **kwargs: Any) -> Any:
        to_thread_calls.append(fn)
        return await orig_to_thread(fn, *args, **kwargs)

    monkeypatch.setattr("app.services.ai.asyncio.to_thread", spy_to_thread)

    class _FailingLlmPort(_StubLlmPort):
        async def generate_challenges(self, **kwargs: Any) -> list[DevilsAdvocateChallenge]:
            raise RuntimeError("upstream 503")

        async def summarize_mda_diff(self, **kwargs: Any) -> str:
            raise RuntimeError("upstream 503")

    meta_ok, snap_ok = _build_eval_snapshot(code="600519", close=1500.0, pe_ttm=20.0)
    ai_repo_plat = _InMemoryAiRepo()
    release_calls = 0
    orig_release = ai_repo_plat.release_read_transaction

    async def spy_release() -> None:
        nonlocal release_calls
        release_calls += 1
        await orig_release()

    ai_repo_plat.release_read_transaction = spy_release  # type: ignore[method-assign]
    svc_fail = AiPartnerService(
        ai_repo=ai_repo_plat,
        stock_meta=_InMemoryStockMetaRepo({meta_ok.code: meta_ok}, {meta_ok.code}),
        snapshot_repo=_InMemorySnapshotRepo({meta_ok.code: snap_ok}),
        event_repo=_InMemoryEventRepo(),
        llm_client=_FailingLlmPort(),
        platform_llm_base_url="https://api.openai.com/v1",
        platform_llm_api_key="sk-plat-1234",
    )
    da_fail = await svc_fail.run_devils_advocate(
        user, DevilsAdvocateRequest(code="600519", reason="现金牛")
    )
    assert da_fail.mode == "deterministic_fallback"
    assert da_fail.quota.used_today == 0
    assert release_calls == 1

    mda_fail = await svc_fail.run_mda_diff(
        user, MdaDiffRequest(code="600519", previous_text="稳健", current_text="承压")
    )
    assert mda_fail.mode == "deterministic_fallback"
    assert mda_fail.fallback_reason is not None and "RuntimeError" in mda_fail.fallback_reason
    assert mda_fail.quota.used_today == 0
    assert release_calls == 2
    assert len(to_thread_calls) == 1


async def test_ssrf_site_local_response_size_limit_sni_and_azure_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import gzip

    from app.adapters.http_safety import post_json_public
    from app.domain.url_safety import is_public_ip

    assert is_public_ip("fec0::1") is False

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port, *_a, **_kw: [
            (
                socket.AF_INET6 if ":" in host else socket.AF_INET,
                socket.SOCK_STREAM,
                6,
                "",
                (host if ":" in host or host[0].isdigit() else "93.184.216.34", int(port)),
            )
        ],
    )

    # Oversized streamed body (without Content-Length) > 1 MiB must be rejected.
    class _LargeChunkStream(httpx.AsyncByteStream):
        async def __aiter__(self) -> Any:
            for _ in range(17):
                yield b"x" * 65_536

    huge_transport = httpx.MockTransport(
        lambda _req: httpx.Response(200, stream=_LargeChunkStream())
    )
    with pytest.raises(ValueError, match="超过最大限制"):
        await post_json_public(
            "https://api.openai.com/v1",
            json_body={"ok": True},
            transport=huge_transport,
        )

    # Oversized Content-Length header must be rejected upfront.
    cl_transport = httpx.MockTransport(
        lambda _req: httpx.Response(200, headers={"content-length": str(2_000_000)}, content=b"{}")
    )
    with pytest.raises(ValueError, match="响应体过大"):
        await post_json_public(
            "https://api.openai.com/v1",
            json_body={"ok": True},
            transport=cl_transport,
        )

    # Gzip-compressed valid JSON works cleanly when under 1 MiB.
    gz_body = gzip.compress(
        json.dumps({"choices": [{"message": {"content": '{"summary":"正常"}'}}]}).encode("utf-8")
    )
    gz_transport = httpx.MockTransport(
        lambda _req: httpx.Response(
            200,
            headers={"content-encoding": "gzip", "content-type": "application/json"},
            content=gz_body,
        )
    )
    gz_resp = await post_json_public(
        "https://api.openai.com/v1", json_body={"ok": True}, transport=gz_transport
    )
    assert gz_resp.json()["choices"][0]["message"]["content"]

    # SNI extension only passed for domain names, never IP literals.
    seen_extensions: list[Any] = []

    class _SpyStreamTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            seen_extensions.append(dict(request.extensions))
            return httpx.Response(200, json={"ok": True})

    # Temporarily patch AsyncClient.stream in http_safety to inspect extensions with transport=None
    captured_ext: list[Any] = []
    orig_stream = httpx.AsyncClient.stream

    def spy_stream(self: httpx.AsyncClient, method: str, url: str, **kwargs: Any) -> Any:
        captured_ext.append((url, kwargs.get("extensions")))
        return orig_stream(self, method, url, **kwargs)

    # Test IP literal vs domain SNI via AsyncClient.stream interception + MockTransport bypass.
    orig_init = httpx.AsyncClient.__init__
    with monkeypatch.context() as m:
        m.setattr(httpx.AsyncClient, "stream", spy_stream)
        m.setattr(
            httpx.AsyncClient,
            "__init__",
            lambda self, *a, **kw: orig_init(
                self, *a, **{**kw, "transport": _SpyStreamTransport()}
            ),
        )
        await post_json_public("https://8.8.8.8/v1", json_body={"a": 1})
        await post_json_public("https://[2606:4700:4700::1111]/v1", json_body={"a": 1})
        await post_json_public("https://api.openai.com/v1", json_body={"a": 1})
    assert captured_ext[0][1] is None
    assert captured_ext[1][1] is None
    assert captured_ext[2][1] == {"sni_hostname": "api.openai.com"}

    # Azure query param preservation and summarize_mda_diff JSON validation.
    seen_urls: list[str] = []

    def azure_handler(req: httpx.Request) -> httpx.Response:
        seen_urls.append(str(req.url))
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": '{"summary": "营收变化平稳。"}'}}]},
        )

    azure_adapter = OpenAiCompatibleLlmAdapter(transport=httpx.MockTransport(azure_handler))
    summary = await azure_adapter.summarize_mda_diff(
        base_url="https://demo.openai.azure.com/openai/deployments/gpt4?api-version=2024-02-15",
        api_key="sk-azure-1234",
        model="gpt4",
        timeout_seconds=5.0,
        code="600519",
        stock_name="贵州茅台",
        previous_period_label="2024年报",
        current_period_label="2025年报",
        metric_shifts=[],
        text_highlights=[],
    )
    assert summary == "营收变化平稳。"
    assert seen_urls[0] == (
        "https://demo.openai.azure.com/openai/deployments/gpt4/chat/completions"
        "?api-version=2024-02-15"
    )

    bad_json_adapter = OpenAiCompatibleLlmAdapter(
        transport=httpx.MockTransport(
            lambda _r: httpx.Response(
                200,
                json={"choices": [{"message": {"content": '{"error": "missing summary"}'}}]},
            )
        )
    )
    with pytest.raises(ValueError, match="summary"):
        await bad_json_adapter.summarize_mda_diff(
            base_url="https://api.openai.com/v1",
            api_key="sk-test",
            model="gpt-4o-mini",
            timeout_seconds=5.0,
            code="600519",
            stock_name="贵州茅台",
            previous_period_label="2024年报",
            current_period_label="2025年报",
            metric_shifts=[],
            text_highlights=[],
        )
