"""Auth: hash de passwords (bcrypt via passlib) y tokens JWT."""
from datetime import datetime, timedelta, timezone

from jose import jwt
from passlib.context import CryptContext

from app.core.config import get_settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(
    user_id: int,
    venue_ids: list[int],
    roles: dict[int, list[str]],
    token_version: int = 1,
) -> str:
    """JWT con claims propios: vids = venues a las que pertenece, roles por venue.

    `tver` (token_version) permite revocar TODAS las sesiones del usuario de
    golpe al cambiar su contraseña: bump en DB -> tokens anteriores rechazados.
    """
    settings = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "vids": venue_ids,
        # {"<venue_id>": ["admin","promotor"]}
        "roles": {str(v): r for v, r in roles.items()},
        "tver": token_version,
        "iat": now,
        "exp": now + timedelta(minutes=settings.jwt_expires_minutes),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)