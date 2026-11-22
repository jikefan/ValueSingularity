"""FastAPI application entrypoint."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import APIRoute

from app.api.deps import close_db_pool
from app.api.router import api_router
from app.settings import settings

logger = logging.getLogger("vs.api")


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
    app.include_router(api_router, prefix="/api")
    return app


app = create_app()
