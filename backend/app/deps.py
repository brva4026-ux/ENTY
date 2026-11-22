"""Dependencias de autenticacion y autorizacion por rol/venue.

La identidad llega por cookie HttpOnly o Bearer para clientes API. Cada
request revalida usuario, version de sesion y roles contra la base de datos.
"""
import hashlib
from typing import Annotated

import psycopg
from fastapi import Depends, Header, HTTPException, Request, status
from jwt import PyJWTError, decode

from app.core.config import get_settings
from app.core.db import get_db
from app.core.session import COOKIE_NAME, check_session_origin


async def get_current_user(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)] = None,
) -> dict:
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    else:
        token = request.cookies.get(COOKIE_NAME)
        if not token:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "No autenticado")
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            check_session_origin(request, required=True)
    settings = get_settings()
    try:
        payload = decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except PyJWTError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token invalido") from e

    user_id = int(payload["sub"])
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, email, full_name, is_active, token_version FROM users WHERE id = %s",
            (user_id,),
        )
        user = await cur.fetchone()
    if not user or not user["is_active"]:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuario inactivo")

    # Sesiones individuales (mig 059). El token crudo nunca se guarda: solo su
    # SHA-256. Un token revocado deja de servir aunque no haya expirado. Los
    # tokens anteriores a la migracion se registran en su primer uso.
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    ip = (
        request.headers.get("x-real-ip")
        or (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        or "unknown"
    )
    try:
        async with db.cursor() as cur:
            await cur.execute(
                "SELECT id, revoked_at, last_seen_at FROM user_sessions "
                "WHERE token_hash = %s",
                (token_hash,),
            )
            session_row = await cur.fetchone()
            if session_row and session_row["revoked_at"] is not None:
                raise HTTPException(
                    status.HTTP_401_UNAUTHORIZED,
                    "Sesion cerrada en este dispositivo",
                )
            if session_row is None:
                await cur.execute(
                    """INSERT INTO user_sessions
                       (token_hash, user_id, user_agent, ip)
                       VALUES (%s, %s, %s, %s)
                       ON CONFLICT (token_hash) DO NOTHING""",
                    (
                        token_hash,
                        user_id,
                        (request.headers.get("user-agent") or "")[:250],
                        ip,
                    ),
                )
            else:
                # La actividad se actualiza como mucho cada 5 minutos: es un
                # dato real sin convertir cada request en una escritura.
                await cur.execute(
                    """UPDATE user_sessions SET last_seen_at = now()
                       WHERE id = %s AND last_seen_at < now() - interval '5 minutes'""",
                    (session_row["id"],),
                )
        await db.commit()
    except psycopg.errors.UndefinedTable:
        await db.rollback()

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


async def get_optional_current_user(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)] = None,
) -> dict | None:
    """Como `get_current_user`, pero sin sesión devuelve None.

    Solo para superficies que siguen siendo públicas (la ficha del evento):
    el modo vista previa exige sesión, pero un fan sin cuenta debe seguir
    entrando a la ficha normal.
    """
    try:
        return await get_current_user(request, authorization, db)
    except HTTPException as e:
        if e.status_code == status.HTTP_401_UNAUTHORIZED:
            return None
        raise


def ensure_roles(user: dict, venue_id: int, *allowed: str) -> None:
    """Lanza 403 si el usuario no tiene ninguno de los roles `allowed` en la venue."""
    roles = user["roles"].get(venue_id, [])
    if not roles or not any(r in allowed for r in roles):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, f"Sin permisos para la venue {venue_id}"
        )
