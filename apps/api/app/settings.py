"""Application settings.

Environment variables use the ``VS_`` prefix (see .env.example).
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VS_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://vs:vs@127.0.0.1:5432/vs"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    # When set, the API also serves a built SPA (single-process deployment).
    web_dist: Path | None = None
    # 集成测试库；为空则跳过涉及数据库的测试
    test_database_url: str | None = None


settings = Settings()
