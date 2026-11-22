"""Restrained AI decision companion orchestration service (domain imports only)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from app.domain.engines import (
    COMPLIANCE_NOTICE,
    build_deterministic_challenges,
    compute_accounting_metric_shifts,
    compute_text_mda_diff,
    trim_snapshot_context,
    verify_llm_challenges,
    verify_mda_summary,
)
from app.domain.errors import AiConfigError, AiQuotaExceededError, StockNotFoundError
from app.domain.models import (
    AiExecutionMode,
    AiPreferences,
    AiPreferencesUpdate,
    AiQuotaStatus,
    AuthenticatedUser,
    DevilsAdvocateChallenge,
    DevilsAdvocateRequest,
    DevilsAdvocateResponse,
    MdaDiffRequest,
    MdaDiffResponse,
    PlanTier,
    StockMetaRecord,
    StockSnapshotPayload,
    StoredAiConfig,
    UserEventCreate,
)
from app.domain.ports import (
    AiPreferencesRepository,
    EventRepository,
    LlmCompanionPort,
    StockMetaRepository,
    StockSnapshotRepository,
)
from app.domain.url_safety import mask_secret, mask_webhook_url, validate_public_http_url

logger = logging.getLogger("vs.ai")

_SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
_DEFAULT_PLATFORM_LLM_URL = "https://api.openai.com/v1"
_DAILY_LIMITS: dict[PlanTier, int] = {
    PlanTier.FREE: 5,
    PlanTier.PRO: 30,
    PlanTier.AI_PLUS: 100,
}


def _is_byok_ready(config: StoredAiConfig) -> bool:
    return bool(config.byok_enabled and config.byok_base_url and config.byok_api_key)


def _build_quota_status(
    *,
    plan_tier: PlanTier,
    used_today: int,
    byok_active: bool,
    day_shanghai: str,
) -> AiQuotaStatus:
    daily_limit = _DAILY_LIMITS.get(plan_tier, 5)
    return AiQuotaStatus(
        plan_tier=plan_tier,
        daily_limit=daily_limit,
        used_today=used_today,
        remaining_today=max(0, daily_limit - used_today),
        byok_active=byok_active,
        resets_at_shanghai=f"{day_shanghai} 24:00 CST",
    )


def _to_public_preferences(
    config: StoredAiConfig,
    *,
    plan_tier: PlanTier,
    used_today: int,
    day_shanghai: str,
) -> AiPreferences:
    byok_active = _is_byok_ready(config)
    return AiPreferences(
        prefer_rule_only=config.prefer_rule_only,
        byok_enabled=config.byok_enabled,
        byok_base_url_masked=mask_webhook_url(config.byok_base_url)
        if config.byok_base_url
        else None,
        byok_api_key_configured=bool(config.byok_api_key),
        byok_api_key_masked=mask_secret(config.byok_api_key),
        byok_model=config.byok_model,
        quota=_build_quota_status(
            plan_tier=plan_tier,
            used_today=used_today,
            byok_active=byok_active,
            day_shanghai=day_shanghai,
        ),
    )


class AiPartnerService:
    def __init__(
        self,
        *,
        ai_repo: AiPreferencesRepository,
        stock_meta: StockMetaRepository,
        snapshot_repo: StockSnapshotRepository,
        event_repo: EventRepository,
        llm_client: LlmCompanionPort | None = None,
        platform_llm_base_url: str | None = None,
        platform_llm_api_key: str | None = None,
        platform_llm_model: str = "gpt-4o-mini",
        llm_timeout_seconds: float = 12.0,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._ai_repo = ai_repo
        self._stock_meta = stock_meta
        self._snapshot_repo = snapshot_repo
        self._event_repo = event_repo
        self._llm_client = llm_client
        self._platform_base_url = platform_llm_base_url.strip() if platform_llm_base_url else None
        self._platform_api_key = platform_llm_api_key.strip() if platform_llm_api_key else None
        self._platform_model = platform_llm_model.strip() or "gpt-4o-mini"
        self._llm_timeout_seconds = llm_timeout_seconds
        self._clock = clock or (lambda: datetime.now(UTC))

    def _today_shanghai(self) -> str:
        now = self._clock()
        if now.tzinfo is None:
            now = now.replace(tzinfo=UTC)
        return now.astimezone(_SHANGHAI_TZ).date().isoformat()

    def _platform_llm_ready(self) -> bool:
        return bool(self._llm_client is not None and self._platform_api_key)

    async def _resolve_stock(
        self, code: str
    ) -> tuple[StockMetaRecord, StockSnapshotPayload | None]:
        detail = await self._stock_meta.get_detail(code)
        snapshot = await self._snapshot_repo.get_snapshot(code)
        if detail is not None:
            meta = StockMetaRecord(
                code=detail.code,
                name=detail.name,
                exchange=detail.exchange,
                industry_sw1=detail.industry_sw1,
                industry_sw2=detail.industry_sw2,
                list_date=detail.list_date,
                is_st=detail.is_st,
                is_active=detail.is_active,
            )
            return meta, snapshot
        if snapshot is not None:
            meta = StockMetaRecord(
                code=snapshot.code,
                name=snapshot.name,
                exchange=snapshot.exchange,
                industry_sw1=snapshot.industry_sw1,
                industry_sw2=snapshot.industry_sw2,
            )
            return meta, snapshot
        raise StockNotFoundError(code)

    async def get_preferences(self, user: AuthenticatedUser) -> AiPreferences:
        config = await self._ai_repo.get_config(user.id)
        day = self._today_shanghai()
        used_today = await self._ai_repo.get_usage_today(user.id, day)
        return _to_public_preferences(
            config,
            plan_tier=user.plan_tier,
            used_today=used_today,
            day_shanghai=day,
        )

    async def update_preferences(
        self,
        user: AuthenticatedUser,
        payload: AiPreferencesUpdate,
    ) -> AiPreferences:
        existing = await self._ai_repo.get_config(user.id)

        if payload.byok_base_url is None:
            resolved_url = existing.byok_base_url
        elif payload.byok_base_url == "":
            resolved_url = None
        else:
            resolved_url = payload.byok_base_url

        if payload.byok_api_key is None:
            resolved_key = existing.byok_api_key
        elif payload.byok_api_key == "":
            resolved_key = None
        else:
            resolved_key = payload.byok_api_key

        resolved_prefer_rule_only = (
            existing.prefer_rule_only
            if payload.prefer_rule_only is None
            else payload.prefer_rule_only
        )
        resolved_byok_enabled = (
            existing.byok_enabled if payload.byok_enabled is None else payload.byok_enabled
        )
        resolved_byok_model = (
            existing.byok_model if payload.byok_model is None else payload.byok_model
        )

        if resolved_url is not None:
            try:
                resolved_url = validate_public_http_url(resolved_url, label="BYOK Base URL")
            except ValueError as exc:
                raise AiConfigError(str(exc)) from exc

        if resolved_byok_enabled and (not resolved_url or not resolved_key):
            raise AiConfigError("启用 BYOK 自带密钥前，请先配置有效的公网 Base URL 与 API Key")

        updated = StoredAiConfig(
            prefer_rule_only=resolved_prefer_rule_only,
            byok_enabled=resolved_byok_enabled,
            byok_base_url=resolved_url,
            byok_api_key=resolved_key,
            byok_model=resolved_byok_model,
        )
        saved = await self._ai_repo.save_config(user.id, updated)
        day = self._today_shanghai()
        used_today = await self._ai_repo.get_usage_today(user.id, day)
        return _to_public_preferences(
            saved,
            plan_tier=user.plan_tier,
            used_today=used_today,
            day_shanghai=day,
        )

    async def run_devils_advocate(
        self,
        user: AuthenticatedUser,
        payload: DevilsAdvocateRequest,
    ) -> DevilsAdvocateResponse:
        meta, snapshot = await self._resolve_stock(payload.code)
        config = await self._ai_repo.get_config(user.id)
        day = self._today_shanghai()
        byok_active = _is_byok_ready(config)
        daily_limit = _DAILY_LIMITS.get(user.plan_tier, 5)

        mode: AiExecutionMode
        fallback_reason: str | None = None
        challenges: list[DevilsAdvocateChallenge]

        use_rule_only = payload.mode == "rule_only" or config.prefer_rule_only
        llm_client = self._llm_client
        llm_available = llm_client is not None and (byok_active or self._platform_llm_ready())
        if use_rule_only or llm_client is None or not llm_available:
            used_today = await self._ai_repo.get_usage_today(user.id, day)
            mode = "deterministic"
            challenges = build_deterministic_challenges(
                meta,
                snapshot,
                action=payload.action,
                reason=payload.reason,
                falsify_condition=payload.falsify_condition,
            )
        else:
            if byok_active:
                used_today = await self._ai_repo.get_usage_today(user.id, day)
                target_mode: AiExecutionMode = "byok"
                base_url = config.byok_base_url or _DEFAULT_PLATFORM_LLM_URL
                api_key = config.byok_api_key or ""
                model = config.byok_model
            else:
                allowed, used_today = await self._ai_repo.try_consume_quota(
                    user.id, day, daily_limit
                )
                if not allowed:
                    raise AiQuotaExceededError(used_today, daily_limit, user.plan_tier.value)
                target_mode = "llm"
                base_url = self._platform_base_url or _DEFAULT_PLATFORM_LLM_URL
                api_key = self._platform_api_key or ""
                model = self._platform_model

            context = trim_snapshot_context(
                meta,
                snapshot,
                action=payload.action,
                reason=payload.reason,
                falsify_condition=payload.falsify_condition,
            )
            await self._ai_repo.release_read_transaction()
            try:
                raw_challenges = await llm_client.generate_challenges(
                    base_url=base_url,
                    api_key=api_key,
                    model=model,
                    timeout_seconds=self._llm_timeout_seconds,
                    context=context,
                )
                ok, reason_msg = verify_llm_challenges(
                    raw_challenges,
                    snapshot,
                    stock_code=meta.code,
                    stock_name=meta.name,
                )
            except Exception as exc:
                logger.warning(
                    "魔鬼代言人 LLM 调用失败并回退至规则引擎 user_id=%s code=%s: %s",
                    user.id,
                    meta.code,
                    exc.__class__.__name__,
                )
                ok = False
                reason_msg = f"外部模型调用异常 ({exc.__class__.__name__})"
                raw_challenges = []
                if target_mode == "llm":
                    used_today = await self._ai_repo.refund_quota(user.id, day)

            if ok:
                mode = target_mode
                challenges = [
                    ch.model_copy(update={"index": idx})
                    for idx, ch in enumerate(raw_challenges, start=1)
                ]
            else:
                mode = "deterministic_fallback"
                fallback_reason = (
                    reason_msg or "外部模型输出未通过合规或事实校验，已自动切换规则引擎"
                )
                challenges = build_deterministic_challenges(
                    meta,
                    snapshot,
                    action=payload.action,
                    reason=payload.reason,
                    falsify_condition=payload.falsify_condition,
                )

        await self._event_repo.record(
            user.id,
            UserEventCreate(
                type="ai_devils_advocate",
                code=meta.code,
                meta={
                    "action": payload.action.value,
                    "mode": mode,
                    "byok_active": byok_active,
                    "snapshot_available": snapshot is not None,
                },
            ),
        )
        quota = _build_quota_status(
            plan_tier=user.plan_tier,
            used_today=used_today,
            byok_active=byok_active,
            day_shanghai=day,
        )
        return DevilsAdvocateResponse(
            code=meta.code,
            stock_name=meta.name,
            as_of=snapshot.as_of if snapshot is not None else None,
            mode=mode,
            fallback_reason=fallback_reason,
            challenges=challenges,
            quota=quota,
            compliance_notice=COMPLIANCE_NOTICE,
        )

    async def run_mda_diff(
        self,
        user: AuthenticatedUser,
        payload: MdaDiffRequest,
    ) -> MdaDiffResponse:
        meta, snapshot = await self._resolve_stock(payload.code)
        config = await self._ai_repo.get_config(user.id)
        day = self._today_shanghai()
        byok_active = _is_byok_ready(config)
        daily_limit = _DAILY_LIMITS.get(user.plan_tier, 5)

        metric_shifts = compute_accounting_metric_shifts(snapshot)
        text_highlights, det_summary = await asyncio.to_thread(
            compute_text_mda_diff,
            payload.previous_text,
            payload.current_text,
            has_snapshot=snapshot is not None,
        )
        if not payload.previous_text and not payload.current_text and metric_shifts:
            red_shifts = sum(1 for item in metric_shifts if item.severity == "red")
            yellow_shifts = sum(1 for item in metric_shifts if item.severity == "yellow")
            det_summary = (
                f"未提供管理层讨论文本，已基于近两年财报对比 {len(metric_shifts)} 项核心口径变化"
                f"（高敏感红灯 {red_shifts} 项、次级黄灯 {yellow_shifts} 项）。"
            )

        mode: AiExecutionMode
        fallback_reason: str | None = None
        summary: str

        use_rule_only = payload.mode == "rule_only" or config.prefer_rule_only
        has_content = bool(metric_shifts or text_highlights)
        llm_client = self._llm_client
        llm_available = llm_client is not None and (byok_active or self._platform_llm_ready())
        if use_rule_only or not has_content or llm_client is None or not llm_available:
            used_today = await self._ai_repo.get_usage_today(user.id, day)
            mode = "deterministic"
            summary = det_summary
        else:
            if byok_active:
                used_today = await self._ai_repo.get_usage_today(user.id, day)
                target_mode: AiExecutionMode = "byok"
                base_url = config.byok_base_url or _DEFAULT_PLATFORM_LLM_URL
                api_key = config.byok_api_key or ""
                model = config.byok_model
            else:
                allowed, used_today = await self._ai_repo.try_consume_quota(
                    user.id, day, daily_limit
                )
                if not allowed:
                    raise AiQuotaExceededError(used_today, daily_limit, user.plan_tier.value)
                target_mode = "llm"
                base_url = self._platform_base_url or _DEFAULT_PLATFORM_LLM_URL
                api_key = self._platform_api_key or ""
                model = self._platform_model

            await self._ai_repo.release_read_transaction()
            try:
                raw_summary = await llm_client.summarize_mda_diff(
                    base_url=base_url,
                    api_key=api_key,
                    model=model,
                    timeout_seconds=self._llm_timeout_seconds,
                    code=meta.code,
                    stock_name=meta.name,
                    previous_period_label=payload.previous_period_label,
                    current_period_label=payload.current_period_label,
                    metric_shifts=metric_shifts,
                    text_highlights=text_highlights,
                )
                ok, reason_msg = verify_mda_summary(
                    raw_summary,
                    snapshot,
                    previous_text=payload.previous_text,
                    current_text=payload.current_text,
                    stock_code=meta.code,
                    stock_name=meta.name,
                    previous_period_label=payload.previous_period_label,
                    current_period_label=payload.current_period_label,
                    metric_shifts=metric_shifts,
                    text_highlights=text_highlights,
                )
            except Exception as exc:
                logger.warning(
                    "MD&A Diff LLM 调用失败并回退至规则摘要 user_id=%s code=%s: %s",
                    user.id,
                    meta.code,
                    exc.__class__.__name__,
                )
                ok = False
                reason_msg = f"外部模型调用异常 ({exc.__class__.__name__})"
                raw_summary = ""
                if target_mode == "llm":
                    used_today = await self._ai_repo.refund_quota(user.id, day)

            if ok:
                mode = target_mode
                summary = raw_summary.strip()
            else:
                mode = "deterministic_fallback"
                fallback_reason = (
                    reason_msg or "外部模型摘要未通过合规或事实校验，已自动切换规则引擎"
                )
                summary = det_summary

        await self._event_repo.record(
            user.id,
            UserEventCreate(
                type="ai_mda_diff",
                code=meta.code,
                meta={
                    "mode": mode,
                    "byok_active": byok_active,
                    "shift_count": len(metric_shifts),
                    "highlight_count": len(text_highlights),
                },
            ),
        )
        quota = _build_quota_status(
            plan_tier=user.plan_tier,
            used_today=used_today,
            byok_active=byok_active,
            day_shanghai=day,
        )
        return MdaDiffResponse(
            code=meta.code,
            stock_name=meta.name,
            previous_period_label=payload.previous_period_label,
            current_period_label=payload.current_period_label,
            mode=mode,
            fallback_reason=fallback_reason,
            summary=summary,
            metric_shifts=metric_shifts,
            text_highlights=text_highlights,
            quota=quota,
            compliance_notice=COMPLIANCE_NOTICE,
        )


__all__ = ["AiConfigError", "AiPartnerService", "AiQuotaExceededError"]
