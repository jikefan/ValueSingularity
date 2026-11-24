"""Tests for Stage 3 institutional forensic engine, Eastmoney parser, and Parquet compat."""

from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from app.adapters.akshare.stock_feed import parse_annual_reports
from app.adapters.duckdb.stock_store import DuckDBStockFactStore
from app.domain.engines import (
    analyze_stock_forensics,
    build_stock_snapshot,
    collect_allowed_snapshot_numbers,
)
from app.domain.models import (
    StockAnnualReport,
    StockDailyBar,
    StockDividendRecord,
    StockEquityFinancingRecord,
    StockFactBundle,
    StockMetaRecord,
    StockPledgeSnapshot,
    StockRepurchaseRecord,
    StockSnapshotPayload,
)


def _forensic_report(
    year: int,
    *,
    code: str = "600519",
    revenue: float = 100e8,
    operate_cost: float = 30e8,
    operate_profit: float | None = 40e8,
    invest_income: float | None = 1e8,
    invest_joint_income: float | None = None,
    fair_value_change: float | None = 0.0,
    other_income: float | None = 0.2e8,
    asset_disposal: float | None = 0.0,
    nonbusiness_net: float | None = 0.1e8,
    impairment_net: float | None = -0.2e8,
    net_profit: float = 30e8,
    deduct_net_profit: float = 29e8,
    interest_expense: float | None = 0.5e8,
    total_assets: float = 200e8,
    total_equity: float = 140e8,
    parent_equity: float = 135e8,
    monetary_funds: float = 60e8,
    trade_fin_assets: float | None = 5e8,
    long_equity_invest: float | None = 2e8,
    invest_property_other_fin: float | None = 1e8,
    short_loan: float = 2e8,
    long_loan: float = 2e8,
    ocf: float = 36e8,
    capex: float = 4e8,
) -> StockAnnualReport:
    return StockAnnualReport(
        code=code,
        report_year=year,
        report_date=date(year, 12, 31),
        audit_opinion="标准无保留意见",
        revenue_yuan=revenue,
        operate_cost_yuan=operate_cost,
        operate_profit_yuan=operate_profit,
        invest_income_yuan=invest_income,
        invest_joint_income_yuan=invest_joint_income,
        fair_value_change_yuan=fair_value_change,
        other_income_yuan=other_income,
        asset_disposal_yuan=asset_disposal,
        nonbusiness_net_yuan=nonbusiness_net,
        impairment_net_yuan=impairment_net,
        net_profit_yuan=net_profit,
        deduct_net_profit_yuan=deduct_net_profit,
        interest_expense_yuan=interest_expense,
        total_assets_yuan=total_assets,
        total_equity_yuan=total_equity,
        parent_equity_yuan=parent_equity,
        monetary_funds_yuan=monetary_funds,
        trade_fin_assets_yuan=trade_fin_assets,
        long_equity_invest_yuan=long_equity_invest,
        invest_property_and_other_fin_yuan=invest_property_other_fin,
        short_loan_yuan=short_loan,
        long_loan_yuan=long_loan,
        cip_yuan=1e8,
        fixed_asset_yuan=30e8,
        accounts_receivable_yuan=5e8,
        note_accounts_rece_yuan=5e8,
        inventory_yuan=10e8,
        goodwill_yuan=0.0,
        ocf_yuan=ocf,
        capex_yuan=capex,
    )


def test_parse_annual_reports_extracts_stage3_forensic_fields() -> None:
    bs_df = pd.DataFrame(
        [
            {
                "REPORT_DATE": "2024-12-31 00:00:00",
                "REPORT_TYPE": "年报",
                "TOTAL_ASSETS": 500e8,
                "MONETARYFUNDS": 80e8,
                "TRADE_FINASSET_NOTFVTPL": 40e8,
                "LONG_EQUITY_INVEST": 120e8,
                "OTHER_EQUITY_INVEST": 30e8,
                "OTHER_NONCURRENT_FINASSET": 20e8,
                "INVEST_REALESTATE": 10e8,
                "CREDITOR_INVEST": 5e8,
            },
            {
                "REPORT_DATE": "2025-12-31 00:00:00",
                "REPORT_TYPE": "年报",
                "TOTAL_ASSETS": 520e8,
                "MONETARYFUNDS": 90e8,
            },
        ]
    )
    ps_df = pd.DataFrame(
        [
            {
                "REPORT_DATE": "2024-12-31 00:00:00",
                "REPORT_TYPE": "年报",
                "OPERATE_INCOME": 200e8,
                "OPERATE_COST": 120e8,
                "OPERATE_PROFIT": 35e8,
                "SALE_EXPENSE": 15e8,
                "MANAGE_EXPENSE": 10e8,
                "OPERATE_TAX_ADD": 3e8,
                "INVEST_INCOME": 28e8,
                "INVEST_JOINT_INCOME": 22e8,
                "FAIRVALUE_CHANGE_INCOME": 6e8,
                "OTHER_INCOME": 1.2e8,
                "ASSET_DISPOSAL_INCOME": -0.2e8,
                "ASSET_IMPAIRMENT_INCOME": -1.5e8,
                "CREDIT_IMPAIRMENT_INCOME": 0.5e8,
                "NONBUSINESS_INCOME": 2.0e8,
                "NONBUSINESS_EXPENSE": 0.5e8,
                "PARENT_NETPROFIT": 30e8,
                "DEDUCT_PARENT_NETPROFIT": 26e8,
            },
            {
                "REPORT_DATE": "2025-12-31 00:00:00",
                "REPORT_TYPE": "年报",
                "OPERATE_INCOME": 210e8,
                "OPERATE_PROFIT": 40e8,
                # Only NONBUSINESS_EXPENSE present -> -1.2e8; impairments absent -> None.
                "NONBUSINESS_EXPENSE": 1.2e8,
                "PARENT_NETPROFIT": 32e8,
            },
        ]
    )
    cf_df = pd.DataFrame(
        [
            {"REPORT_DATE": "2024-12-31 00:00:00", "REPORT_TYPE": "年报", "NETCASH_OPERATE": 10e8},
            {"REPORT_DATE": "2025-12-31 00:00:00", "REPORT_TYPE": "年报", "NETCASH_OPERATE": 15e8},
        ]
    )

    reports = parse_annual_reports("600177", balance_df=bs_df, profit_df=ps_df, cash_flow_df=cf_df)
    assert [r.report_year for r in reports] == [2024, 2025]

    r24 = reports[0]
    assert r24.operate_profit_yuan == pytest.approx(35e8)
    assert r24.sale_expense_yuan == pytest.approx(15e8)
    assert r24.manage_expense_yuan == pytest.approx(10e8)
    assert r24.operate_tax_add_yuan == pytest.approx(3e8)
    assert r24.invest_income_yuan == pytest.approx(28e8)
    assert r24.invest_joint_income_yuan == pytest.approx(22e8)
    assert r24.fair_value_change_yuan == pytest.approx(6e8)
    assert r24.other_income_yuan == pytest.approx(1.2e8)
    assert r24.asset_disposal_yuan == pytest.approx(-0.2e8)
    assert r24.impairment_net_yuan == pytest.approx(-1.0e8)
    assert r24.nonbusiness_net_yuan == pytest.approx(1.5e8)
    assert r24.long_equity_invest_yuan == pytest.approx(120e8)
    assert r24.invest_property_and_other_fin_yuan == pytest.approx(65e8)

    r25 = reports[1]
    assert r25.impairment_net_yuan is None
    assert r25.nonbusiness_net_yuan == pytest.approx(-1.2e8)
    assert r25.long_equity_invest_yuan is None
    assert r25.invest_property_and_other_fin_yuan is None


def test_forensics_core_cash_cow_vs_investment_driven_masking_high_deduct() -> None:
    meta_cow = StockMetaRecord(
        code="600519", name="主业现金牛", exchange="SH", industry_sw1="食品饮料"
    )
    cow_reports = [_forensic_report(y, code="600519") for y in range(2021, 2026)]
    cow_dividends = [
        StockDividendRecord(
            code="600519",
            report_date=date(y, 12, 31),
            report_year=y,
            plan_progress="实施分配",
            cash_per_10_shares=15.0,
            total_shares=10e8,
            dividend_cash_total_yuan=15e8,
        )
        for y in range(2021, 2026)
    ]
    cow_forensics = analyze_stock_forensics(
        cow_reports,
        meta_cow,
        dividends=cow_dividends,
        repurchases=[
            StockRepurchaseRecord(
                code="600519",
                event_date=date(2025, 8, 1),
                year=2025,
                progress="完成实施",
                repurchased_amount_yuan=5e8,
            )
        ],
        is_financial=False,
    )
    assert cow_forensics.earnings_quality_tag == "core_cash_cow"
    assert cow_forensics.earnings_quality_label == "主业造血现金牛"
    assert cow_forensics.core_profit_share_3y_pct == pytest.approx(97.0)
    assert cow_forensics.invest_profit_share_3y_pct == pytest.approx(2.5)
    assert cow_forensics.investment_assets_yuan == pytest.approx(8e8)
    assert cow_forensics.investment_assets_ratio_pct == pytest.approx(4.0)
    assert (
        cow_forensics.dupont_roe_5y_avg_pct is not None
        and cow_forensics.dupont_roe_5y_avg_pct >= 20.0
    )
    assert cow_forensics.dupont_equity_multiplier_5y_avg is not None
    assert cow_forensics.dupont_equity_multiplier_5y_avg < 2.0
    dp_finding = next(f for f in cow_forensics.findings if f.finding_id == "dupont_attribution")
    assert dp_finding.status == "green"
    assert "高净利率驱动型真护城河" in dp_finding.headline
    assert cow_forensics.capital_allocation is not None
    assert cow_forensics.capital_allocation.allocation_style == "轻资产现金牛·高分红回报型"
    assert cow_forensics.capital_allocation.total_dividends_yuan == pytest.approx(75e8)
    assert cow_forensics.capital_allocation.total_repurchases_yuan == pytest.approx(5e8)

    # Associate/equity investment income keeps deduct_net_profit high while core profit is negative.
    meta_inv = StockMetaRecord(
        code="600177", name="投资驱动样本", exchange="SH", industry_sw1="纺织服饰"
    )
    inv_reports = [
        _forensic_report(
            y,
            code="600177",
            revenue=100e8,
            operate_profit=20e8,
            invest_income=21e8,
            invest_joint_income=18e8,
            fair_value_change=3e8,
            other_income=0.5e8,
            asset_disposal=0.0,
            nonbusiness_net=0.2e8,
            net_profit=18e8,
            deduct_net_profit=17e8,
            total_assets=500e8,
            trade_fin_assets=50e8,
            long_equity_invest=150e8,
            invest_property_other_fin=60e8,
            ocf=8e8,
        )
        for y in range(2021, 2026)
    ]
    inv_forensics = analyze_stock_forensics(inv_reports, meta_inv, is_financial=False)
    assert inv_forensics.earnings_quality_tag == "investment_driven"
    assert inv_forensics.earnings_quality_label == "盈利高度依赖对外投资"
    assert inv_forensics.non_recurring_share_3y_pct is not None
    assert inv_forensics.non_recurring_share_3y_pct < 10.0  # Deduct profit didn't catch it!
    assert inv_forensics.annual_decomposition[-1].core_operating_profit_yuan == pytest.approx(
        -4.5e8
    )
    assert inv_forensics.invest_profit_share_3y_pct == pytest.approx(120.0)
    assert inv_forensics.investment_assets_ratio_pct == pytest.approx(52.0)
    inv_finding = next(f for f in inv_forensics.findings if f.finding_id == "investment_reliance")
    assert inv_finding.status == "red"

    # Full snapshot embeds forensics, surfaces bear case, and whitelists numbers in AI grounding.
    bundle = StockFactBundle(
        code="600177",
        as_of=date(2026, 11, 20),
        daily_bars=[
            StockDailyBar(
                code="600177",
                trade_date=date(2026, 11, 20),
                open=8.0,
                high=8.1,
                low=7.9,
                close=8.0,
                total_mv_yuan=360e8,
                pe_ttm=12.0,
                pb=0.9,
            )
        ],
        annual_reports=inv_reports,
        dividends=[],
        repurchases=[],
        pledge=StockPledgeSnapshot(
            code="600177", trade_date=date(2026, 11, 20), pledge_ratio_pct=1.0
        ),
        equity_financings=[],
    )
    snap = build_stock_snapshot(
        meta_inv, bundle, generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC)
    )
    assert snap.forensics is not None
    assert snap.forensics.earnings_quality_tag == "investment_driven"
    assert snap.peer_metrics.earnings_quality_tag == "investment_driven"
    assert snap.peer_metrics.invest_profit_share_3y_pct == pytest.approx(120.0)
    assert any("对外投资驱动诊断" in bc for bc in snap.radar.bear_cases)
    all_nums, _ = collect_allowed_snapshot_numbers(snap)
    assert "120" in all_nums and "52" in all_nums

    # Moderate investment share (25% <= share < 50%) triggers yellow warning.
    mid_reports = [
        _forensic_report(
            y,
            code="600178",
            operate_profit=30e8,
            invest_income=9e8,
            fair_value_change=1.5e8,
            other_income=0.3e8,
            net_profit=24e8,
            deduct_net_profit=23e8,
        )
        for y in range(2023, 2026)
    ]
    mid_forensics = analyze_stock_forensics(mid_reports, meta_inv, is_financial=False)
    mid_inv_finding = next(
        f for f in mid_forensics.findings if f.finding_id == "investment_reliance"
    )
    assert mid_inv_finding.status == "yellow"
    assert "股权分红协同" in mid_inv_finding.headline


def test_forensics_subsidy_leveraged_roe_cashflow_and_financial_exemption() -> None:
    subsidy_reports = [
        _forensic_report(
            y,
            operate_profit=12e8,
            invest_income=0.0,
            fair_value_change=0.0,
            other_income=6e8,
            asset_disposal=1e8,
            nonbusiness_net=0.5e8,
            net_profit=10e8,
            deduct_net_profit=3e8,
            ocf=10e8,
        )
        for y in range(2023, 2026)
    ]
    sub_forensics = analyze_stock_forensics(subsidy_reports, is_financial=False)
    assert sub_forensics.earnings_quality_tag == "subsidy_inflated"
    sub_finding = next(f for f in sub_forensics.findings if f.finding_id == "non_recurring_subsidy")
    assert sub_finding.status == "red"

    lev_reports = [
        _forensic_report(
            y,
            revenue=300e8,
            operate_profit=20e8,
            invest_income=0.0,
            other_income=0.0,
            net_profit=15e8,
            deduct_net_profit=14.5e8,
            total_assets=350e8,
            total_equity=100e8,
            parent_equity=100e8,
            ocf=18e8,
            interest_expense=1e8,
        )
        for y in range(2021, 2026)
    ]
    lev_forensics = analyze_stock_forensics(lev_reports, is_financial=False)
    assert lev_forensics.earnings_quality_tag == "leveraged_roe"
    assert lev_forensics.dupont_equity_multiplier_5y_avg == pytest.approx(3.5)
    assert lev_forensics.dupont_net_margin_5y_avg_pct == pytest.approx(5.0)
    dp_finding = next(f for f in lev_forensics.findings if f.finding_id == "dupont_attribution")
    assert dp_finding.status == "yellow"

    cf_reports = [
        _forensic_report(
            y,
            operate_profit=20e8,
            invest_income=0.0,
            other_income=0.0,
            net_profit=14e8,
            deduct_net_profit=14e8,
            interest_expense=7e8,
            ocf=8e8,
            capex=10e8,
            short_loan=20e8 if y == 2021 else 60e8,
        )
        for y in range(2021, 2026)
    ]
    cf_forensics = analyze_stock_forensics(
        cf_reports,
        equity_financings=[
            StockEquityFinancingRecord(
                code="600519",
                year=2024,
                event_date=date(2024, 12, 31),
                source="cash_flow",
                financing_type="cash_flow",
                amount_yuan=30e8,
            ),
            StockEquityFinancingRecord(
                code="600519",
                year=2024,
                event_date=date(2024, 6, 1),
                source="add_stock",
                financing_type="定增",
                amount_yuan=25e8,
            ),
        ],
        is_financial=False,
    )
    assert cf_forensics.earnings_quality_tag == "cashflow_divergent"
    assert cf_forensics.ocf_to_core_profit_3y_pct == pytest.approx(40.0)
    assert cf_forensics.interest_burden_pct == pytest.approx(25.93)
    assert cf_forensics.capital_allocation is not None
    assert cf_forensics.capital_allocation.total_equity_financing_yuan == pytest.approx(30e8)
    assert cf_forensics.capital_allocation.net_debt_change_yuan == pytest.approx(40e8)

    bank_meta = StockMetaRecord(code="600036", name="招商银行", exchange="SH", industry_sw1="银行")
    bank_reports = [
        _forensic_report(
            y,
            code="600036",
            revenue=3400e8,
            operate_profit=1800e8,
            invest_income=500e8,
            net_profit=1400e8,
            deduct_net_profit=1380e8,
            total_assets=110000e8,
            total_equity=10000e8,
            parent_equity=10000e8,
            ocf=-500e8,
        )
        for y in range(2021, 2026)
    ]
    bank_forensics = analyze_stock_forensics(bank_reports, bank_meta)
    assert bank_forensics.earnings_quality_tag == "financial_special"
    assert bank_forensics.earnings_quality_label == "金融特殊结构"
    assert bank_forensics.dupont_asset_turnover_5y_avg is None
    assert bank_forensics.core_profit_share_3y_pct is None


async def test_parquet_and_pg_snapshot_backward_compatibility(tmp_path: Path) -> None:
    # Seed a legacy 2024 annual Parquet file lacking the 13 new Stage 3 columns.
    legacy_dir = tmp_path / "fundamentals" / "annual" / "report_year=2024"
    legacy_dir.mkdir(parents=True, exist_ok=True)
    legacy_schema = pa.schema(
        [
            ("code", pa.string()),
            ("report_year", pa.int32()),
            ("report_date", pa.date32()),
            ("notice_date", pa.date32()),
            ("update_date", pa.date32()),
            ("audit_opinion", pa.string()),
            ("revenue_yuan", pa.float64()),
            ("operate_cost_yuan", pa.float64()),
            ("net_profit_yuan", pa.float64()),
            ("deduct_net_profit_yuan", pa.float64()),
            ("research_expense_yuan", pa.float64()),
            ("interest_expense_yuan", pa.float64()),
            ("finance_expense_yuan", pa.float64()),
            ("total_assets_yuan", pa.float64()),
            ("total_liabilities_yuan", pa.float64()),
            ("total_equity_yuan", pa.float64()),
            ("parent_equity_yuan", pa.float64()),
            ("monetary_funds_yuan", pa.float64()),
            ("trade_fin_assets_yuan", pa.float64()),
            ("short_loan_yuan", pa.float64()),
            ("noncurrent_liab_1y_yuan", pa.float64()),
            ("long_loan_yuan", pa.float64()),
            ("bond_payable_yuan", pa.float64()),
            ("short_bond_payable_yuan", pa.float64()),
            ("lease_liab_yuan", pa.float64()),
            ("cip_yuan", pa.float64()),
            ("fixed_asset_yuan", pa.float64()),
            ("accounts_receivable_yuan", pa.float64()),
            ("note_accounts_rece_yuan", pa.float64()),
            ("inventory_yuan", pa.float64()),
            ("goodwill_yuan", pa.float64()),
            ("share_capital_yuan", pa.float64()),
            ("ocf_yuan", pa.float64()),
            ("capex_yuan", pa.float64()),
            ("accept_invest_cash_yuan", pa.float64()),
            ("subsidiary_accept_invest_yuan", pa.float64()),
            ("cash_dividend_paid_yuan", pa.float64()),
        ]
    )
    legacy_row = {name: None for name in legacy_schema.names}
    legacy_row.update(
        {
            "code": "600519",
            "report_year": 2024,
            "report_date": date(2024, 12, 31),
            "revenue_yuan": 1600e8,
            "net_profit_yuan": 800e8,
            "deduct_net_profit_yuan": 795e8,
            "total_assets_yuan": 2800e8,
            "total_equity_yuan": 2200e8,
            "parent_equity_yuan": 2150e8,
            "ocf_yuan": 820e8,
        }
    )
    pq.write_table(
        pa.Table.from_pylist([legacy_row], schema=legacy_schema), legacy_dir / "data.parquet"
    )

    store = DuckDBStockFactStore(tmp_path)
    bundle_2025 = StockFactBundle(
        code="600519",
        as_of=date(2026, 11, 20),
        daily_bars=[
            StockDailyBar(
                code="600519",
                trade_date=date(2026, 11, 20),
                open=1450.0,
                high=1460.0,
                low=1440.0,
                close=1455.0,
                total_mv_yuan=18200e8,
                pe_ttm=22.0,
                pb=6.5,
            )
        ],
        annual_reports=[_forensic_report(2025, code="600519")],
        dividends=[],
        repurchases=[],
        pledge=None,
        equity_financings=[],
    )
    await store.write_stock_facts(bundle_2025)

    # DuckDB union_by_name must return BOTH 2024 (None new cols) and 2025 (populated new cols).
    loaded = await store.load_stock_facts("600519")
    assert loaded is not None
    assert [r.report_year for r in loaded.annual_reports] == [2024, 2025]
    assert loaded.annual_reports[0].operate_profit_yuan is None
    assert loaded.annual_reports[1].operate_profit_yuan == pytest.approx(40e8)
    assert loaded.annual_reports[1].long_equity_invest_yuan == pytest.approx(2e8)

    # Rewriting 2024 for another stock must align the legacy 2024 table cleanly.
    bundle_000333_2024 = bundle_2025.model_copy(
        update={
            "code": "000333",
            "daily_bars": [bundle_2025.daily_bars[0].model_copy(update={"code": "000333"})],
            "annual_reports": [_forensic_report(2024, code="000333")],
        }
    )
    await store.write_stock_facts(bundle_000333_2024)
    loaded_333 = await store.load_stock_facts("000333")
    assert loaded_333 is not None and loaded_333.annual_reports[
        0
    ].operate_profit_yuan == pytest.approx(40e8)

    # Pre-Stage-3 StockSnapshotPayload JSON lacking forensics & new peer_metrics validates cleanly.
    meta = StockMetaRecord(code="600519", name="贵州茅台", exchange="SH", industry_sw1="食品饮料")
    snap = build_stock_snapshot(meta, loaded, generated_at=datetime(2026, 11, 20, 9, 0, tzinfo=UTC))
    legacy_json = snap.model_dump(mode="json")
    legacy_json.pop("forensics", None)
    for k in (
        "earnings_quality_tag",
        "earnings_quality_label",
        "invest_profit_share_3y_pct",
        "investment_assets_ratio_pct",
    ):
        legacy_json["peer_metrics"].pop(k, None)
    validated = StockSnapshotPayload.model_validate(legacy_json)
    assert validated.forensics is None
    assert validated.peer_metrics.earnings_quality_tag is None

    # Legacy Parquet rows with trade_fin_assets_yuan=0.0 and absent Stage-3 columns stay None.
    legacy_only_row = dict(legacy_row)
    legacy_only_row["code"] = "000858"
    legacy_only_row["trade_fin_assets_yuan"] = 0.0
    legacy_only_dir = tmp_path / "fundamentals" / "annual" / "report_year=2023"
    legacy_only_dir.mkdir(parents=True, exist_ok=True)
    pq.write_table(
        pa.Table.from_pylist(
            [{**legacy_only_row, "report_year": 2023, "report_date": date(2023, 12, 31)}],
            schema=legacy_schema,
        ),
        legacy_only_dir / "data.parquet",
    )
    loaded_legacy_only = await store.load_stock_facts("000858")
    assert loaded_legacy_only is not None
    legacy_forensics = analyze_stock_forensics(
        loaded_legacy_only.annual_reports, is_financial=False
    )
    assert legacy_forensics.investment_assets_yuan is None
    assert legacy_forensics.investment_assets_ratio_pct is None


def test_eastmoney_impairment_sign_normalization_and_pre2018_dedup() -> None:
    ps_600177 = pd.DataFrame(
        [
            {
                "REPORT_DATE": "2017-12-31 00:00:00",
                "REPORT_TYPE": "年报",
                "ASSET_IMPAIRMENT_LOSS": 31.90e8,
                "PARENT_NETPROFIT": 3.0e8,
            },
            {
                "REPORT_DATE": "2025-12-31 00:00:00",
                "REPORT_TYPE": "年报",
                "ASSET_IMPAIRMENT_INCOME": -6.50e8,
                "CREDIT_IMPAIRMENT_INCOME": -0.40e8,
                "PARENT_NETPROFIT": 28.0e8,
            },
        ]
    )
    r_600177 = parse_annual_reports(
        "600177", balance_df=pd.DataFrame(), profit_df=ps_600177, cash_flow_df=pd.DataFrame()
    )
    assert r_600177[0].report_year == 2017
    assert r_600177[0].impairment_net_yuan == pytest.approx(-31.90e8)
    assert r_600177[1].report_year == 2025
    assert r_600177[1].impairment_net_yuan == pytest.approx(-6.90e8)

    ps_600036 = pd.DataFrame(
        [
            {
                "REPORT_DATE": "2017-12-31 00:00:00",
                "REPORT_TYPE": "年报",
                "ASSET_IMPAIRMENT_LOSS": 599.26e8,
                "CREDIT_IMPAIRMENT_LOSS": 599.22e8,
                "PARENT_NETPROFIT": 701.5e8,
            },
            {
                "REPORT_DATE": "2025-12-31 00:00:00",
                "REPORT_TYPE": "年报",
                "CREDIT_IMPAIRMENT_LOSS": 395.86e8,
                "PARENT_NETPROFIT": 1480.0e8,
            },
        ]
    )
    r_600036 = parse_annual_reports(
        "600036", balance_df=pd.DataFrame(), profit_df=ps_600036, cash_flow_df=pd.DataFrame()
    )
    assert r_600036[0].impairment_net_yuan == pytest.approx(-599.26e8)
    assert r_600036[1].impairment_net_yuan == pytest.approx(-395.86e8)


def test_forensics_adversarial_math_boundaries() -> None:
    offset_reports = [
        _forensic_report(
            2023,
            operate_profit=10e8,
            invest_income=0.0,
            other_income=0.0,
            net_profit=8e8,
            deduct_net_profit=8e8,
            ocf=15e8,
        ),
        _forensic_report(
            2024,
            operate_profit=10e8,
            invest_income=0.0,
            other_income=0.0,
            net_profit=8e8,
            deduct_net_profit=8e8,
            ocf=15e8,
        ),
        _forensic_report(
            2025,
            operate_profit=-21e8,
            invest_income=-30e8,
            other_income=0.0,
            net_profit=-18e8,
            deduct_net_profit=-18e8,
            ocf=15e8,
        ),
    ]
    offset_forensics = analyze_stock_forensics(offset_reports, is_financial=False)
    assert offset_forensics.earnings_quality_tag != "core_cash_cow"
    assert offset_forensics.core_profit_share_3y_pct == pytest.approx(49.15)
    assert offset_forensics.invest_profit_share_3y_pct == pytest.approx(-50.85)
    assert -100.0 <= offset_forensics.core_profit_share_3y_pct <= 100.0

    deep_loss_reports = [
        _forensic_report(
            y,
            operate_profit=-100e8,
            invest_income=1e8,
            other_income=0.0,
            net_profit=-90e8,
            deduct_net_profit=-90e8,
            ocf=-50e8,
            interest_expense=0.0,
        )
        for y in range(2023, 2026)
    ]
    deep_loss_forensics = analyze_stock_forensics(deep_loss_reports, is_financial=False)
    assert deep_loss_forensics.earnings_quality_tag != "investment_driven"
    assert deep_loss_forensics.invest_profit_share_3y_pct is not None
    assert deep_loss_forensics.invest_profit_share_3y_pct < 2.0
    cf_loss = next(
        f for f in deep_loss_forensics.findings if f.finding_id == "cashflow_core_conversion"
    )
    assert cf_loss.status == "red"
    assert "主业经营亏损且现金流净流出" in cf_loss.headline
    assert "—" not in cf_loss.detail

    minor_inv_loss = [
        _forensic_report(
            y,
            operate_profit=-1e8,
            invest_income=0.6e8,
            other_income=0.0,
            net_profit=-0.8e8,
            deduct_net_profit=-0.8e8,
            ocf=1e8,
            interest_expense=0.0,
        )
        for y in range(2023, 2026)
    ]
    minor_inv_forensics = analyze_stock_forensics(minor_inv_loss, is_financial=False)
    assert minor_inv_forensics.invest_profit_share_3y_pct == pytest.approx(27.27)
    assert minor_inv_forensics.earnings_quality_tag != "investment_driven"

    vat_refund_reports = [
        _forensic_report(
            y,
            operate_profit=10e8,
            invest_income=0.0,
            other_income=3.5e8,
            asset_disposal=0.0,
            nonbusiness_net=0.0,
            net_profit=7.5e8,
            deduct_net_profit=7.5e8,
            ocf=8e8,
        )
        for y in range(2023, 2026)
    ]
    vat_forensics = analyze_stock_forensics(vat_refund_reports, is_financial=False)
    assert vat_forensics.non_recurring_share_3y_pct == pytest.approx(0.0)
    assert vat_forensics.earnings_quality_tag != "subsidy_inflated"
    vat_finding = next(f for f in vat_forensics.findings if f.finding_id == "non_recurring_subsidy")
    assert vat_finding.status == "green"

    ebit_reports = [
        _forensic_report(
            y,
            operate_profit=50e8,
            invest_income=0.0,
            other_income=0.0,
            net_profit=35e8,
            deduct_net_profit=35e8,
            interest_expense=50e8,
            ocf=45e8,
        )
        for y in range(2023, 2026)
    ]
    ebit_forensics = analyze_stock_forensics(ebit_reports, is_financial=False)
    assert ebit_forensics.interest_burden_pct == pytest.approx(50.0)
    assert (
        next(
            f for f in ebit_forensics.findings if f.finding_id == "cashflow_core_conversion"
        ).status
        == "red"
    )

    no_ocf_int_reports = [
        StockAnnualReport(
            code="600519",
            report_year=y,
            report_date=date(y, 12, 31),
            revenue_yuan=100e8,
            operate_profit_yuan=-5e8,
            invest_income_yuan=0.0,
            other_income_yuan=0.0,
            interest_expense_yuan=2e8,
            ocf_yuan=None,
        )
        for y in range(2023, 2026)
    ]
    no_ocf_forensics = analyze_stock_forensics(no_ocf_int_reports, is_financial=False)
    no_ocf_cf = next(
        f for f in no_ocf_forensics.findings if f.finding_id == "cashflow_core_conversion"
    )
    assert no_ocf_cf.status == "red"
    assert "—" not in no_ocf_cf.detail

    neg_eq_reports = [
        _forensic_report(
            2021,
            revenue=100e8,
            net_profit=5e8,
            total_assets=200e8,
            total_equity=50e8,
            parent_equity=50e8,
        ),
        _forensic_report(
            2022,
            revenue=100e8,
            net_profit=-60e8,
            total_assets=180e8,
            total_equity=-10e8,
            parent_equity=-10e8,
        ),
        _forensic_report(
            2023,
            revenue=100e8,
            net_profit=15e8,
            total_assets=190e8,
            total_equity=5e8,
            parent_equity=5e8,
        ),
        _forensic_report(
            2025,
            revenue=120e8,
            net_profit=20e8,
            total_assets=210e8,
            total_equity=25e8,
            parent_equity=25e8,
        ),
    ]
    dp_forensics = analyze_stock_forensics(neg_eq_reports, is_financial=False)
    by_year_dp = {pt.year: pt for pt in dp_forensics.dupont_series}
    assert by_year_dp[2022].roe_pct is None
    assert by_year_dp[2023].roe_pct is None
    assert by_year_dp[2023].equity_multiplier is None
    assert by_year_dp[2025].roe_pct == pytest.approx(80.0)
    dp_finding = next(f for f in dp_forensics.findings if f.finding_id == "dupont_attribution")
    assert "=" not in dp_finding.detail

    neg_margin_lev = [
        _forensic_report(
            y,
            revenue=100e8,
            net_profit=-5e8,
            deduct_net_profit=-5e8,
            total_assets=400e8,
            total_equity=100e8,
            parent_equity=100e8,
            ocf=10e8,
        )
        for y in range(2021, 2026)
    ]
    assert (
        analyze_stock_forensics(neg_margin_lev, is_financial=False).earnings_quality_tag
        != "leveraged_roe"
    )

    div_lead_reports = [
        _forensic_report(y, monetary_funds=60e8 if y == 2020 else 80e8) for y in range(2020, 2025)
    ]
    div_lead_divs = [
        StockDividendRecord(
            code="600519",
            report_date=date(y, 12, 31),
            report_year=y,
            plan_progress="实施分配",
            cash_per_10_shares=10.0,
            total_shares=10e8,
            dividend_cash_total_yuan=10e8,
        )
        for y in range(2020, 2026)
    ]
    div_lead_forensics = analyze_stock_forensics(
        div_lead_reports,
        dividends=div_lead_divs,
        as_of=date(2025, 12, 31),
        is_financial=False,
    )
    assert div_lead_forensics.capital_allocation is not None
    assert div_lead_forensics.capital_allocation.total_dividends_yuan == pytest.approx(50e8)
    assert div_lead_forensics.capital_allocation.net_debt_change_yuan == pytest.approx(-20e8)
