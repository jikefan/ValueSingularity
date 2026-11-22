"""Argon2 password hashing adapter."""

from __future__ import annotations

import asyncio

import argon2
from argon2.exceptions import InvalidHashError, VerificationError


class Argon2PasswordHasher:
    def __init__(self) -> None:
        self._hasher = argon2.PasswordHasher()

    async def hash(self, password: str) -> str:
        return await asyncio.to_thread(self._hasher.hash, password)

    async def verify(self, password: str, password_hash: str) -> bool:
        def _verify() -> bool:
            try:
                return bool(self._hasher.verify(password_hash, password))
            except (VerificationError, InvalidHashError):
                return False

        return await asyncio.to_thread(_verify)
