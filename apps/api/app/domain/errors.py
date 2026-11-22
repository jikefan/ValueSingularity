"""Domain-level error primitives (stdlib only)."""

from __future__ import annotations


class EmailAlreadyRegisteredError(Exception):
    def __init__(self, email: str) -> None:
        super().__init__(f"{email} 已注册")
        self.email = email


class MarketSnapshotUnavailableError(Exception):
    def __init__(self, message: str = "市场快照尚未生成，请先执行行情同步") -> None:
        super().__init__(message)


class MarketFeedUnavailableError(Exception):
    def __init__(self, source: str, detail: str) -> None:
        super().__init__(f"行情数据源不可用 ({source}): {detail}")
        self.source = source
        self.detail = detail


class StockNotFoundError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(f"未找到股票 {code}")
        self.code = code


class SnapshotNotReadyError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(f"股票 {code} 分析快照尚未生成，请先执行个股同步")
        self.code = code


class StockFactUnavailableError(Exception):
    def __init__(self, code: str, source: str, detail: str) -> None:
        super().__init__(f"个股事实数据不可用 ({code} / {source}): {detail}")
        self.code = code
        self.source = source
        self.detail = detail


class JournalEntryNotFoundError(Exception):
    def __init__(self, entry_id: int) -> None:
        super().__init__(f"决策日记 #{entry_id} 不存在")
        self.entry_id = entry_id


class NotificationConfigError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)


class AiQuotaExceededError(Exception):
    def __init__(self, used: int, limit: int, tier: str) -> None:
        super().__init__(
            f"今日 AI 平台调用额度已达上限 ({used}/{limit}，当前套餐 {tier})，"
            "可切换纯规则模式或配置 BYOK 自带密钥"
        )
        self.used = used
        self.limit = limit
        self.tier = tier


class AiConfigError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
