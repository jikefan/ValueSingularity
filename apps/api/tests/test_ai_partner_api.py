from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping, Sequence
from datetime import date
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.deps import get_db, get_llm_companion
from app.db.base import Base
from app.db.models import StockMeta, User
from app.domain.engines import contains_forbidden_advice
from app.domain.models import (
    CitedMetricFact,
    DevilsAdvocateChallenge,
    MdaDiffHighlight,
    MdaMetricShift,
    PlanTier,
    StockSnapshotPayload,
)
from app.main import create_app
from app.settings import settings
from tests.test_ai_eval import _build_eval_snapshot


async def _register_and_headers(
    client: AsyncClient,
    email: str,
    display_name: str,
) -> dict[str, str]:
    resp = await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "password": "strong-password-123",
            "display_name": display_name,
        },
    )
    assert resp.status_code == 201
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _seed_stocks(
    session: AsyncSession,
    *,
    synced_snapshots: list[StockSnapshotPayload],
    unsynced_codes: list[tuple[str, str]] | None = None,
) -> None:
    from app.adapters.postgres.snapshot import PostgresStockSnapshotRepository

    for snap in synced_snapshots:
        if await session.get(StockMeta, snap.code) is None:
            session.add(
                StockMeta(
                    code=snap.code,
                    name=snap.name,
                    exchange=snap.exchange,
                    industry_sw1=snap.industry_sw1,
                    is_st=False,
                    is_active=True,
                )
            )
    for code, name in unsynced_codes or []:
        if await session.get(StockMeta, code) is None:
            session.add(
                StockMeta(
                    code=code,
                    name=name,
                    exchange="SZ" if code.startswith(("0", "3")) else "SH",
                    industry_sw1="电力设备",
                    is_st=False,
                    is_active=True,
                )
            )
    await session.commit()

    snap_repo = PostgresStockSnapshotRepository(session)
    for snap in synced_snapshots:
        await snap_repo.save_snapshot(snap)


class _FakeGroundedLlm:
    def __init__(self, *, fail: bool = False, hallucinate: bool = False) -> None:
        self.calls: list[dict[str, Any]] = []
        self.fail = fail
        self.hallucinate = hallucinate

    async def generate_challenges(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_seconds: float,
        context: Mapping[str, Any],
    ) -> list[DevilsAdvocateChallenge]:
        self.calls.append(
            {
                "op": "devils_advocate",
                "base_url": base_url,
                "api_key": api_key,
                "model": model,
            }
        )
        if self.fail:
            raise RuntimeError("upstream 503")
        if self.hallucinate:
            return [
                DevilsAdvocateChallenge(
                    index=1,
                    title="幻觉风险",
                    thesis="公司隐含增速达 888.88%。",
                    cited_facts=[
                        CitedMetricFact(
                            label="虚构增速", value_text="888.88%", source_section="reverse_dcf"
                        )
                    ],
                ),
                DevilsAdvocateChallenge(
                    index=2,
                    title="二",
                    thesis="PE 20.00x",
                    cited_facts=[
                        CitedMetricFact(label="PE", value_text="20.00x", source_section="valuation")
                    ],
                ),
                DevilsAdvocateChallenge(
                    index=3,
                    title="三",
                    thesis="红灯 0 项",
                    cited_facts=[
                        CitedMetricFact(label="红灯", value_text="0", source_section="financial_ct")
                    ],
                ),
            ]
        val = context.get("valuation", {})
        close_txt = f"{float(val['close']):.2f}元"
        pe_txt = f"{float(val['pe_ttm']):.2f}x"
        red_txt = str(int(context["ct_summary"]["red_count"]))
        return [
            DevilsAdvocateChallenge(
                index=1,
                title="估值水平再审视",
                thesis=f"当前收盘价为 {close_txt}，需警惕基本面扰动引发估值回撤。",
                cited_facts=[
                    CitedMetricFact(
                        label="收盘价", value_text=close_txt, source_section="valuation"
                    )
                ],
            ),
            DevilsAdvocateChallenge(
                index=2,
                title="市盈率预期压力",
                thesis=f"最新 PE(TTM) 处于 {pe_txt}，盈利增速回落将限制上行空间。",
                cited_facts=[
                    CitedMetricFact(label="PE(TTM)", value_text=pe_txt, source_section="valuation")
                ],
            ),
            DevilsAdvocateChallenge(
                index=3,
                title="排雷状态动态追踪",
                thesis=f"当前财务排雷红灯 {red_txt} 项，后续仍需跟踪财报现金流验证。",
                cited_facts=[
                    CitedMetricFact(
                        label="排雷红灯", value_text=red_txt, source_section="financial_ct"
                    )
                ],
            ),
        ]

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
        self.calls.append(
            {
                "op": "mda_diff",
                "base_url": base_url,
                "api_key": api_key,
                "model": model,
            }
        )
        if self.fail:
            raise RuntimeError("upstream 503")
        return (
            f"{stock_name} 在 {previous_period_label} 至 {current_period_label} 期间"
            f"共识别 {len(text_highlights)} 处文本变更与 {len(metric_shifts)} 项财报口径变化。"
        )


async def test_ai_preferences_ssrf_masking_and_tenant_isolation(db_client: AsyncClient) -> None:
    assert (await db_client.get("/api/ai/preferences")).status_code == 401
    assert (
        await db_client.post(
            "/api/ai/devils-advocate",
            json={"code": "600519", "reason": "长期价值"},
        )
    ).status_code == 401
    assert (
        await db_client.post(
            "/api/ai/mda-diff",
            json={"code": "600519"},
        )
    ).status_code == 401

    headers_a = await _register_and_headers(db_client, "ai-prefs-a@example.com", "AI User A")
    headers_b = await _register_and_headers(db_client, "ai-prefs-b@example.com", "AI User B")

    default_resp = await db_client.get("/api/ai/preferences", headers=headers_a)
    assert default_resp.status_code == 200
    default_body = default_resp.json()
    assert default_body["prefer_rule_only"] is False
    assert default_body["byok_enabled"] is False
    assert default_body["byok_api_key_configured"] is False
    assert default_body["byok_api_key_masked"] is None
    assert default_body["quota"]["plan_tier"] == "free"
    assert default_body["quota"]["daily_limit"] == 5
    assert default_body["quota"]["used_today"] == 0
    assert default_body["quota"]["remaining_today"] == 5
    assert default_body["quota"]["byok_active"] is False
    assert default_body["quota"]["resets_at_shanghai"].endswith("24:00 CST")

    bad_enable = await db_client.put(
        "/api/ai/preferences",
        headers=headers_a,
        json={"byok_enabled": True, "byok_model": "gpt-4o-mini"},
    )
    assert bad_enable.status_code == 422

    for bad_url in (
        "http://127.0.0.1:8000/v1",
        "https://localhost/v1",
        "https://169.254.169.254/v1",
        "https://10.0.0.5/v1",
        "https://foo.localhost\u3002/v1",
        "ftp://api.openai.com/v1",
    ):
        resp = await db_client.put(
            "/api/ai/preferences",
            headers=headers_a,
            json={
                "byok_enabled": True,
                "byok_base_url": bad_url,
                "byok_api_key": "sk-test-1234",
            },
        )
        assert resp.status_code == 422

    bad_nul = await db_client.put(
        "/api/ai/preferences",
        headers=headers_a,
        json={
            "byok_enabled": True,
            "byok_base_url": "https://api.openai.com/v1",
            "byok_api_key": "sk-bad\x00key",
        },
    )
    assert bad_nul.status_code == 422

    bad_clear_while_enabled = await db_client.put(
        "/api/ai/preferences",
        headers=headers_a,
        json={
            "byok_enabled": True,
            "byok_base_url": "https://api.openai.com/v1",
            "byok_api_key": "",
        },
    )
    assert bad_clear_while_enabled.status_code == 422

    saved_resp = await db_client.put(
        "/api/ai/preferences",
        headers=headers_a,
        json={
            "prefer_rule_only": False,
            "byok_enabled": True,
            "byok_base_url": "https://api.openai.com/v1/tenant-secret-9999",
            "byok_api_key": "sk-live-secret-1234",
            "byok_model": "gpt-4.1-mini",
        },
    )
    assert saved_resp.status_code == 200
    saved = saved_resp.json()
    assert saved["byok_enabled"] is True
    assert saved["byok_base_url_masked"] == "https://api.openai.com/****9999"
    assert saved["byok_api_key_configured"] is True
    assert saved["byok_api_key_masked"] == "sk-****1234"
    assert saved["byok_model"] == "gpt-4.1-mini"
    assert saved["quota"]["byok_active"] is True
    assert "sk-live-secret" not in json.dumps(saved)
    assert "tenant-secret" not in json.dumps(saved)

    retain_resp = await db_client.put(
        "/api/ai/preferences",
        headers=headers_a,
        json={
            "prefer_rule_only": True,
            "byok_enabled": True,
            "byok_base_url": None,
            "byok_api_key": None,
            "byok_model": "gpt-4o",
        },
    )
    assert retain_resp.status_code == 200
    assert retain_resp.json()["byok_api_key_masked"] == "sk-****1234"
    assert retain_resp.json()["byok_base_url_masked"] == "https://api.openai.com/****9999"
    assert retain_resp.json()["byok_model"] == "gpt-4o"

    user_b_prefs = (await db_client.get("/api/ai/preferences", headers=headers_b)).json()
    assert user_b_prefs["byok_enabled"] is False
    assert user_b_prefs["byok_api_key_configured"] is False

    clear_resp = await db_client.put(
        "/api/ai/preferences",
        headers=headers_a,
        json={
            "prefer_rule_only": False,
            "byok_enabled": False,
            "byok_base_url": "",
            "byok_api_key": "",
        },
    )
    assert clear_resp.status_code == 200
    assert clear_resp.json()["byok_api_key_configured"] is False
    assert clear_resp.json()["byok_api_key_masked"] is None
    assert clear_resp.json()["byok_base_url_masked"] is None


async def test_ai_deterministic_devils_advocate_mda_diff_and_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    monkeypatch.setattr(settings, "llm_api_key", None)
    monkeypatch.setattr(settings, "llm_base_url", None)

    engine = create_async_engine(settings.test_database_url)
    app = create_app()
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db

        _, snap = _build_eval_snapshot(
            code="600519",
            name="贵州茅台",
            as_of=date(2026, 11, 20),
            close=1450.0,
            pe_ttm=21.0,
            pledge_ratio_pct=32.0,
        )
        async with testing_session() as session:
            await _seed_stocks(
                session,
                synced_snapshots=[snap],
                unsynced_codes=[("300750", "宁德时代")],
            )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            headers = await _register_and_headers(client, "ai-det@example.com", "Det User")

            not_found = await client.post(
                "/api/ai/devils-advocate",
                headers=headers,
                json={"code": "999999", "reason": "不存在的标的"},
            )
            assert not_found.status_code == 404

            da_resp = await client.post(
                "/api/ai/devils-advocate",
                headers=headers,
                json={
                    "code": "600519",
                    "action": "buy",
                    "reason": "消费龙头盈利能力稳健",
                    "falsify_condition": "ROE连续2年低于15%",
                    "mode": "auto",
                },
            )
            assert da_resp.status_code == 200
            da = da_resp.json()
            assert da["code"] == "600519"
            assert da["mode"] == "deterministic"
            assert len(da["challenges"]) == 3
            assert da["quota"]["used_today"] == 0
            assert contains_forbidden_advice(json.dumps(da, ensure_ascii=False)) is None

            unsynced_resp = await client.post(
                "/api/ai/devils-advocate",
                headers=headers,
                json={
                    "code": "300750",
                    "action": "buy",
                    "reason": "关注新能源龙头",
                    "falsify_condition": "毛利率下滑",
                },
            )
            assert unsynced_resp.status_code == 200
            unsynced = unsynced_resp.json()
            assert unsynced["as_of"] is None
            assert unsynced["mode"] == "deterministic"
            assert len(unsynced["challenges"]) == 3

            mda_resp = await client.post(
                "/api/ai/mda-diff",
                headers=headers,
                json={
                    "code": "600519",
                    "previous_period_label": "2024年报",
                    "current_period_label": "2025年报",
                    "previous_text": "产能扩张按计划推进，市场需求稳健增长。",
                    "current_text": "下游需求不及预期，且本期调整坏账准备会计估计。",
                },
            )
            assert mda_resp.status_code == 200
            mda = mda_resp.json()
            assert mda["mode"] == "deterministic"
            assert len(mda["metric_shifts"]) >= 5
            assert any(h["severity"] == "red" for h in mda["text_highlights"])

            mda_empty_text = await client.post(
                "/api/ai/mda-diff",
                headers=headers,
                json={"code": "600519", "previous_text": "", "current_text": ""},
            )
            assert mda_empty_text.status_code == 200
            assert len(mda_empty_text.json()["metric_shifts"]) >= 5
            assert mda_empty_text.json()["text_highlights"] == []

            events = (await client.get("/api/events", headers=headers)).json()
            event_types = [e["type"] for e in events]
            assert "ai_devils_advocate" in event_types
            assert "ai_mda_diff" in event_types
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_ai_quota_429_concurrency_byok_bypass_and_rule_only_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    monkeypatch.setattr(settings, "llm_base_url", "https://api.openai.com/v1")
    monkeypatch.setattr(settings, "llm_api_key", "sk-platform-test-9999")

    fake_llm = _FakeGroundedLlm()
    engine = create_async_engine(settings.test_database_url, pool_size=12)
    app = create_app()
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_llm_companion] = lambda: fake_llm

        _, snap = _build_eval_snapshot(code="600519", close=1500.0, pe_ttm=20.0)
        async with testing_session() as session:
            await _seed_stocks(session, synced_snapshots=[snap])

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            headers_burst = await _register_and_headers(
                client, "ai-burst@example.com", "Burst User"
            )
            headers_byok = await _register_and_headers(client, "ai-byok@example.com", "BYOK User")
            headers_pro = await _register_and_headers(client, "ai-pro@example.com", "Pro User")

            # Upgrade Pro user to PRO tier and verify daily_limit == 30.
            async with testing_session() as session:
                await session.execute(
                    update(User)
                    .where(User.email == "ai-pro@example.com")
                    .values(plan_tier=PlanTier.PRO.value)
                )
                await session.commit()
            pro_login = await client.post(
                "/api/auth/login",
                json={"email": "ai-pro@example.com", "password": "strong-password-123"},
            )
            assert pro_login.status_code == 200
            headers_pro = {"Authorization": f"Bearer {pro_login.json()['access_token']}"}
            pro_prefs = (await client.get("/api/ai/preferences", headers=headers_pro)).json()
            assert pro_prefs["quota"]["plan_tier"] == "pro"
            assert pro_prefs["quota"]["daily_limit"] == 30

            async with testing_session() as session:
                await session.execute(
                    update(User)
                    .where(User.email == "ai-pro@example.com")
                    .values(plan_tier=PlanTier.AI_PLUS.value)
                )
                await session.commit()
            ai_plus_login = await client.post(
                "/api/auth/login",
                json={"email": "ai-pro@example.com", "password": "strong-password-123"},
            )
            assert ai_plus_login.status_code == 200
            ai_plus_prefs = (
                await client.get(
                    "/api/ai/preferences",
                    headers={"Authorization": f"Bearer {ai_plus_login.json()['access_token']}"},
                )
            ).json()
            assert ai_plus_prefs["quota"]["plan_tier"] == "ai_plus"
            assert ai_plus_prefs["quota"]["daily_limit"] == 100

            # Concurrent burst of 8 requests on a free user (daily_limit=5) must allow exactly 5.
            async def call_once() -> int:
                async with AsyncClient(
                    transport=ASGITransport(app=app), base_url="http://test"
                ) as req_client:
                    r = await req_client.post(
                        "/api/ai/devils-advocate",
                        headers=headers_burst,
                        json={
                            "code": "600519",
                            "reason": "长期价值投资逻辑",
                            "falsify_condition": "ROE连续2年低于15%",
                            "mode": "auto",
                        },
                    )
                    return r.status_code

            statuses = await asyncio.gather(*(call_once() for _ in range(8)))
            assert statuses.count(200) == 5
            assert statuses.count(429) == 3

            # When quota is exhausted, rule_only still works without error.
            rule_only_resp = await client.post(
                "/api/ai/devils-advocate",
                headers=headers_burst,
                json={
                    "code": "600519",
                    "reason": "长期价值投资逻辑",
                    "falsify_condition": "ROE连续2年低于15%",
                    "mode": "rule_only",
                },
            )
            assert rule_only_resp.status_code == 200
            assert rule_only_resp.json()["mode"] == "deterministic"
            assert rule_only_resp.json()["quota"]["remaining_today"] == 0

            # Exhausted free user configuring BYOK bypasses platform quota and hits custom endpoint.
            for _ in range(5):
                ok_resp = await client.post(
                    "/api/ai/devils-advocate",
                    headers=headers_byok,
                    json={"code": "600519", "reason": "现金牛"},
                )
                assert ok_resp.status_code == 200
                assert ok_resp.json()["mode"] == "llm"

            assert (
                await client.post(
                    "/api/ai/mda-diff",
                    headers=headers_byok,
                    json={"code": "600519", "previous_text": "稳健", "current_text": "承压"},
                )
            ).status_code == 429

            assert (
                await client.put(
                    "/api/ai/preferences",
                    headers=headers_byok,
                    json={
                        "byok_enabled": True,
                        "byok_base_url": "https://byok.example.com/v1",
                        "byok_api_key": "sk-byok-custom-4321",
                        "byok_model": "custom-model",
                    },
                )
            ).status_code == 200

            byok_da = await client.post(
                "/api/ai/devils-advocate",
                headers=headers_byok,
                json={"code": "600519", "reason": "现金牛"},
            )
            assert byok_da.status_code == 200
            assert byok_da.json()["mode"] == "byok"
            assert byok_da.json()["quota"]["byok_active"] is True
            assert fake_llm.calls[-1]["base_url"] == "https://byok.example.com/v1"
            assert fake_llm.calls[-1]["api_key"] == "sk-byok-custom-4321"
            assert fake_llm.calls[-1]["model"] == "custom-model"

            byok_mda = await client.post(
                "/api/ai/mda-diff",
                headers=headers_byok,
                json={"code": "600519", "previous_text": "稳健", "current_text": "承压"},
            )
            assert byok_mda.status_code == 200
            assert byok_mda.json()["mode"] == "byok"

            # Hallucinating LLM output triggers compliance/grounding fallback cleanly.
            fake_llm.hallucinate = True
            hallucination_resp = await client.post(
                "/api/ai/devils-advocate",
                headers=headers_byok,
                json={"code": "600519", "reason": "现金牛"},
            )
            assert hallucination_resp.status_code == 200
            assert hallucination_resp.json()["mode"] == "deterministic_fallback"
            assert "888.88" in (hallucination_resp.json()["fallback_reason"] or "")

            # Upstream failure triggers clean deterministic_fallback without 500.
            fake_llm.hallucinate = False
            fake_llm.fail = True
            fallback_resp = await client.post(
                "/api/ai/devils-advocate",
                headers=headers_byok,
                json={"code": "600519", "reason": "现金牛"},
            )
            assert fallback_resp.status_code == 200
            assert fallback_resp.json()["mode"] == "deterministic_fallback"
            assert len(fallback_resp.json()["challenges"]) == 3
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_ai_422_redaction_partial_prefs_tx_release_populate_existing_and_refund(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not settings.test_database_url:
        pytest.skip("设置 VS_TEST_DATABASE_URL（或 .env）后运行数据库测试")

    from app.adapters.postgres.ai import PostgresAiRepository

    monkeypatch.setattr(settings, "llm_base_url", "https://api.openai.com/v1")
    monkeypatch.setattr(settings, "llm_api_key", "sk-platform-test-9999")

    engine = create_async_engine(settings.test_database_url, pool_size=8)
    app = create_app()
    active_sessions: list[AsyncSession] = []
    tx_states_during_llm: list[bool] = []

    class _TxCheckingLlm(_FakeGroundedLlm):
        async def generate_challenges(self, **kwargs: Any) -> list[DevilsAdvocateChallenge]:
            if active_sessions:
                tx_states_during_llm.append(active_sessions[-1].in_transaction())
            return await super().generate_challenges(**kwargs)

        async def summarize_mda_diff(self, **kwargs: Any) -> str:
            if active_sessions:
                tx_states_during_llm.append(active_sessions[-1].in_transaction())
            return await super().summarize_mda_diff(**kwargs)

    spy_llm = _TxCheckingLlm()
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)

        testing_session = async_sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

        async def override_get_db() -> AsyncIterator[AsyncSession]:
            async with testing_session() as session:
                active_sessions.append(session)
                try:
                    yield session
                finally:
                    active_sessions.pop()

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_llm_companion] = lambda: spy_llm

        _, snap = _build_eval_snapshot(code="600519", close=1500.0, pe_ttm=20.0)
        async with testing_session() as session:
            await _seed_stocks(
                session,
                synced_snapshots=[snap],
                unsynced_codes=[("300750", "宁德时代")],
            )

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            # 422 on register must redact password input.
            bad_pw = await client.post(
                "/api/auth/register",
                json={
                    "email": "bad-pw@example.com",
                    "password": "pw123",
                    "display_name": "BadPw",
                },
            )
            assert bad_pw.status_code == 422
            assert "pw123" not in bad_pw.text
            assert bad_pw.json()["detail"][0]["input"] == "[REDACTED]"

            headers = await _register_and_headers(client, "ai-b6@example.com", "Batch6 User")

            # 422 on PUT /api/ai/preferences must redact byok_api_key (both model & field level).
            bad_model_err = await client.put(
                "/api/ai/preferences",
                headers=headers,
                json={
                    "byok_enabled": True,
                    "byok_base_url": "",
                    "byok_api_key": "sk-plaintext-echo-secret-9999",
                },
            )
            assert bad_model_err.status_code == 422
            assert "sk-plaintext-echo-secret-9999" not in bad_model_err.text
            assert "9999" not in bad_model_err.text

            bad_key_err = await client.put(
                "/api/ai/preferences",
                headers=headers,
                json={
                    "byok_enabled": True,
                    "byok_base_url": "https://api.openai.com/v1",
                    "byok_api_key": "sk-bad\x00echo-secret-7777",
                },
            )
            assert bad_key_err.status_code == 422
            assert "sk-bad" not in bad_key_err.text
            assert "7777" not in bad_key_err.text

            # Unsynced + empty text MD&A diff returns honest no-snapshot message.
            unsynced_mda = await client.post(
                "/api/ai/mda-diff",
                headers=headers,
                json={"code": "300750", "previous_text": "", "current_text": ""},
            )
            assert unsynced_mda.status_code == 200
            assert (
                unsynced_mda.json()["summary"]
                == "尚未同步财报快照且未提供年报文本，暂无可对比变化。"
            )

            # Platform failure refunds quota and populates MdaDiffResponse.fallback_reason.
            spy_llm.fail = True
            fail_da = await client.post(
                "/api/ai/devils-advocate",
                headers=headers,
                json={"code": "600519", "reason": "现金牛"},
            )
            assert fail_da.status_code == 200
            assert fail_da.json()["mode"] == "deterministic_fallback"
            assert fail_da.json()["quota"]["used_today"] == 0

            fail_mda = await client.post(
                "/api/ai/mda-diff",
                headers=headers,
                json={"code": "600519", "previous_text": "稳健", "current_text": "承压"},
            )
            assert fail_mda.status_code == 200
            assert fail_mda.json()["mode"] == "deterministic_fallback"
            assert fail_mda.json()["fallback_reason"] is not None
            assert fail_mda.json()["quota"]["used_today"] == 0

            # Successful platform calls release read transaction before HTTP I/O.
            spy_llm.fail = False
            ok_da = await client.post(
                "/api/ai/devils-advocate",
                headers=headers,
                json={"code": "600519", "reason": "现金牛"},
            )
            assert ok_da.status_code == 200
            assert ok_da.json()["mode"] == "llm"
            assert ok_da.json()["quota"]["used_today"] == 1

            ok_mda = await client.post(
                "/api/ai/mda-diff",
                headers=headers,
                json={"code": "600519", "previous_text": "稳健", "current_text": "承压"},
            )
            assert ok_mda.status_code == 200
            assert ok_mda.json()["mode"] == "llm"
            assert ok_mda.json()["fallback_reason"] is None

            # Configure BYOK and verify partial PUT preserves omitted fields + no idle tx on BYOK.
            assert (
                await client.put(
                    "/api/ai/preferences",
                    headers=headers,
                    json={
                        "prefer_rule_only": False,
                        "byok_enabled": True,
                        "byok_base_url": "https://byok.example.com/v1",
                        "byok_api_key": "sk-byok-custom-4321",
                        "byok_model": "gpt-4.1-mini",
                    },
                )
            ).status_code == 200

            partial_put = await client.put(
                "/api/ai/preferences",
                headers=headers,
                json={"prefer_rule_only": True},
            )
            assert partial_put.status_code == 200
            assert partial_put.json()["prefer_rule_only"] is True
            assert partial_put.json()["byok_enabled"] is True
            assert partial_put.json()["byok_model"] == "gpt-4.1-mini"

            # Flip prefer_rule_only back via partial PUT and check BYOK calls do not hold PG tx.
            assert (
                await client.put(
                    "/api/ai/preferences",
                    headers=headers,
                    json={"prefer_rule_only": False},
                )
            ).status_code == 200
            byok_da = await client.post(
                "/api/ai/devils-advocate",
                headers=headers,
                json={"code": "600519", "reason": "现金牛"},
            )
            assert byok_da.status_code == 200
            assert byok_da.json()["mode"] == "byok"

            byok_mda = await client.post(
                "/api/ai/mda-diff",
                headers=headers,
                json={"code": "600519", "previous_text": "稳健", "current_text": "承压"},
            )
            assert byok_mda.status_code == 200
            assert byok_mda.json()["mode"] == "byok"
            assert tx_states_during_llm == [False, False, False, False, False, False]

            # Stale identity map regression: session A caches usage=2, session B advances to 5,
            # session A's try_consume_quota must populate_existing and reject (False, 5).
            me_resp = await client.get("/api/auth/me", headers=headers)
            assert me_resp.status_code == 200
            from uuid import UUID

            user_uuid = UUID(me_resp.json()["id"])
            day_str = ok_da.json()["quota"]["resets_at_shanghai"].split(" ")[0]

            async with testing_session() as sess_a, testing_session() as sess_b:
                repo_a = PostgresAiRepository(sess_a)
                repo_b = PostgresAiRepository(sess_b)
                cached = await repo_a.get_usage_today(user_uuid, day_str)
                assert cached == 2
                for _ in range(3):
                    allowed_b, _ = await repo_b.try_consume_quota(user_uuid, day_str, 5)
                    assert allowed_b is True
                allowed_a, count_a = await repo_a.try_consume_quota(user_uuid, day_str, 5)
                assert allowed_a is False
                assert count_a == 5
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
