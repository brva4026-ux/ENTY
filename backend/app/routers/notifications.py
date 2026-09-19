"""Notificaciones in-app (mig 012, patrón de unicall-blue).

La escritura de notificaciones vive en la DB (triggers sobre payouts,
invitaciones y reemisiones: ver db/migrations/012_in_app_notifications.sql).
Este router solo lee y marca leídas, siguiendo la convención del proyecto:
los routers traducen parámetros y errores SQL a HTTP, no contienen lógica.

- GET  /notifications           -> feed propio (paginado con `before`)
- GET  /notifications/unread-count -> para el badge de la campana (barato)
- POST /notifications/read      -> marca leídas (todas o un subconjunto)

Aislamiento: un usuario SOLO ve sus filas (user_id = token). No hay endpoint
"de la venue": el admin no lee notificaciones de otro miembro.
"""
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.db import get_db
from app.deps import get_current_user
from app.schemas import NotificationOut, NotificationReadRequest

router = APIRouter(prefix="/notifications", tags=["notificaciones"])


@router.get("", response_model=list[NotificationOut])
async def list_notifications(
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    before: int | None = None,
    limit: int = 30,
):
    """Feed del usuario autenticado, más reciente primero.

    `before` = id de la última fila ya mostrada: paginación keyset simple que
    no se corrompe si llega una notificación nueva mientras se paginaba.
    """
    limit = max(1, min(limit, 100))
    async with db.cursor() as cur:
        if before is not None:
            await cur.execute(
                """
                SELECT id, kind, title, body, link, read_at, created_at
                FROM notifications
                WHERE user_id = %s AND id < %s
                ORDER BY id DESC
                LIMIT %s
                """,
                (user["id"], before, limit),
            )
        else:
            await cur.execute(
                """
                SELECT id, kind, title, body, link, read_at, created_at
                FROM notifications
                WHERE user_id = %s
                ORDER BY id DESC
                LIMIT %s
                """,
                (user["id"], limit),
            )
        return await cur.fetchall()


@router.get("/unread-count")
async def unread_count(
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
) -> dict[str, int]:
    """Conteo de no leídas del usuario (para el badge de la campana).

    Aprovecha el índice parcial idx_notifications_user_unread: solo lee las
    filas sin leer.
    """
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT count(*)::int AS n FROM notifications WHERE user_id = %s AND read_at IS NULL",
            (user["id"],),
        )
        row = await cur.fetchone()
    return {"count": row["n"]}


@router.post("/read", status_code=status.HTTP_204_NO_CONTENT)
async def mark_read(
    body: NotificationReadRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
) -> None:
    """Marca como leídas: todas, o solo las que trajo el dropdown.

    El UPDATE filtra por user_id del token: los ids ajenos simplemente no
    matchean (nadie puede marcar las notificaciones de otro).
    """
    async with db.cursor() as cur:
        if body.ids:
            await cur.execute(
                """
                UPDATE notifications
                   SET read_at = now()
                 WHERE user_id = %s AND read_at IS NULL AND id = ANY(%s)
                """,
                (user["id"], body.ids),
            )
        else:
            await cur.execute(
                "UPDATE notifications SET read_at = now() WHERE user_id = %s AND read_at IS NULL",
                (user["id"],),
            )
        await db.commit()
    return None
