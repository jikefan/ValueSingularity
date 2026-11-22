"""Domain-level error primitives (stdlib only)."""

from __future__ import annotations


class EmailAlreadyRegisteredError(Exception):
    def __init__(self, email: str) -> None:
        super().__init__(f"{email} 已注册")
        self.email = email
