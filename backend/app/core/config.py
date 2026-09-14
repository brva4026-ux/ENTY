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

    cors_origins: str = "http://localhost:5173,http://localhost:3000"

    # Prefijo externo de la API. En Vercel la función recibe /api/... (via
    # rewrite) mientras las rutas internas no llevan prefijo: root_path=/api.
    api_root_path: str = ""

    # Entorno y puerta de datos demo. El endpoint /seed SOLO funciona con
    # IS_DEMO=true explícito (nunca por defecto). ENVIRONMENT=production sin
    # IS_DEMO=true deja el seed deshabilitado.
    environment: str = "local"
    is_demo: bool = False

    # Vida del JWT. Los roles se re-verifican contra la DB en cada request
    # (deps.get_current_user), asi que un token largo solo afecta a la
    # identidad, no a los permisos.
    jwt_expires_minutes: int = 60

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()