"""OpenAI-compatible LLM companion adapter with SSRF pinning and secret hygiene."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from app.adapters.http_safety import UnsafeOutboundTargetError, post_json_public
from app.domain.models import DevilsAdvocateChallenge, MdaDiffHighlight, MdaMetricShift
from app.domain.url_safety import mask_webhook_url

logger = logging.getLogger("vs.llm")

_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)

_CHALLENGE_SYSTEM_PROMPT = (
    "你是 A 股价值投资风控审慎伴侣（魔鬼代言人）。"
    "严格基于输入 JSON 中的事实数据输出恰好 3 条彼此独立、犀利且克制的潜在风险质询。"
    "严禁给出任何买卖操作建议、推荐评级或目标价预测；"
    "每条质询的 cited_facts 和 thesis 必须严格引用输入快照中的真实数字，严禁编造任何未出现的数字。"
    "若 snapshot_available 为 false，则不得包含任何财务数字。"
    '请仅返回合法 JSON 对象：{"challenges": [{"index": 1, "title": "...", '
    '"thesis": "...", "cited_facts": [{"label": "...", "value_text": "...", '
    '"source_section": "..."}], "suggested_falsify_rule": null}]}。'
)

_MDA_SYSTEM_PROMPT = (
    "你是 A 股年报口径审计助手。请基于提供的财务指标变化与管理层讨论增删高亮，"
    "用 2-3 句客观中文概括关键变化重点。严禁输出买卖建议、推荐评级或目标价。"
    "所有引用的数字必须严格来自输入事实，不得虚构数值。"
    '请仅返回 JSON 对象：{"summary": "..."}。'
)


def _build_completions_endpoint(base_url: str) -> str:
    parsed = urlsplit(base_url.strip())
    path = parsed.path.rstrip("/")
    if not path.endswith("/chat/completions"):
        path = f"{path}/chat/completions" if path else "/chat/completions"
    return urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, parsed.fragment))


def _extract_json_payload(raw_content: str) -> Any:
    cleaned = _CODE_FENCE_RE.sub("", raw_content.strip()).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    obj_start = cleaned.find("{")
    obj_end = cleaned.rfind("}")
    if obj_start != -1 and obj_end > obj_start:
        try:
            return json.loads(cleaned[obj_start : obj_end + 1])
        except json.JSONDecodeError:
            pass

    arr_start = cleaned.find("[")
    arr_end = cleaned.rfind("]")
    if arr_start != -1 and arr_end > arr_start:
        return json.loads(cleaned[arr_start : arr_end + 1])
    raise ValueError("LLM 响应未包含可解析的 JSON 数据")


def _extract_message_content(body: Any) -> str:
    if not isinstance(body, dict):
        raise ValueError("LLM 响应体不是 JSON 对象")
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ValueError("LLM 响应缺少 choices")
    first = choices[0]
    if not isinstance(first, dict):
        raise ValueError("LLM choices[0] 格式无效")
    message = first.get("message")
    if not isinstance(message, dict):
        raise ValueError("LLM 响应缺少 message")
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("LLM message.content 为空")
    return content


def _parse_challenges_payload(raw_content: str) -> list[DevilsAdvocateChallenge]:
    parsed = _extract_json_payload(raw_content)
    items: Any
    if isinstance(parsed, dict) and isinstance(parsed.get("challenges"), list):
        items = parsed["challenges"]
    elif isinstance(parsed, list):
        items = parsed
    else:
        raise ValueError("LLM JSON 缺少 challenges 数组")

    challenges: list[DevilsAdvocateChallenge] = []
    for idx, raw_item in enumerate(items, start=1):
        if not isinstance(raw_item, dict):
            raise ValueError("challenge 条目不是对象")
        item_dict = dict(raw_item)
        if not isinstance(item_dict.get("index"), int) or item_dict["index"] < 1:
            item_dict["index"] = idx
        if item_dict.get("suggested_falsify_rule") == {}:
            item_dict["suggested_falsify_rule"] = None
        challenges.append(DevilsAdvocateChallenge.model_validate(item_dict))
    return challenges


class OpenAiCompatibleLlmAdapter:
    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._transport = transport

    async def _post_chat_completion(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_seconds: float,
        system_prompt: str,
        user_payload: dict[str, Any],
    ) -> str:
        endpoint = _build_completions_endpoint(base_url)
        masked_endpoint = mask_webhook_url(endpoint)
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        request_body: dict[str, Any] = {
            "model": model,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
        }

        try:
            response = await post_json_public(
                endpoint,
                json_body=request_body,
                headers=headers,
                timeout_seconds=timeout_seconds,
                transport=self._transport,
                label="LLM Base URL",
            )
            if response.status_code == 400:
                fallback_body = dict(request_body)
                fallback_body.pop("response_format", None)
                response = await post_json_public(
                    endpoint,
                    json_body=fallback_body,
                    headers=headers,
                    timeout_seconds=timeout_seconds,
                    transport=self._transport,
                    label="LLM Base URL",
                )
        except UnsafeOutboundTargetError as exc:
            logger.warning("LLM 出站请求被 SSRF 策略拦截 (%s): %s", masked_endpoint, exc)
            raise ValueError(f"LLM 地址校验失败: {exc}") from exc
        except (httpx.HTTPError, httpx.InvalidURL, UnicodeError, OSError, ValueError) as exc:
            logger.warning("LLM 请求异常 (%s): %s", masked_endpoint, exc.__class__.__name__)
            raise RuntimeError(f"LLM 请求失败 ({exc.__class__.__name__})") from exc

        if not (200 <= response.status_code < 300):
            logger.warning(
                "LLM 返回非成功状态码 (%s): status=%d",
                masked_endpoint,
                response.status_code,
            )
            raise RuntimeError(f"LLM 服务返回状态码 {response.status_code}")

        try:
            body = response.json()
        except ValueError as exc:
            raise ValueError("LLM 响应体不是有效 JSON") from exc

        return _extract_message_content(body)

    async def generate_challenges(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_seconds: float,
        context: Mapping[str, Any],
    ) -> list[DevilsAdvocateChallenge]:
        content = await self._post_chat_completion(
            base_url=base_url,
            api_key=api_key,
            model=model,
            timeout_seconds=timeout_seconds,
            system_prompt=_CHALLENGE_SYSTEM_PROMPT,
            user_payload=dict(context),
        )
        return _parse_challenges_payload(content)

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
        user_payload = {
            "code": code,
            "stock_name": stock_name,
            "previous_period_label": previous_period_label,
            "current_period_label": current_period_label,
            "metric_shifts": [item.model_dump(mode="json") for item in metric_shifts],
            "text_highlights": [item.model_dump(mode="json") for item in text_highlights[:15]],
        }
        content = await self._post_chat_completion(
            base_url=base_url,
            api_key=api_key,
            model=model,
            timeout_seconds=timeout_seconds,
            system_prompt=_MDA_SYSTEM_PROMPT,
            user_payload=user_payload,
        )
        try:
            parsed = _extract_json_payload(content)
        except ValueError:
            return _CODE_FENCE_RE.sub("", content).strip()

        if not isinstance(parsed, dict):
            raise ValueError("LLM MD&A 摘要 JSON 必须是包含 summary 字段的对象")
        summary_val = parsed.get("summary")
        if not isinstance(summary_val, str) or not summary_val.strip():
            raise ValueError("LLM MD&A 摘要 JSON 缺少非空 summary 字符串")
        return summary_val.strip()
