"""Unit and mathematical formula tests for Phase 2 pure domain engines."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta

import pytest

from app.domain.engines import (
    analyze_shareholder_return,
    build_stock_snapshot,
    compute_reverse_dcf,
    dcf_present_value,
    is_financial_institution,
    scan_financial_ct,
    solve_implied_fcf_cagr_pct,
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
)


def _make_report(
    year: int,
    *,
    code: str = "600519",
    revenue: float = 100e8,
    cost: float = 40e8,
    net_profit: float = 20e8,
    deduct_profit: float = 19e8,
    ocf: float = 24e8,
    capex: float = 4e8,
    monetary_funds: float = 40e8,
    trade_fin: float = 0.0,
    short_loan: float = 2e8,
    long_loan: float = 1e8,
    cip: float = 2e8,
    fixed_asset: float = 30e8,
    receivable: float = 5e8,
    inventory: float = 10e8,
    goodwill: float = 1e8,
    total_assets: float = 200e8,
    parent_equity: float = 120e8,
    total_equity: float = 125e8,
    research_expense: float = 3e8,
    interest_expense: float = 0.1e8,
    audit_opinion: str | None = "标准无保留意见",
    accept_invest: float = 0.0,
    sub_accept_invest: float = 0.0,
) -> StockAnnualReport:
    return StockAnnualReport(
        code=code,
        report_year=year,
        report_date=date(year, 12, 31),
        audit_opinion=audit_opinion,
        revenue_yuan=revenue,
        operate_cost_yuan=cost,
        net_profit_yuan=net_profit,
        deduct_net_profit_yuan=deduct_profit,
        research_expense_yuan=research_expense,
        interest_expense_yuan=interest_expense,
        total_assets_yuan=total_assets,
        total_equity_yuan=total_equity,
        parent_equity_yuan=parent_equity,
        monetary_funds_yuan=monetary_funds,
        trade_fin_assets_yuan=trade_fin,
        short_loan_yuan=short_loan,
        long_loan_yuan=long_loan,
        cip_yuan=cip,
        fixed_asset_yuan=fixed_asset,
        accounts_receivable_yuan=receivable,
        note_accounts_rece_yuan=receivable,
        inventory_yuan=inventory,
        goodwill_yuan=goodwill,
        ocf_yuan=ocf,
        capex_yuan=capex,
        accept_invest_cash_yuan=accept_invest,
        subsidiary_accept_invest_yuan=sub_accept_invest,
    )


def test_ct_scanner_all_seven_rules_green_and_triggered() -> None:
    clean_reports = [_make_report(y) for y in range(2021, 2026)]
    clean_pledge = StockPledgeSnapshot(
        code="600519", trade_date=date(2026, 11, 20), pledge_ratio_pct=1.2
    )
    clean_ct = scan_financial_ct(clean_reports, clean_pledge)
    assert clean_ct.overall_status == "green"
    assert clean_ct.red_count == 0
    assert clean_ct.yellow_count == 0
    assert clean_ct.green_count == 7
    assert {c.rule_id for c in clean_ct.checks} == {
        "dual_high_cash_debt",
        "stalled_cip",
        "ocf_profit_divergence",
        "receivable_inventory_bloat",
        "goodwill_overhang",
        "shareholder_pledge",
        "audit_opinion",
    }
    for check in clean_ct.checks:
        assert check.status == "green"
        assert check.evidences

    # Construct multi-year red flags for every single rule simultaneously.
    red_reports = [
        _make_report(
            2023,
            revenue=100e8,
            net_profit=20e8,
            ocf=5e8,
            monetary_funds=60e8,
            short_loan=35e8,
            long_loan=15e8,
            cip=32e8,
            fixed_asset=25e8,
            receivable=25e8,
            inventory=20e8,
            goodwill=40e8,
            total_assets=200e8,
            parent_equity=100e8,
            audit_opinion="标准无保留意见",
        ),
        _make_report(
            2024,
            revenue=100e8,
            net_profit=20e8,
            ocf=4e8,
            monetary_funds=62e8,
            short_loan=36e8,
            long_loan=16e8,
            cip=34e8,
            fixed_asset=25e8,
            receivable=40e8,
            inventory=35e8,
            goodwill=40e8,
            total_assets=200e8,
            parent_equity=100e8,
            audit_opinion="带强调事项段的无保留意见",
        ),
        _make_report(
            2025,
            revenue=100e8,
            net_profit=20e8,
            ocf=3e8,
            monetary_funds=65e8,
            short_loan=40e8,
            long_loan=15e8,
            cip=36e8,
            fixed_asset=24e8,
            receivable=50e8,
            inventory=40e8,
            goodwill=45e8,
            total_assets=200e8,
            parent_equity=100e8,
            audit_opinion="保留意见",
        ),
    ]
    red_pledge = StockPledgeSnapshot(
        code="600519", trade_date=date(2026, 11, 20), pledge_ratio_pct=42.5
    )
    red_ct = scan_financial_ct(red_reports, red_pledge)
    assert red_ct.overall_status == "red"
    assert red_ct.red_count == 7
    assert red_ct.yellow_count == 0
    assert red_ct.green_count == 0

    by_id = {c.rule_id: c for c in red_ct.checks}
    assert [e.year for e in by_id["dual_high_cash_debt"].evidences] == [2023, 2024, 2025]
    assert by_id["dual_high_cash_debt"].evidences[-1].metrics["cash_to_assets_pct"] == 32.5
    assert by_id["goodwill_overhang"].evidences[-1].metrics["goodwill_to_equity_pct"] == 45.0
    assert by_id["shareholder_pledge"].evidences[0].metrics["pledge_ratio_pct"] == 42.5
    assert by_id["audit_opinion"].evidences[-1].metrics["audit_opinion"] == "保留意见"

    # Prior-year non-clean audit opinion triggers yellow even if latest is standard unqualified.
    recovered_reports = [
        _make_report(2023, audit_opinion="保留意见"),
        _make_report(2024, audit_opinion="标准无保留意见"),
        _make_report(2025, audit_opinion="标准无保留意见"),
    ]
    recovered_ct = scan_financial_ct(recovered_reports, None)
    recovered_by_id = {c.rule_id: c for c in recovered_ct.checks}
    assert recovered_by_id["audit_opinion"].status == "yellow"
    assert recovered_by_id["shareholder_pledge"].status == "na"


def test_ct_scanner_exempts_banking_sector_from_cash_debt_and_inventory() -> None:
    bank_meta = StockMetaRecord(code="000001", name="平安银行", exchange="SZ", industry_sw1="银行")
    bank_ct = scan_financial_ct([_make_report(2025, code="000001")], None, meta=bank_meta)
    by_id = {c.rule_id: c for c in bank_ct.checks}
    assert by_id["dual_high_cash_debt"].status == "na"
    assert by_id["receivable_inventory_bloat"].status == "na"


def test_shareholder_return_coverage_and_fake_high_dividend_flags() -> None:
    reports = [_make_report(y, ocf=30e8, capex=5e8) for y in range(2021, 2026)]
    dividends = [
        StockDividendRecord(
            code="600519",
            report_date=date(y, 12, 31),
            report_year=y,
            plan_progress="实施分配",
            cash_per_10_shares=10.0,
            total_shares=10e8,
            dividend_cash_total_yuan=10e8,
        )
        for y in range(2021, 2026)
    ]
    repurchases = [
        StockRepurchaseRecord(
            code="600519",
            event_date=date(2025, 8, 1),
            year=2025,
            progress="完成实施",
            repurchased_amount_yuan=5e8,
        )
    ]
    # Same-year cash_flow and add_stock equity financing should NOT double count (takes max=2e8).
    financings = [
        StockEquityFinancingRecord(
            code="600519",
            year=2022,
            event_date=date(2022, 6, 1),
            source="cash_flow",
            financing_type="cash_flow",
            amount_yuan=2e8,
        ),
        StockEquityFinancingRecord(
            code="600519",
            year=2022,
            event_date=date(2022, 6, 15),
            source="add_stock",
            financing_type="定增",
            amount_yuan=1.5e8,
        ),
    ]

    healthy = analyze_shareholder_return(
        reports,
        dividends,
        repurchases,
        financings,
        latest_market_cap_yuan=500e8,
        as_of=date(2026, 11, 20),
    )
    assert healthy.window_years == 5
    assert healthy.total_dividend_yuan == pytest.approx(50e8)
    assert healthy.total_repurchase_yuan == pytest.approx(5e8)
    assert healthy.total_equity_financing_yuan == pytest.approx(2e8)
    assert healthy.net_return_yuan == pytest.approx(53e8)
    assert healthy.total_fcf_yuan == pytest.approx(125e8)
    assert healthy.fcf_coverage_ratio == pytest.approx(round(125e8 / 53e8, 2))
    assert healthy.current_dividend_yield_pct == pytest.approx(2.0)
    assert healthy.status == "green"

    # Fake high dividend: FCF negative while paying 10e8/year dividends.
    weak_fcf_reports = [_make_report(y, ocf=2e8, capex=8e8) for y in range(2021, 2026)]
    fake_div = analyze_shareholder_return(
        weak_fcf_reports,
        dividends,
        [],
        [],
        latest_market_cap_yuan=200e8,
    )
    assert fake_div.status == "red"
    assert "伪高股息" in fake_div.verdict

    # Equity financing drains more cash than dividends + buybacks -> red.
    heavy_financing = [
        StockEquityFinancingRecord(
            code="600519",
            year=2024,
            event_date=date(2024, 5, 1),
            source="add_stock",
            financing_type="增发",
            amount_yuan=80e8,
        )
    ]
    drain = analyze_shareholder_return(reports, dividends, [], heavy_financing)
    assert drain.net_return_yuan == pytest.approx(-30e8)
    assert drain.status == "red"

    empty = analyze_shareholder_return([], [], [], [])
    assert empty.status == "na"


def test_reverse_dcf_round_trip_guards_and_sensitivity() -> None:
    # Construct EV = Market Cap - Net Cash = 250e8 - 50e8 = 200e8 and verify exact inversion.
    base_fcf = 12e8
    true_g = 0.08
    target_ev = dcf_present_value(base_fcf, true_g, 0.09, 12.0, horizon_years=10)
    solved_g_pct = solve_implied_fcf_cagr_pct(target_ev, base_fcf)
    assert solved_g_pct == pytest.approx(8.0, abs=0.02)

    reports = [
        _make_report(
            y,
            revenue=100e8 * (1.06 ** (y - 2020)),
            ocf=15e8,
            capex=3e8,
            monetary_funds=60e8,
            short_loan=10e8,
            long_loan=0.0,
        )
        for y in range(2020, 2026)
    ]
    net_cash = 50e8
    mcap = target_ev + net_cash
    sec = compute_reverse_dcf(reports, market_cap_yuan=mcap)
    assert sec.solvable is True
    assert sec.base_fcf_years == 3
    assert sec.base_fcf_yuan == pytest.approx(12e8)
    assert sec.net_cash_yuan == pytest.approx(50e8)
    assert sec.enterprise_value_yuan == pytest.approx(target_ev, rel=1e-6)
    assert sec.implied_fcf_cagr_pct == pytest.approx(8.0, abs=0.02)
    assert sec.historical_revenue_cagr_pct == pytest.approx(6.0, abs=0.05)
    assert sec.implied_vs_history_gap_pct == pytest.approx(2.0, abs=0.06)
    assert len(sec.sensitivity) == 9
    assert {(row.discount_rate_pct, row.terminal_multiple) for row in sec.sensitivity} == {
        (r, m) for r in (8.0, 9.0, 10.0) for m in (10.0, 12.0, 15.0)
    }

    by_grid = {
        (r.discount_rate_pct, r.terminal_multiple): r.implied_fcf_cagr_pct for r in sec.sensitivity
    }
    assert by_grid[(8.0, 12.0)] is not None and by_grid[(10.0, 12.0)] is not None
    assert by_grid[(8.0, 12.0)] < by_grid[(9.0, 12.0)] < by_grid[(10.0, 12.0)]  # type: ignore[operator]
    assert by_grid[(9.0, 15.0)] < by_grid[(9.0, 12.0)] < by_grid[(9.0, 10.0)]  # type: ignore[operator]

    # Guard: negative FCF -> solvable=False
    neg_fcf_reports = [_make_report(y, ocf=2e8, capex=5e8) for y in range(2023, 2026)]
    neg_sec = compute_reverse_dcf(neg_fcf_reports, market_cap_yuan=200e8)
    assert neg_sec.solvable is False
    assert "自由现金流非正" in neg_sec.note

    # Guard: EV <= 0 (net cash exceeds market cap) -> solvable=False
    net_cash_heavy = [
        _make_report(y, monetary_funds=300e8, short_loan=0.0, long_loan=0.0)
        for y in range(2023, 2026)
    ]
    ev_neg = compute_reverse_dcf(net_cash_heavy, market_cap_yuan=250e8)
    assert ev_neg.solvable is False
    assert "EV ≤ 0" in ev_neg.note


def test_build_stock_snapshot_full_percentile_accuracy_and_history_cap() -> None:
    meta = StockMetaRecord(
        code="600519",
        name="贵州茅台",
        exchange="SH",
        industry_sw1="食品饮料",
        industry_sw2="白酒",
        list_date=date(2001, 8, 27),
    )
    reports = [
        _make_report(
            y,
            revenue=100e8 * (1.12 ** (y - 2016)),
            cost=10e8 * (1.12 ** (y - 2016)),
            net_profit=40e8 * (1.12 ** (y - 2016)),
            deduct_profit=39e8 * (1.12 ** (y - 2016)),
            ocf=45e8 * (1.12 ** (y - 2016)),
            capex=4e8,
            monetary_funds=80e8,
            short_loan=0.0,
            long_loan=0.0,
        )
        for y in range(2016, 2026)
    ]

    # Build 2500 daily bars (~10 years of calendar/trading days) with rising then dipping PE.
    start = date(2017, 1, 3)
    bars: list[StockDailyBar] = []
    for i in range(2500):
        d = start + timedelta(days=i)
        if d.weekday() >= 5:
            continue
        pe = 20.0 + (i % 40) * 0.5
        pb = 5.0 + (i % 20) * 0.2
        close = 1000.0 + i * 0.2
        bars.append(
            StockDailyBar(
                code="600519",
                trade_date=d,
                open=close - 5.0,
                high=close + 10.0,
                low=close - 10.0,
                close=close,
                total_mv_yuan=15000e8,
                pe_ttm=pe,
                pb=pb,
            )
        )
    # Force exact known latest bar values on as_of.
    as_of = bars[-1].trade_date
    bars[-1] = bars[-1].model_copy(update={"close": 1485.0, "pe_ttm": 22.0, "pb": 6.0})

    bundle = StockFactBundle(
        code="600519",
        as_of=as_of,
        data_source="akshare",
        daily_bars=bars,
        annual_reports=reports,
        dividends=[
            StockDividendRecord(
                code="600519",
                report_date=date(2025, 12, 31),
                report_year=2025,
                plan_progress="实施分配",
                cash_per_10_shares=280.0,
                total_shares=12.5e8,
                dividend_cash_total_yuan=350e8,
            )
        ],
        repurchases=[],
        pledge=StockPledgeSnapshot(code="600519", trade_date=as_of, pledge_ratio_pct=0.0),
        equity_financings=[],
    )

    snapshot = build_stock_snapshot(
        meta, bundle, generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC)
    )

    assert snapshot.code == "600519"
    assert snapshot.as_of == as_of
    assert len(snapshot.annual_trends) == 10
    assert len(snapshot.valuation.history) <= 260
    assert snapshot.valuation.history[-1].trade_date == as_of

    # Verify exact percentile computed over ALL bars, not just the 260 sampled chart points.
    all_pe = [b.pe_ttm for b in bars if b.pe_ttm is not None and b.pe_ttm > 0]
    less = sum(1 for v in all_pe if v < 22.0)
    eq = sum(1 for v in all_pe if v == 22.0)
    expected_pe_10y = round(((less + 0.5 * eq) / len(all_pe)) * 100.0, 1)
    assert snapshot.valuation.pe_percentile_10y == pytest.approx(expected_pe_10y)

    expected_graham = round(1485.0 * (22.5 / (22.0 * 6.0)) ** 0.5, 2)
    assert snapshot.valuation.graham_number == pytest.approx(expected_graham)
    assert snapshot.valuation.peg is not None and snapshot.valuation.peg > 0

    assert len(snapshot.moat.dimensions) == 6
    assert 0 <= snapshot.radar.total_score <= 100
    assert snapshot.radar.bear_cases
    assert snapshot.peer_metrics.code == "600519"
    assert snapshot.peer_metrics.ct_red_count == 0
    assert snapshot.formula_notes

    # Strict JSON finite-float compliance (no NaN/Inf anywhere).
    dumped = json.dumps(snapshot.model_dump(mode="json"), allow_nan=False)
    assert dumped


def test_peer_shareholder_yield_keeps_latest_fy_dividend_with_partial_year_buyback() -> None:
    meta = StockMetaRecord(
        code="600519",
        name="贵州茅台",
        exchange="SH",
        industry_sw1="食品饮料",
    )
    as_of = date(2026, 11, 20)
    reports = [_make_report(y) for y in range(2021, 2026)]
    bars = [
        StockDailyBar(
            code="600519",
            trade_date=as_of,
            open=1470.0,
            high=1490.0,
            low=1460.0,
            close=1485.0,
            total_mv_yuan=18_500e8,
            pe_ttm=22.5,
            pb=6.8,
        )
    ]
    bundle = StockFactBundle(
        code="600519",
        as_of=as_of,
        data_source="akshare",
        daily_bars=bars,
        annual_reports=reports,
        dividends=[
            StockDividendRecord(
                code="600519",
                report_date=date(2025, 12, 31),
                report_year=2025,
                plan_progress="实施分配",
                cash_per_10_shares=520.0,
                total_shares=12.5e8,
                dividend_cash_total_yuan=650e8,
            )
        ],
        repurchases=[
            # Older than 1y cutoff (2025-11-20): excluded from TTM buybacks.
            StockRepurchaseRecord(
                code="600519",
                event_date=date(2025, 6, 1),
                year=2025,
                progress="完成实施",
                repurchased_amount_yuan=10e8,
            ),
            # Within TTM window [2025-11-20, 2026-11-20]: included.
            StockRepurchaseRecord(
                code="600519",
                event_date=date(2025, 12, 10),
                year=2025,
                progress="完成实施",
                repurchased_amount_yuan=12e8,
            ),
            StockRepurchaseRecord(
                code="600519",
                event_date=date(2026, 8, 15),
                year=2026,
                progress="实施中",
                repurchased_amount_yuan=30e8,
            ),
        ],
        pledge=StockPledgeSnapshot(code="600519", trade_date=as_of, pledge_ratio_pct=0.0),
        equity_financings=[
            StockEquityFinancingRecord(
                code="600519",
                year=2025,
                event_date=date(2025, 12, 31),
                source="cash_flow",
                financing_type="现金流量表-吸收投资(母公司口径)",
                amount_yuan=5e8,
            )
        ],
    )

    snapshot = build_stock_snapshot(
        meta, bundle, generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC)
    )
    assert snapshot.shareholder_return.series[-1].year == 2026
    assert snapshot.shareholder_return.current_dividend_yield_pct == pytest.approx(
        round((650e8 / 18_500e8) * 100.0, 2)
    )
    expected_yield = round(((650e8 + 12e8 + 30e8 - 5e8) / 18_500e8) * 100.0, 2)
    assert snapshot.peer_metrics.shareholder_yield_pct == pytest.approx(expected_yield)


def test_shareholder_return_buyback_only_negative_fcf_and_post_fy_seo() -> None:
    weak_fcf_reports = [_make_report(y, ocf=2e8, capex=8e8) for y in range(2021, 2026)]
    buybacks_only = [
        StockRepurchaseRecord(
            code="600519",
            event_date=date(2025, 8, 1),
            year=2025,
            progress="完成实施",
            repurchased_amount_yuan=5e8,
        )
    ]
    buyback_red = analyze_shareholder_return(weak_fcf_reports, [], buybacks_only, [])
    assert buyback_red.status == "red"
    assert "现金回报警示" in buyback_red.verdict

    tight_fcf_reports = [_make_report(2025, ocf=12e8, capex=4e8)]
    buyback_yellow = analyze_shareholder_return(
        tight_fcf_reports,
        [],
        [
            StockRepurchaseRecord(
                code="600519",
                event_date=date(2025, 8, 1),
                year=2025,
                progress="完成实施",
                repurchased_amount_yuan=10e8,
            )
        ],
        [],
    )
    assert buyback_yellow.status == "yellow"

    # 2026 post-FY SEO dilution after 2025 annual report must advance series & reduce yield.
    as_of = date(2026, 11, 20)
    meta = StockMetaRecord(code="600519", name="贵州茅台", exchange="SH", industry_sw1="食品饮料")
    reports = [_make_report(y) for y in range(2021, 2026)]
    bars = [
        StockDailyBar(
            code="600519",
            trade_date=as_of,
            open=100.0,
            high=100.0,
            low=100.0,
            close=100.0,
            total_mv_yuan=1000e8,
            pe_ttm=20.0,
            pb=4.0,
        )
    ]
    bundle = StockFactBundle(
        code="600519",
        as_of=as_of,
        data_source="akshare",
        daily_bars=bars,
        annual_reports=reports,
        dividends=[
            StockDividendRecord(
                code="600519",
                report_date=date(2025, 12, 31),
                report_year=2025,
                plan_progress="实施分配",
                cash_per_10_shares=20.0,
                total_shares=10e8,
                dividend_cash_total_yuan=20e8,
            )
        ],
        repurchases=[],
        pledge=None,
        equity_financings=[
            StockEquityFinancingRecord(
                code="600519",
                year=2025,
                event_date=date(2025, 12, 31),
                source="cash_flow",
                financing_type="现金流量表-吸收投资",
                amount_yuan=5e8,
            ),
            StockEquityFinancingRecord(
                code="600519",
                year=2026,
                event_date=date(2026, 5, 10),
                source="add_stock",
                financing_type="定向增发",
                amount_yuan=10e8,
            ),
            StockEquityFinancingRecord(
                code="600519",
                year=2027,
                event_date=date(2027, 1, 15),
                source="add_stock",
                financing_type="未来增发",
                amount_yuan=99e8,
            ),
        ],
    )
    snapshot = build_stock_snapshot(
        meta, bundle, generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC)
    )
    assert [p.year for p in snapshot.shareholder_return.series][-1] == 2026
    assert snapshot.shareholder_return.total_equity_financing_yuan == pytest.approx(15e8)
    assert snapshot.peer_metrics.shareholder_yield_pct == pytest.approx(
        round(((20e8 - 5e8 - 10e8) / 1000e8) * 100.0, 2)
    )


def test_zero_profit_and_zero_gm_std_do_not_invert_to_optimistic_fallbacks() -> None:
    meta = StockMetaRecord(code="600519", name="零利润样本", exchange="SH", industry_sw1="制造业")
    as_of = date(2026, 11, 20)
    reports = [
        _make_report(
            y,
            revenue=100e8,
            cost=50e8,
            net_profit=0.0,
            deduct_profit=0.0,
            ocf=0.0,
            capex=0.0,
            parent_equity=-10e8,
            total_equity=-10e8,
            interest_expense=0.0,
        )
        for y in range(2021, 2026)
    ]
    bars = [
        StockDailyBar(
            code="600519",
            trade_date=as_of,
            open=10.0,
            high=10.0,
            low=10.0,
            close=10.0,
            total_mv_yuan=100e8,
        )
    ]
    bundle = StockFactBundle(
        code="600519",
        as_of=as_of,
        data_source="akshare",
        daily_bars=bars,
        annual_reports=reports,
        dividends=[],
        repurchases=[],
        pledge=None,
        equity_financings=[],
    )
    snapshot = build_stock_snapshot(
        meta, bundle, generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC)
    )
    assert snapshot.moat.gross_margin_5y_std_pct == 0.0
    pricing_dim = next(d for d in snapshot.moat.dimensions if d.key == "pricing_power")
    # 50% GM * 0.9 + full 30 stability bonus (not 10 from 0.0 or 5.0) = 75.
    assert pricing_dim.score == 75
    assert snapshot.radar.profitability == 0


def test_financial_sector_exemptions_and_lease_debt_consistency() -> None:
    bank_meta = StockMetaRecord(code="000001", name="平安银行", exchange="SZ", industry_sw1="银行")
    nonbank_meta = StockMetaRecord(
        code="600030", name="中信证券", exchange="SH", industry_sw1="非银金融"
    )
    reports = [
        _make_report(
            y,
            code="000001",
            monetary_funds=500e8,
            short_loan=2000e8,
            ocf=30e8,
            capex=5e8,
        )
        for y in range(2021, 2026)
    ]
    dcf_bank = compute_reverse_dcf(reports, market_cap_yuan=2000e8, meta=bank_meta)
    assert dcf_bank.solvable is False
    assert "传统自由现金流贴现与净现金假设失真" in dcf_bank.note
    assert "PB / ROE" in dcf_bank.note
    assert dcf_bank.net_cash_yuan is None
    assert dcf_bank.enterprise_value_yuan is None
    assert dcf_bank.base_fcf_yuan is None

    as_of = date(2026, 11, 20)
    bundle = StockFactBundle(
        code="600030",
        as_of=as_of,
        data_source="akshare",
        daily_bars=[
            StockDailyBar(
                code="600030",
                trade_date=as_of,
                open=20.0,
                high=20.0,
                low=20.0,
                close=20.0,
                total_mv_yuan=3000e8,
            )
        ],
        annual_reports=[
            _make_report(
                y, code="600030", monetary_funds=500e8, short_loan=2000e8, ocf=30e8, capex=5e8
            )
            for y in range(2021, 2026)
        ],
        dividends=[],
        repurchases=[],
        pledge=None,
        equity_financings=[],
    )
    snap = build_stock_snapshot(
        nonbank_meta, bundle, generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC)
    )
    assert snap.reverse_dcf.solvable is False
    assert snap.peer_metrics.net_cash_to_mv_pct is None
    fortress = next(d for d in snap.moat.dimensions if d.key == "balance_fortress")
    assert fortress.score == 65
    assert "资本充足率" in fortress.summary

    # Non-financial lease liabilities must be included in latest_debt to match net_cash.
    lease_report = _make_report(
        2025,
        monetary_funds=10e8,
        short_loan=0.0,
        long_loan=0.0,
    ).model_copy(update={"lease_liab_yuan": 100e8})
    lease_snap = build_stock_snapshot(
        StockMetaRecord(code="600519", name="租赁样本", exchange="SH", industry_sw1="零售"),
        bundle.model_copy(
            update={
                "code": "600519",
                "daily_bars": [bundle.daily_bars[0].model_copy(update={"code": "600519"})],
                "annual_reports": [lease_report.model_copy(update={"code": "600519"})],
            }
        ),
        generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC),
    )
    lease_fortress = next(d for d in lease_snap.moat.dimensions if d.key == "balance_fortress")
    # net_cash = -90e8, latest_debt = 100e8 -> round(70 - 0.9 * 25) = 48 (not 20 from div by 1.0).
    assert lease_fortress.score == 48


def test_ct_scanner_latest_report_none_stalled_cip_zero_fixed_and_goodwill_edge_cases() -> None:
    prior_red = _make_report(
        2024,
        monetary_funds=60e8,
        short_loan=40e8,
        long_loan=15e8,
        cip=40e8,
        fixed_asset=20e8,
        receivable=60e8,
        inventory=40e8,
        goodwill=50e8,
        total_assets=200e8,
        parent_equity=100e8,
        revenue=100e8,
    )
    sparse_latest = StockAnnualReport(
        code="600519",
        report_year=2025,
        report_date=date(2025, 12, 31),
        audit_opinion="标准无保留意见",
    )
    ct_sparse = scan_financial_ct([prior_red, sparse_latest], None)
    by_id = {c.rule_id: c for c in ct_sparse.checks}
    for rule_id in (
        "dual_high_cash_debt",
        "stalled_cip",
        "receivable_inventory_bloat",
        "goodwill_overhang",
    ):
        assert by_id[rule_id].status == "na"
        assert [e.year for e in by_id[rule_id].evidences] == [2024, 2025]

    # Stalled CIP: cip > 0, fixed_asset == 0, cip/assets >= 15%, streak < 3 -> red.
    zero_fixed_report = _make_report(
        2025,
        cip=20e8,
        fixed_asset=0.0,
        total_assets=100e8,
    )
    ct_cip = scan_financial_ct([zero_fixed_report], None)
    cip_check = next(c for c in ct_cip.checks if c.rule_id == "stalled_cip")
    assert cip_check.status == "red"

    # Goodwill == 0.0 on negative equity -> green.
    zero_gw_neg_eq = _make_report(
        2025,
        goodwill=0.0,
        parent_equity=-20e8,
        total_equity=-20e8,
        total_assets=100e8,
    )
    ct_zero_gw = scan_financial_ct([zero_gw_neg_eq], None)
    gw_zero_check = next(c for c in ct_zero_gw.checks if c.rule_id == "goodwill_overhang")
    assert gw_zero_check.status == "green"
    assert gw_zero_check.value_text == "商誉 0.00亿元"

    # Goodwill > 0 with equity=None yet total_assets present -> evaluates goodwill/assets.
    gw_no_equity = StockAnnualReport(
        code="600519",
        report_year=2025,
        report_date=date(2025, 12, 31),
        goodwill_yuan=25e8,
        total_assets_yuan=100e8,
    )
    ct_gw_assets = scan_financial_ct([gw_no_equity], None)
    gw_assets_check = next(c for c in ct_gw_assets.checks if c.rule_id == "goodwill_overhang")
    assert gw_assets_check.status == "red"


def test_is_financial_institution_and_bank_snapshot_exemptions() -> None:
    cmb_no_ind = StockMetaRecord(code="600036", name="招商银行", exchange="SH", industry_sw1=None)
    pab_no_ind = StockMetaRecord(code="000001", name="平安银行", exchange="SZ", industry_sw1=None)
    insurer_no_ind = StockMetaRecord(
        code="601628", name="中国人寿", exchange="SH", industry_sw1=None
    )
    broker_no_ind = StockMetaRecord(
        code="600030", name="中信证券", exchange="SH", industry_sw1=None
    )
    rural_bank = StockMetaRecord(code="601825", name="沪农商行", exchange="SH", industry_sw1=None)

    assert is_financial_institution(cmb_no_ind) is True
    assert is_financial_institution(pab_no_ind) is True
    assert is_financial_institution(insurer_no_ind) is True
    assert is_financial_institution(broker_no_ind) is True
    assert is_financial_institution(rural_bank) is True

    assert is_financial_institution(None, "货币金融服务") is True
    assert is_financial_institution(None, "资本市场服务") is True
    assert is_financial_institution(None, "多元金融") is True

    fintech = StockMetaRecord(code="300033", name="金融科技", exchange="SZ", industry_sw1=None)
    bank_sw = StockMetaRecord(code="300001", name="银行软件", exchange="SZ", industry_sw1=None)
    it_bank_name = StockMetaRecord(
        code="600570", name="银行业商业银行", exchange="SH", industry_sw1="计算机"
    )
    assert is_financial_institution(fintech) is False
    assert is_financial_institution(bank_sw) is False
    assert is_financial_institution(it_bank_name) is False
    assert is_financial_institution(None, "金融科技") is False
    assert is_financial_institution(None, "银行软件") is False
    assert is_financial_institution(None, "软件和信息技术服务业") is False

    bank_reports = [
        _make_report(
            y,
            code="600036",
            monetary_funds=800e8,
            short_loan=600e8,
            long_loan=200e8,
            ocf=-250e8 if y % 2 == 0 else 100e8,
            net_profit=450e8,
            receivable=900e8,
            inventory=0.0,
            goodwill=0.0,
            total_assets=2000e8,
        )
        for y in range(2021, 2026)
    ]
    as_of = date(2026, 11, 20)
    bundle = StockFactBundle(
        code="600036",
        as_of=as_of,
        data_source="akshare",
        daily_bars=[
            StockDailyBar(
                code="600036",
                trade_date=as_of,
                open=38.0,
                high=39.0,
                low=37.5,
                close=38.5,
                total_mv_yuan=9500e8,
                pe_ttm=6.5,
                pb=0.9,
            )
        ],
        annual_reports=bank_reports,
        dividends=[],
        repurchases=[],
        pledge=None,
        equity_financings=[],
    )

    # Even before industry_sw1 is populated, bank name triggers full financial exemptions.
    snap_by_name = build_stock_snapshot(
        cmb_no_ind, bundle, generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC)
    )
    ct_by_id = {c.rule_id: c for c in snap_by_name.financial_ct.checks}
    for rule_id in ("dual_high_cash_debt", "ocf_profit_divergence", "receivable_inventory_bloat"):
        assert ct_by_id[rule_id].status == "na"
        assert "金融行业结构特殊" in ct_by_id[rule_id].summary
        assert ct_by_id[rule_id].value_text == "不适用"
    assert snap_by_name.reverse_dcf.solvable is False
    assert "PB / ROE" in snap_by_name.reverse_dcf.note
    assert snap_by_name.peer_metrics.net_cash_to_mv_pct is None
    fortress = next(d for d in snap_by_name.moat.dimensions if d.key == "balance_fortress")
    assert fortress.score == 65
    assert snap_by_name.radar.balance_sheet == 65

    # Bundle profile metadata propagates into snapshot when meta lacks industry_sw1/sw2.
    bundle_with_profile = bundle.model_copy(
        update={
            "profile_industry_sw1": "银行",
            "profile_industry_sw2": "股份制银行Ⅱ",
            "profile_list_date": date(2002, 4, 9),
        }
    )
    snap_propagated = build_stock_snapshot(
        cmb_no_ind, bundle_with_profile, generated_at=datetime(2026, 11, 20, 9, 30, tzinfo=UTC)
    )
    assert snap_propagated.industry_sw1 == "银行"
    assert snap_propagated.industry_sw2 == "股份制银行Ⅱ"
    assert snap_propagated.peer_metrics.industry_sw1 == "银行"
