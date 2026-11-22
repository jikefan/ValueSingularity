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
