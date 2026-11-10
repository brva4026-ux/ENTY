"""Dependencias de autenticacion y autorizacion por rol/venue.

Los roles viajan en el JWT (claim `roles`: {"<venue_id>": [...]}), de modo que
cada request decide autorizacion sin tocar la DB. La DB se consulta solo para
verificar que el usuario sigue activo.
"""
from typing import Annotated

import psycopg
from fastapi import Depends, Header, HTTPException, status
from jwt import PyJWTError, decode

from app.core.config import get_settings
from app.core.db import get_db


async def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)] = None,
) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "No autenticado")

    token = authorization.split(" ", 1)[1].strip()
    settings = get_settings()
    try:
        payload = decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token invalido")

    user_id = int(payload["sub"])
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, email, full_name, is_active, token_version FROM users WHERE id = %s",
            (user_id,),
        )
        user = await cur.fetchone()
    if not user or not user["is_active"]:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuario inactivo")

    # Revocacion de sesiones (mig 019): si la version del token no coincide
    # con la actual del usuario, alguien cambio su contraseña y este token
    # quedo muerto. Los tokens emitidos ANTES de la 019 no traen el claim:
    # se les permite terminar su expiracion natural (60 min) para no
    # desloguear a todos en el deploy.
    tver = payload.get("tver")
    if tver is not None and int(tver) != int(user["token_version"]):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Sesion revocada: inicia sesion de nuevo",
        )

    # Re-verificar roles en la DB en cada request: el JWT guarda las venues,
    # pero la fuente de verdad de permisos es venue_user_roles. Asi un rol
    # revocado (o un usuario desactivado de una venue) aplica de inmediato
    # sin esperar a que expire el token.
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT venue_id, role FROM venue_user_roles WHERE user_id = %s",
            (user_id,),
        )
        rows = await cur.fetchall()

    roles: dict[int, list[str]] = {}
    for r in rows:
        roles.setdefault(int(r["venue_id"]), []).append(r["role"])

    return {
        "id": user["id"],
        "email": user["email"],
        "full_name": user["full_name"],
        "venue_ids": sorted(roles.keys()),
        "roles": roles,
    }


def ensure_roles(user: dict, venue_id: int, *allowed: str) -> None:
    """Lanza 403 si el usuario no tiene ninguno de los roles `allowed` en la venue."""
    roles = user["roles"].get(venue_id, [])
    if not roles or not any(r in allowed for r in roles):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, f"Sin permisos para la venue {venue_id}"
        )