"""Shared coercion, exchange mapping, and resilient retry helpers for akshare adapters."""

from __future__ import annotations

import asyncio
import math
import re
import threading
from collections.abc import Callable
from datetime import date, datetime
from zoneinfo import ZoneInfo

import akshare as ak
import pandas as pd
from akshare.exceptions import RateLimitError
from akshare.utils.http import Push2RateLimitError
from tenacity import (
    AsyncRetrying,
    retry_if_not_exception_type,
    stop_after_attempt,
    wait_exponential,
    wait_none,
)

from app.domain.models import StockExchange

SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
STOCK_CODE_RE = re.compile(r"^\d{6}$")
# Serialize py_mini_racer.MiniRacer invocations across endpoints to prevent macOS V8 aborts.
MINI_RACER_LOCK = threading.Lock()


def is_missing(value: object) -> bool:
    if value is None:
        return True
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def coerce_date(value: object) -> date | None:
    if is_missing(value):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        parsed = pd.to_datetime(text, errors="coerce")
        if is_missing(parsed):
            return None
        if isinstance(parsed, datetime):
            return parsed.date()
        return None


def coerce_float(value: object) -> float | None:
    if is_missing(value):
        return None
    if isinstance(value, str):
        cleaned = value.strip().replace(",", "").rstrip("%")
        if not cleaned or cleaned in {"-", "--", "nan", "NaN", "None"}:
            return None
        raw_input: object = cleaned
    else:
        raw_input = value
    try:
        num = float(str(raw_input)) if not isinstance(raw_input, int | float) else float(raw_input)
    except (TypeError, ValueError):
        return None
    return num if math.isfinite(num) else None


def coerce_cn_amount_yuan(value: object) -> float | None:
    if is_missing(value):
        return None
    if isinstance(value, int | float):
        num = float(value)
        return num if math.isfinite(num) else None
    text = str(value).strip().replace(",", "")
    if not text or text in {"-", "--", "nan", "NaN", "None"}:
        return None
    multiplier = 1.0
    if text.endswith("亿元"):
        multiplier = 1e8
        text = text[:-2]
    elif text.endswith("亿"):
        multiplier = 1e8
        text = text[:-1]
    elif text.endswith("万元"):
        multiplier = 1e4
        text = text[:-2]
    elif text.endswith("万"):
        multiplier = 1e4
        text = text[:-1]
    elif text.endswith("元"):
        text = text[:-1]
    base = coerce_float(text)
    if base is None:
        return None
    result = base * multiplier
    return result if math.isfinite(result) else None


def infer_exchange(code: str) -> StockExchange | None:
    if code.startswith(("60", "68")):
        return "SH"
    if code.startswith(("00", "30")):
        return "SZ"
    if code.startswith(("4", "8", "92")):
        return "BJ"
    return None


async def run_akshare_call[T](
    fn: Callable[[], T],
    *,
    timeout_seconds: float,
    max_attempts: int,
    retry_wait_seconds: float,
) -> T:
    ak_timeout = (min(5.0, timeout_seconds), timeout_seconds)
    ak.set_timeout(ak_timeout)
    wait_strategy = (
        wait_exponential(
            multiplier=retry_wait_seconds,
            min=retry_wait_seconds,
            max=8.0,
        )
        if retry_wait_seconds > 0
        else wait_none()
    )
    async for attempt in AsyncRetrying(
        stop=stop_after_attempt(max_attempts),
        wait=wait_strategy,
        retry=retry_if_not_exception_type((Push2RateLimitError, RateLimitError)),
        reraise=True,
    ):
        with attempt:
            return await asyncio.wait_for(
                asyncio.to_thread(fn),
                timeout=timeout_seconds,
            )
    raise RuntimeError("akshare retry loop terminated unexpectedly")
