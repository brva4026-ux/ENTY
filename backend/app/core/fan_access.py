"""Enlace de acceso del fan: la credencial que prueba que el contacto es suyo.

Antes, el correo o telefono ERA la credencial: cualquiera que lo conociera
(en la cartelera publica aparecen los nombres de los locales; un correo se
adivina) podia listar boletas ajenas y, peor, pedir su QR — que rota el token
y deja al dueno legitimo sin entrada. Medido: `POST /public/my-tickets/3/token`
con solo el correo devolvia el token crudo y la imagen del QR (85 KB).

Ahora el contacto solo sirve para PEDIR el enlace; el enlace (firmado, de vida
corta, un solo proposito) es lo que abre la lista y el QR. Se firma con una
clave DERIVADA del jwt_secret y un `typ` propio: aunque el `typ` se saltara,
la clave no sirve para firmar un JWT de staff, ni al reves. Sin tabla nueva:
el token se valida con la firma, no consultando la DB.
"""
import hashlib
import hmac
from datetime import datetime, timedelta, timezone

from jose import JWTError, jwt

from app.core.config import get_settings

# 30 minutos: lo que tarda alguien en abrir el correo y usarlo. Corto a
# proposito — el enlace viaja por un canal (el correo) que no controlamos.
_ACCESS_TTL_MINUTES = 30
_TYP = "fan_access"


def _signing_key() -> str:
    """Clave derivada: separa criptograficamente este token del JWT de staff."""
    settings = get_settings()
    return hmac.new(
        settings.jwt_secret.encode("utf-8"), b"fan-access-v1", hashlib.sha256
    ).hexdigest()


def create_fan_access_token(contact: str) -> str:
    """Token firmado que acredita el contacto (correo normalizado o digitos)."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": contact,
        "typ": _TYP,
        "iat": now,
        "exp": now + timedelta(minutes=_ACCESS_TTL_MINUTES),
    }
    return jwt.encode(payload, _signing_key(), algorithm="HS256")


def verify_fan_access_token(raw: str) -> str | None:
    """Devuelve el contacto acreditado, o None si la firma/expiración no dan.

    Nunca lanza: un token vencido, alterado o de otro tipo es simplemente
    "no acreditado". El llamador responde igual que ante un token inexistente,
    para no revelar cual de las dos cosas fallo.
    """
    try:
        payload = jwt.decode(raw, _signing_key(), algorithms=["HS256"])
    except JWTError:
        return None
    if payload.get("typ") != _TYP:
        return None
    sub = payload.get("sub")
    return sub if isinstance(sub, str) and sub else None
