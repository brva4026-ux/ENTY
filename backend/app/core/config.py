from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "TicketFlow API"
    api_host: str = "0.0.0.0"
    api_port: int = 8000

    database_url: str = "postgresql://postgres:devpassword@localhost:5432/ticketflow"

    jwt_secret: str = "super-secreto-cambia-esto"
    jwt_algorithm: str = "HS256"
    jwt_expires_minutes: int = 480

    cors_origins: str = "http://localhost:5173,http://localhost:3000"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()