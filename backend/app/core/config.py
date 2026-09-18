from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "TicketFlow API"
    api_host: str = "0.0.0.0"
    api_port: int = 8000

    database_url: str = "postgresql://postgres:devpassword@localhost:5432/ticketflow"

    jwt_secret: str = ""
    jwt_algorithm: str = "HS256"

    @model_validator(mode="after")
    def _require_jwt_secret_in_production(self):
        """En producción un JWT secret default = cualquiera puede forjar tokens.

        Local/tests tienen el default vacío para no frenar el desarrollo; en
        ENVIRONMENT=production la app **se niega a arrancar** sin un secreto
        real (≥32 chars) vía variable de entorno.
        """
        if self.environment == "production" and len(self.jwt_secret) < 32:
            raise ValueError(
                "JWT_SECRET es obligatorio en producción (mínimo 32 caracteres). "
                "Defínelo como variable de entorno antes de desplegar."
            )
        return self

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

    # Web Push (VAPID): avisos a los dispositivos de la puerta cuando el
    # admin abre el evento (published -> live). Las claves van en variables
    # de entorno, NUNCA en el codigo. Vacio = push deshabilitado.
    vapid_private_key_b64: str = ""
    vapid_public_key_b64: str = ""
    vapid_subject: str = "mailto:admin@ticketflow.app"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()