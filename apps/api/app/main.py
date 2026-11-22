"""FastAPI application entrypoint."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from app.api.deps import close_db_pool
from app.api.router import api_router
from app.settings import settings

logger = logging.getLogger("vs.api")

_SENSITIVE_VALIDATION_KEYS = frozenset(
    {
        "byok_api_key",
        "password",
        "webhook_secret",
        "api_key",
        "refresh_token",
        "access_token",
    }
)


def _redact_validation_input(value: Any, *, key_name: str | None = None) -> Any:
    if key_name is not None and key_name.lower() in _SENSITIVE_VALIDATION_KEYS:
        if value is None or value == "":
            return value
        return "[REDACTED]"
    if isinstance(value, dict):
        return {
            key: _redact_validation_input(item, key_name=str(key)) for key, item in value.items()
        }
    if isinstance(value, list | tuple):
        return [_redact_validation_input(item) for item in value]
    return value


def _sanitize_validation_errors(exc: RequestValidationError) -> list[dict[str, Any]]:
    sanitized: list[dict[str, Any]] = []
    for err in exc.errors():
        copied = dict(err)
        loc = copied.get("loc") or ()
        sensitive_loc = any(
            isinstance(part, str) and part.lower() in _SENSITIVE_VALIDATION_KEYS for part in loc
        )
        if "input" in copied:
            if sensitive_loc:
                raw_input = copied["input"]
                copied["input"] = (
                    raw_input if raw_input is None or raw_input == "" else "[REDACTED]"
                )
            else:
                copied["input"] = _redact_validation_input(copied["input"])
        sanitized.append(copied)
    return sanitized


def _operation_id(route: APIRoute) -> str:
    return f"{route.tags[0]}_{route.name}" if route.tags else route.name


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    logger.info("ValueSingularity API starting")
    yield
    await close_db_pool()
    logger.info("ValueSingularity API stopped")


def create_app() -> FastAPI:
    app = FastAPI(
        title="ValueSingularity API",
        description="A 股价值挖掘分析服务",
        version="0.1.0",
        lifespan=lifespan,
        generate_unique_id_function=_operation_id,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"detail": jsonable_encoder(_sanitize_validation_errors(exc))},
        )

    app.include_router(api_router, prefix="/api")
    return app


app = create_app()
