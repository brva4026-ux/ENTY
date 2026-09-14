"""Dependencias de autenticacion y autorizacion por rol/venue.

Los roles viajan en el JWT (claim `roles`: {"<venue_id>": [...]}), de modo que
cada request decide autorizacion sin tocar la DB. La DB se consulta solo para
verificar que el usuario sigue activo.
"""
from typing import Annotated

import psycopg
from fastapi import Depends, Header, HTTPException, status
from jose import JWTError, jwt

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
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token invalido")

    user_id = int(payload["sub"])
    async with db.cursor() as cur:
        await cur.execute("SELECT id, email, full_name, is_active FROM users WHERE id = %s", (user_id,))
        user = await cur.fetchone()
    if not user or not user["is_active"]:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuario inactivo")

    return {
        "id": user["id"],
        "email": user["email"],
        "full_name": user["full_name"],
        "venue_ids": [int(v) for v in payload.get("vids", [])],
        "roles": {int(k): v for k, v in payload.get("roles", {}).items()},
    }


def ensure_roles(user: dict, venue_id: int, *allowed: str) -> None:
    """Lanza 403 si el usuario no tiene ninguno de los roles `allowed` en la venue."""
    roles = user["roles"].get(venue_id, [])
    if not roles or not any(r in allowed for r in roles):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, f"Sin permisos para la venue {venue_id}"
        )