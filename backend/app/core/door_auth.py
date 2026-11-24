"""Autorización del teléfono de Puerta (mig 064).

El link de puerta ya no es solo una noche: al canjearlo el teléfono recibe un
token de dispositivo. Ese token viaja en `X-Door-Device` y el servidor lo
revalida en cada operación. Relevar el puesto o revocar la autorización cambia
el estado del dispositivo y el teléfono anterior deja de poder registrar
ingresos, salidas o sincronizaciones.

Compatibilidad: si un evento nunca tuvo dispositivos (instalaciones anteriores
a la 064), el bouncer sigue trabajando como antes. En cuanto hay un dispositivo
registrado para el evento, la puerta exige uno activo y del usuario correcto.
"""
import hashlib

import psycopg
from fastapi import HTTPException, status


def token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def authorize_door_device(
    cur: psycopg.AsyncCursor,
    *,
    event_id: int,
    venue_id: int,
    user: dict,
    raw_token: str | None,
) -> dict | None:
    """Devuelve el dispositivo autorizado, o None para staff administrativo.

    No autoriza silenciosamente un token inválido: un token presente que no
    corresponda a un dispositivo activo de ESTE usuario y evento es un 403.
    """
    roles = user["roles"].get(venue_id, [])
    if any(r in ("super_admin", "admin") for r in roles):
        return None
    if "bouncer" not in roles:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Este rol no puede operar la puerta.",
        )

    if raw_token:
        await cur.execute(
            """
            SELECT id, event_id, user_id, door_name, ticket_type_id, phone,
                   status, expires_at, activated_at
              FROM event_door_devices
             WHERE event_id = %s AND user_id = %s AND token_hash = %s
             ORDER BY id DESC
             LIMIT 1
            """,
            (event_id, user["id"], token_hash(raw_token)),
        )
        device = await cur.fetchone()
        if not device:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Este teléfono no está autorizado para esta puerta. "
                "Abre el link de Puerta que te envió Administración.",
            )
        if device["status"] != "active":
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Tu autorización de Puerta fue revocada o reemplazada. "
                "Pide un link nuevo a Administración.",
            )
        if device["expires_at"] is not None:
            await cur.execute(
                "SELECT (%s::timestamptz > now()) AS vigente",
                (device["expires_at"],),
            )
            if not (await cur.fetchone())["vigente"]:
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN,
                    "La autorización de este teléfono venció. Pide un link nuevo.",
                )
        await cur.execute(
            "UPDATE event_door_devices SET last_seen_at=now() WHERE id=%s",
            (device["id"],),
        )
        return device

    # Sin token: solo se permite si el evento nunca estrenó autorización por
    # dispositivo. Un evento con historial de dispositivos no puede volver al
    # modo "cualquier bouncer de la venue".
    await cur.execute(
        "SELECT count(*)::int AS n FROM event_door_devices WHERE event_id=%s",
        (event_id,),
    )
    if (await cur.fetchone())["n"] > 0:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Este teléfono no está autorizado para esta puerta. "
            "Abre el link de Puerta que te envió Administración.",
        )
    return None
