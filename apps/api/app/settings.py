"""Application settings.

Environment variables use the ``VS_`` prefix (see .env.example).
"""

from pathlib import Path
from typing import Self

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VS_", env_file=".env", extra="ignore")

    environment: str = "dev"
    database_url: str = "postgresql+psycopg://vs:vs@127.0.0.1:5432/vs"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    # When set, the API also serves a built SPA (single-process deployment).
    web_dist: Path | None = None
    # 集成测试库；为空则跳过涉及数据库的测试
    test_database_url: str | None = None

    jwt_secret: str = "dev-insecure-change-me-in-production"
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 14
    refresh_cookie_name: str = "vs_refresh_token"
    cookie_secure: bool = False

    @model_validator(mode="after")
    def _validate_prod_secret(self) -> Self:
        if self.environment != "dev" and (
            self.jwt_secret == "dev-insecure-change-me-in-production" or len(self.jwt_secret) < 32
        ):
            raise ValueError("生产环境必须配置至少 32 字符的 VS_JWT_SECRET")
        return self


settings = Settings()
