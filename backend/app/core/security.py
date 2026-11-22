"""Auth: hash de passwords (bcrypt directo) y tokens JWT."""
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from app.core.config import get_settings


def digest_token(raw: str) -> str:
    """SHA-256 hex del token crudo de boleta: lo unico que guarda la DB.

    Espejo EXACTO del SQL (encode(digest(x, 'sha256'), 'hex')): si algun dia
    difiere, las comparaciones de credenciales dejan de cuadrar.
    """
    import hashlib

    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def hash_password(plain: str) -> str:
    """bcrypt directo (sin passlib): la API hashpw/checkpw es la misma que
    passlib usaba por debajo, y el prefijo $2b$ y el costo (12) coinciden, así
    que los hashes ya guardados siguen verificando."""
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("ascii"))
    except ValueError:
        # Hash con formato inválido/corrupto: credencial inválida, no un 500.
        return False


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
        # `iat` tiene resolución de segundos: sin `jti`, dos logins en el mismo
        # segundo producían el MISMO token y compartían fila de sesión.
        "jti": secrets.token_hex(8),
        "sub": str(user_id),
        "vids": venue_ids,
        # {"<venue_id>": ["admin","promotor"]}
        "roles": {str(v): r for v, r in roles.items()},
        "tver": token_version,
        "iat": now,
        "exp": now + timedelta(minutes=settings.jwt_expires_minutes),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)