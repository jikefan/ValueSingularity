from __future__ import annotations

from datetime import UTC, date, datetime
from uuid import uuid4

import pytest

from app.domain.engines import (
    build_decision_ledger,
    build_stock_snapshot,
    evaluate_entry_falsify,
    evaluate_user_alerts,
)
from app.domain.models import (
    AnnualFinancialTrendPoint,
    FalsifyRule,
    JournalAction,
    JournalEntryItem,
    JournalTimeCapsule,
    StockAnnualReport,
    StockDailyBar,
    StockDividendRecord,
    StockFactBundle,
    StockMetaRecord,
    StockPledgeSnapshot,
    StockSnapshotPayload,
    WatchlistItem,
)
from app.domain.url_safety import mask_webhook_url, validate_public_webhook_url


def _make_snapshot(
    *,
    code: str = "600519",
    name: str = "贵州茅台",
    as_of: date = date(2026, 11, 20),
    close: float = 1500.0,
    pe_ttm: float = 20.0,
    pe_percentile_10y: float = 22.0,
    dividend_yield_pct: float = 3.5,
    ct_red_count: int = 0,
    total_score: int = 82,
    roe_series: list[tuple[int, float]] | None = None,
    pledge_ratio_pct: float = 1.0,
) -> StockSnapshotPayload:
    meta = StockMetaRecord(code=code, name=name, exchange="SH" if code.startswith("6") else "SZ")
    bars = [
        StockDailyBar(
            code=code,
            trade_date=date(2025, 11, 20),
            open=close * 1.1,
            high=close * 1.12,
            low=close * 1.08,
            close=close * 1.1,
            total_mv_yuan=18_000e8,
            pe_ttm=pe_ttm * 1.3,
            pb=6.0,
        ),
        StockDailyBar(
            code=code,
            trade_date=as_of,
            open=close,
            high=close,
            low=close,
            close=close,
            total_mv_yuan=18_000e8,
            pe_ttm=pe_ttm,
            pb=5.0,
        ),
    ]
    reports = [
        StockAnnualReport(
            code=code,
            report_year=y,
            report_date=date(y, 12, 31),
            audit_opinion="标准无保留意见",
            revenue_yuan=1000e8,
            operate_cost_yuan=100e8,
            net_profit_yuan=500e8,
            deduct_net_profit_yuan=490e8,
            total_assets_yuan=2500e8,
            total_equity_yuan=2000e8,
            parent_equity_yuan=2000e8,
            monetary_funds_yuan=600e8,
            ocf_yuan=550e8,
            capex_yuan=20e8,
        )
        for y in range(2021, 2026)
    ]
    bundle = StockFactBundle(
        code=code,
        as_of=as_of,
        data_source="akshare",
        daily_bars=bars,
        annual_reports=reports,
        dividends=[
            StockDividendRecord(
                code=code,
                report_date=date(2025, 12, 31),
                report_year=2025,
                plan_progress="实施分配",
                cash_per_10_shares=250.0,
                total_shares=12.0e8,
                dividend_cash_total_yuan=300e8,
                dividend_yield_pct=dividend_yield_pct,
            )
        ],
        repurchases=[],
        pledge=StockPledgeSnapshot(code=code, trade_date=as_of, pledge_ratio_pct=pledge_ratio_pct),
        equity_financings=[],
    )
    snap = build_stock_snapshot(meta, bundle, generated_at=datetime(2026, 11, 20, 8, 0, tzinfo=UTC))
    updated_trends = (
        [
            AnnualFinancialTrendPoint(
                year=year,
                revenue_yuan=1000e8 + idx * 50e8,
                net_profit_yuan=500e8 + idx * 20e8,
                deduct_net_profit_yuan=490e8,
                ocf_yuan=520e8,
                fcf_yuan=480e8 - idx * 10e8,
                roe_pct=roe,
                gross_margin_pct=88.0 - idx * 2.0,
                net_margin_pct=45.0,
                net_cash_yuan=500e8,
                rd_ratio_pct=1.5,
            )
            for idx, (year, roe) in enumerate(roe_series)
        ]
        if roe_series is not None
        else snap.annual_trends
    )
    return snap.model_copy(
        update={
            "annual_trends": updated_trends,
            "valuation": snap.valuation.model_copy(
                update={
                    "close": close,
                    "pe_ttm": pe_ttm,
                    "pe_percentile_10y": pe_percentile_10y,
                    "dividend_yield_pct": dividend_yield_pct,
                }
            ),
            "financial_ct": snap.financial_ct.model_copy(update={"red_count": ct_red_count}),
            "radar": snap.radar.model_copy(update={"total_score": total_score}),
            "pledge_ratio_pct": pledge_ratio_pct,
        }
    )


def _entry(
    *,
    entry_id: int,
    code: str = "600519",
    name: str | None = "贵州茅台",
    action: JournalAction = JournalAction.BUY,
    emotion: str | None = "冷静",
    price: float | None = 1400.0,
    benchmark_price: float | None = 4000.0,
    created_at: datetime = datetime(2026, 10, 1, 10, 0, tzinfo=UTC),
    falsify_rules: list[FalsifyRule] | None = None,
    snapshot: JournalTimeCapsule | None = None,
) -> JournalEntryItem:
    return JournalEntryItem(
        id=entry_id,
        code=code,
        name=name,
        action=action,
        reason="长期价值",
        falsify_condition="基本面恶化",
        falsify_rules=falsify_rules,
        emotion=emotion,
        price=price,
        benchmark_code="000300",
        benchmark_price=benchmark_price,
        snapshot=snapshot,
        created_at=created_at,
    )


def test_url_safety_blocks_ssrf_and_masks_tokens() -> None:
    valid_urls = [
        "https://open.feishu.cn/open-apis/bot/v2/hook/secret-1234",
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=token9876",
        "http://8.8.8.8:8080/webhook",
        "https://xn--fsqu00a.xn--0zwm56d/hook",
    ]
    for url in valid_urls:
        assert validate_public_webhook_url(url) == url

    assert (
        mask_webhook_url("https://open.feishu.cn/open-apis/bot/v2/hook/secret-1234")
        == "https://open.feishu.cn/****1234"
    )
    assert mask_webhook_url("https://example.com/a") == "https://example.com/****"
    assert mask_webhook_url(None) is None
    assert mask_webhook_url("   ") is None

    bad_urls = [
        "",
        "https://127.0.0.1/hook",
        "http://127.0.0.1:8000/internal",
        "https://[::1]/hook",
        "https://[::ffff:127.0.0.1]/hook",
        "http://169.254.169.254/latest/meta-data/",
        "https://10.0.0.1/hook",
        "https://172.16.0.5/hook",
        "https://192.168.1.10/hook",
        "https://100.64.0.1/hook",
        "https://0.0.0.0/hook",
        "http://localhost/hook",
        "https://sub.localhost/hook",
        "https://foo.localhost\u3002/hook",
        "https://sub\uff0elocalhost/hook",
        "https://sub\uff61localhost/hook",
        "https://open.feishu.cn\u3002/hook",
        "https://127\u30020\u30020\u30021/hook",
        "https://\uff11\uff12\uff17.\uff10.\uff10.\uff11/hook",
        "https://xn--aaaa.example.com/hook",
        "https://xn--localhost-123/hook",
        "https://example.com../hook",
        "https://service.local/hook",
        "https://internal-api.internal/hook",
        "ftp://open.feishu.cn/hook",
        "javascript:alert(1)",
        "https://user:pass@open.feishu.cn/hook",
        "https://open.feishu.cn/hook\x00evil",
        "https://open.feishu.cn/hook\nevil",
        "https://open.feishu.cn/hook with-space",
        "http://2130706433/hook",
        "http://0x7f000001/hook",
        "http://127.1/hook",
        "http://0177.0.0.1/hook",
        "https://redis/hook",
    ]
    for bad in bad_urls:
        with pytest.raises(ValueError):
            validate_public_webhook_url(bad)


def test_decision_ledger_beta_attribution_emotion_and_pass_stats() -> None:
    snap_a = _make_snapshot(
        code="600519",
        name="贵州茅台",
        close=1560.0,
        pe_ttm=23.5,
        ct_red_count=2,
        total_score=74,
    )
    snap_b = _make_snapshot(
        code="000858",
        name="五粮液",
        close=120.0,
        pe_ttm=14.0,
        ct_red_count=0,
        total_score=80,
    )
    entries = [
        _entry(
            entry_id=1,
            code="600519",
            name="贵州茅台",
            action=JournalAction.BUY,
            emotion="冷静",
            price=None,
            benchmark_price=None,
            created_at=datetime(2026, 10, 1, 10, 0, tzinfo=UTC),
            falsify_rules=[FalsifyRule(metric="pe_ttm", op="gt", value=22.0)],
            snapshot=JournalTimeCapsule(
                as_of=date(2026, 10, 1),
                close=1300.0,
                pe_ttm=19.5,
                ct_red_count=0,
                total_score=85,
                benchmark_code="000300",
                benchmark_price=4000.0,
            ),
        ),
        _entry(
            entry_id=2,
            code="000858",
            name="五粮液",
            action=JournalAction.PASS,
            emotion="焦虑",
            price=150.0,
            benchmark_price=4000.0,
            created_at=datetime(2026, 10, 10, 10, 0, tzinfo=UTC),
        ),
        _entry(
            entry_id=3,
            code="000001",
            name="平安银行",
            action=JournalAction.ADD,
            emotion="  ",
            price=10.0,
            benchmark_price=4000.0,
            created_at=datetime(2026, 11, 1, 10, 0, tzinfo=UTC),
        ),
    ]

    report = build_decision_ledger(
        entries,
        {"600519": snap_a, "000858": snap_b},
        current_benchmark_price=4400.0,
        benchmark_as_of=date(2026, 11, 20),
        reference_now=datetime(2026, 11, 20, 12, 0, tzinfo=UTC),
    )

    assert report.total_entries == 3
    assert report.comparable_count == 2
    assert report.win_count == 2
    assert report.win_rate_pct == 100.0
    assert report.avg_stock_return_pct == 0.0
    assert report.avg_excess_return_pct == -10.0
    assert report.pass_count == 1
    assert report.pass_avoided_loss_count == 1
    assert report.current_benchmark_price == 4400.0
    assert report.benchmark_as_of == date(2026, 11, 20)

    by_id = {item.id: item for item in report.items}
    assert by_id[1].entry_price == 1300.0
    assert by_id[1].stock_return_pct == 20.0
    assert by_id[1].benchmark_return_pct == 10.0
    assert by_id[1].excess_return_pct == 10.0
    assert by_id[1].entry_pe_ttm == 19.5
    assert by_id[1].current_pe_ttm == 23.5
    assert by_id[1].entry_score == 85
    assert by_id[1].current_score == 74
    assert by_id[1].days_held == 50
    assert by_id[1].falsify_triggered is True
    assert len(by_id[1].falsify_triggers) == 2

    assert by_id[2].stock_return_pct == -20.0
    assert by_id[2].excess_return_pct == -30.0
    assert by_id[2].falsify_triggered is False

    assert by_id[3].stock_return_pct is None
    assert by_id[3].excess_return_pct is None

    emotions = {row.emotion: row for row in report.by_emotion}
    assert set(emotions) == {"冷静", "焦虑", "未标注"}
    assert emotions["冷静"].win_rate_pct == 100.0
    assert emotions["焦虑"].win_rate_pct == 100.0
    assert emotions["未标注"].comparable_count == 0
    assert emotions["未标注"].win_rate_pct is None

    actions = {row.action: row for row in report.by_action}
    assert actions[JournalAction.BUY].win_count == 1
    assert actions[JournalAction.PASS].win_count == 1


def test_decision_ledger_win_fallback_without_benchmark() -> None:
    snap = _make_snapshot(code="600519", close=900.0)
    entries = [
        _entry(entry_id=1, action=JournalAction.BUY, price=1000.0, benchmark_price=None),
        _entry(entry_id=2, action=JournalAction.PASS, price=1000.0, benchmark_price=None),
    ]
    report = build_decision_ledger(
        entries,
        {"600519": snap},
        current_benchmark_price=None,
        benchmark_as_of=None,
    )
    assert report.comparable_count == 2
    assert report.win_count == 1
    assert report.win_rate_pct == 50.0
    assert report.pass_count == 1
    assert report.pass_avoided_loss_count == 1


def test_sentinel_radar_watchlist_and_holding_lifecycle() -> None:
    user_id = uuid4()
    snap_wl = _make_snapshot(
        code="600519",
        close=1420.0,
        pe_ttm=19.0,
        pe_percentile_10y=18.5,
        dividend_yield_pct=4.1,
    )
    snap_closed = _make_snapshot(
        code="000858",
        name="五粮液",
        close=110.0,
        ct_red_count=2,
        roe_series=[(2023, 10.0), (2024, 9.0), (2025, 8.0)],
    )
    snap_active = _make_snapshot(
        code="000333",
        name="美的集团",
        close=65.0,
        ct_red_count=1,
        roe_series=[(2022, 22.0), (2023, 19.0), (2024, 13.0), (2025, 12.0)],
        pledge_ratio_pct=35.0,
    )

    watchlist = [
        WatchlistItem(
            code="600519",
            name="贵州茅台",
            target_price=1450.0,
            target_pe_percentile=20.0,
            target_dividend_yield=4.0,
            alert_enabled=True,
            added_at=datetime(2026, 11, 1, tzinfo=UTC),
            updated_at=datetime(2026, 11, 1, tzinfo=UTC),
        ),
        WatchlistItem(
            code="000858",
            name="五粮液",
            target_price=200.0,
            alert_enabled=False,
            added_at=datetime(2026, 11, 1, tzinfo=UTC),
            updated_at=datetime(2026, 11, 1, tzinfo=UTC),
        ),
    ]

    journal_entries = [
        _entry(
            entry_id=10,
            code="000858",
            name="五粮液",
            action=JournalAction.BUY,
            created_at=datetime(2026, 9, 1, tzinfo=UTC),
            falsify_rules=[FalsifyRule(metric="roe", op="lt", value=15.0, periods=2)],
            snapshot=JournalTimeCapsule(ct_red_count=0),
        ),
        _entry(
            entry_id=11,
            code="000858",
            name="五粮液",
            action=JournalAction.TRIM,
            created_at=datetime(2026, 9, 15, tzinfo=UTC),
        ),
        _entry(
            entry_id=12,
            code="000858",
            name="五粮液",
            action=JournalAction.SELL,
            created_at=datetime(2026, 10, 1, tzinfo=UTC),
        ),
        _entry(
            entry_id=20,
            code="000333",
            name="美的集团",
            action=JournalAction.ADD,
            created_at=datetime(2026, 10, 5, tzinfo=UTC),
            falsify_rules=[
                FalsifyRule(metric="roe", op="lt", value=15.0, periods=2),
                FalsifyRule(metric="质押率", op="gte", value=30.0, periods=1),
                FalsifyRule(metric="net_profit", op="lt", value=100e8, periods=2),
            ],
            snapshot=JournalTimeCapsule(ct_red_count=0),
        ),
        _entry(
            entry_id=21,
            code="600519",
            name="贵州茅台",
            action=JournalAction.PASS,
            created_at=datetime(2026, 10, 6, tzinfo=UTC),
            falsify_rules=[FalsifyRule(metric="close", op="lt", value=9999.0)],
        ),
    ]

    result = evaluate_user_alerts(
        user_id,
        watchlist,
        journal_entries,
        {"600519": snap_wl, "000858": snap_closed, "000333": snap_active},
    )
    assert result.evaluated_rules == 7
    assert len(result.candidates) == 2

    wl_alert = next(c for c in result.candidates if c.source_type == "watchlist_sentinel")
    assert wl_alert.code == "600519"
    assert wl_alert.rule_signature.startswith("wl:")
    assert len(wl_alert.rule_signature) <= 64
    assert len(wl_alert.matched_conditions) == 3

    jf_alert = next(c for c in result.candidates if c.source_type == "journal_falsify")
    assert jf_alert.code == "000333"
    assert jf_alert.rule_signature.startswith("jf:20:")
    assert len(jf_alert.rule_signature) <= 64
    assert len(jf_alert.matched_conditions) == 3

    assert all(c.code != "000858" for c in result.candidates)

    repeat = evaluate_user_alerts(
        user_id,
        watchlist,
        journal_entries,
        {"600519": snap_wl, "000858": snap_closed, "000333": snap_active},
    )
    assert [c.rule_signature for c in repeat.candidates] == [
        c.rule_signature for c in result.candidates
    ]


def test_sentinel_multi_period_requires_consecutive_years() -> None:
    snap_gap = _make_snapshot(
        code="600519",
        roe_series=[(2022, 10.0), (2024, 11.0)],
    )
    entry = _entry(
        entry_id=1,
        falsify_rules=[FalsifyRule(metric="roe", op="lt", value=15.0, periods=2)],
    )
    assert evaluate_entry_falsify(entry, snap_gap) == []

    snap_short = _make_snapshot(code="600519", roe_series=[(2025, 10.0)])
    assert evaluate_entry_falsify(entry, snap_short) == []

    snap_ok = _make_snapshot(code="600519", roe_series=[(2024, 12.0), (2025, 11.0)])
    triggers = evaluate_entry_falsify(entry, snap_ok)
    assert len(triggers) == 1 and "连续 2 年" in triggers[0]


def test_sentinel_aliases_and_reopen_after_sell() -> None:
    user_id = uuid4()
    snap = _make_snapshot(
        code="600519",
        close=1450.0,
        pe_ttm=28.0,
        ct_red_count=1,
        total_score=55,
        roe_series=[(2024, 18.0), (2025, 17.0)],
    )
    snap = snap.model_copy(
        update={
            "reverse_dcf": snap.reverse_dcf.model_copy(update={"implied_fcf_cagr_pct": 18.0}),
            "peer_metrics": snap.peer_metrics.model_copy(
                update={"net_cash_to_mv_pct": 2.5, "ocf_to_profit_5y_pct": 65.0}
            ),
        }
    )

    rules = [
        FalsifyRule(metric="pe", op="gt", value=25.0),
        FalsifyRule(metric="implied_fcf_cagr_pct", op="gt", value=15.0),
        FalsifyRule(metric="net_cash_to_mv_pct", op="lt", value=5.0),
        FalsifyRule(metric="ocf_to_profit_5y_pct", op="lt", value=80.0),
        FalsifyRule(metric="综合评分", op="lt", value=60.0),
        FalsifyRule(metric="revenue", op="gt", value=500e8, periods=2),
        FalsifyRule(metric="fcf", op="gt", value=100e8, periods=2),
        FalsifyRule(metric="gross_margin", op="gt", value=80.0, periods=2),
    ]
    old_buy = _entry(
        entry_id=1,
        action=JournalAction.BUY,
        created_at=datetime(2026, 8, 1, tzinfo=UTC),
        falsify_rules=[FalsifyRule(metric="close", op="gt", value=100.0)],
    )
    closed_sell = _entry(
        entry_id=2,
        action=JournalAction.SELL,
        created_at=datetime(2026, 9, 1, tzinfo=UTC),
    )
    reopened_buy = _entry(
        entry_id=3,
        action=JournalAction.BUY,
        created_at=datetime(2026, 10, 1, tzinfo=UTC),
        falsify_rules=rules,
    )

    res = evaluate_user_alerts(user_id, [], [old_buy, closed_sell, reopened_buy], {"600519": snap})
    assert len(res.candidates) == 1
    assert res.candidates[0].rule_signature.startswith("jf:3:")
    assert len(res.candidates[0].matched_conditions) == len(rules)


def test_sentinel_scalar_multi_period_does_not_fire() -> None:
    user_id = uuid4()
    snap = _make_snapshot(
        code="600519",
        close=1500.0,
        pe_ttm=35.0,
        pe_percentile_10y=92.0,
        pledge_ratio_pct=35.0,
        total_score=40,
        roe_series=[(2023, 10.0), (2024, 10.0), (2025, 10.0)],
    )
    snap = snap.model_copy(update={"moat": snap.moat.model_copy(update={"roe_5y_avg_pct": 10.0})})

    multi_period_scalar_entry = _entry(
        entry_id=1,
        action=JournalAction.BUY,
        falsify_rules=[
            FalsifyRule(metric="pe_ttm", op="gt", value=30.0, periods=2),
            FalsifyRule(metric="pe_percentile_10y", op="gte", value=85.0, periods=2),
            FalsifyRule(metric="roe_5y_avg_pct", op="lt", value=15.0, periods=2),
            FalsifyRule(metric="pledge_ratio_pct", op="gte", value=30.0, periods=2),
            FalsifyRule(metric="total_score", op="lt", value=50.0, periods=2),
        ],
    )
    assert evaluate_entry_falsify(multi_period_scalar_entry, snap) == []
    alert_res = evaluate_user_alerts(user_id, [], [multi_period_scalar_entry], {"600519": snap})
    assert alert_res.candidates == []

    single_period_entry = _entry(
        entry_id=2,
        action=JournalAction.BUY,
        falsify_rules=[
            FalsifyRule(metric="pe_ttm", op="gt", value=30.0, periods=1),
            FalsifyRule(metric="roe_5y_avg_pct", op="lt", value=15.0, periods=1),
        ],
    )
    assert len(evaluate_entry_falsify(single_period_entry, snap)) == 2


def test_sentinel_lossless_rule_signature_and_subcent_display() -> None:
    user_id = uuid4()
    snap = _make_snapshot(
        code="600519",
        close=0.5,
        dividend_yield_pct=0.01,
    )
    snap = snap.model_copy(
        update={
            "valuation": snap.valuation.model_copy(update={"pb": 1.5}),
        }
    )

    wl_a = WatchlistItem(
        code="600519",
        name="贵州茅台",
        target_price=1.004,
        alert_enabled=True,
        added_at=datetime(2026, 11, 1, tzinfo=UTC),
        updated_at=datetime(2026, 11, 1, tzinfo=UTC),
    )
    wl_b = WatchlistItem(
        code="600519",
        name="贵州茅台",
        target_price=1.002,
        alert_enabled=True,
        added_at=datetime(2026, 11, 1, tzinfo=UTC),
        updated_at=datetime(2026, 11, 1, tzinfo=UTC),
    )
    res_wl_a = evaluate_user_alerts(user_id, [wl_a], [], {"600519": snap})
    res_wl_b = evaluate_user_alerts(user_id, [wl_b], [], {"600519": snap})
    assert res_wl_a.candidates[0].rule_signature != res_wl_b.candidates[0].rule_signature
    assert "1.004" in res_wl_a.candidates[0].detail
    assert "1.002" in res_wl_b.candidates[0].detail

    entry_a = _entry(
        entry_id=7,
        action=JournalAction.BUY,
        falsify_rules=[FalsifyRule(metric="pb", op="gt", value=1.004, periods=1)],
    )
    entry_b = _entry(
        entry_id=7,
        action=JournalAction.BUY,
        falsify_rules=[FalsifyRule(metric="pb", op="gt", value=1.002, periods=1)],
    )
    entry_tiny = _entry(
        entry_id=8,
        action=JournalAction.BUY,
        falsify_rules=[FalsifyRule(metric="pb", op="gt", value=0.004, periods=1)],
    )
    jf_a = evaluate_user_alerts(user_id, [], [entry_a], {"600519": snap}).candidates[0]
    jf_b = evaluate_user_alerts(user_id, [], [entry_b], {"600519": snap}).candidates[0]
    jf_tiny = evaluate_user_alerts(user_id, [], [entry_tiny], {"600519": snap}).candidates[0]

    assert jf_a.rule_signature != jf_b.rule_signature
    assert "1.004" in jf_a.matched_conditions[0]
    assert "1.002" in jf_b.matched_conditions[0]
    assert "0.004" in jf_tiny.matched_conditions[0]
