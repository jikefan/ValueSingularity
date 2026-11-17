"""Application settings.

Environment variables use the ``VS_`` prefix (see .env.example).
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VS_", env_file=".env", extra="ignore")

    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    # When set, the API also serves a built SPA (single-process deployment).
    web_dist: Path | None = None


settings = Settings()
