"""Sala de espera virtual (mig 055/056).

Protege la VENTA del pico de tráfico: cuando sale un cartel grande, diez mil
personas entran al mismo segundo y el checkout se cae. La sala las ordena en
una fila y deja pasar de a tandas, con un pase de vida corta.

Sin cuentas, igual que la lista de espera y la compra pública: el navegador
es la identidad. El fan recibe un `session_token` (lo guarda y lo manda en
cada consulta) y, cuando le toca, un `pass` que viaja al checkout.

Los dos tokens son opacos y se guardan hasheados en la DB: si se filtra la
tabla no se pueden fabricar pases ni robar lugares.
"""
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.core.db import get_db
from app.core.rate_limit import enforce_rate_limit
from app.core.security import digest_token
from app.schemas import WaitingRoomJoinOut, WaitingRoomJoinRequest, WaitingRoomStatusOut

router = APIRouter(prefix="/public", tags=["sala-de-espera"])

# El polling de la pantalla de espera es la petición más frecuente del
# sistema: cada fan pregunta cada pocos segundos. El cupo es amplio a
# propósito (frenar el polling legítimo rompe la sala), pero existe para que
# nadie use el endpoint como ariete.
_MAX_REQUESTS = 240
_WINDOW_SECONDS = 60


async def _check_rate(
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
) -> None:
    await enforce_rate_limit(
        request,
        db,
        scope="public:waiting_room",
        max_hits=_MAX_REQUESTS,
        window_seconds=_WINDOW_SECONDS,
    )


@router.post(
    "/events/{event_id}/waiting-room/join",
    response_model=WaitingRoomJoinOut,
)
async def join_waiting_room(
    event_id: int,
    body: WaitingRoomJoinRequest,
    request: Annotated[None, Depends(_check_rate)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Entra a la fila (o refresca el estado) y devuelve pase si le toca.

    Idempotente por `session_token`: el mismo navegador puede llamar cuantas
    veces quiera y no pierde su lugar ni acumula filas.
    """
    session_token = (body.session_token or "").strip()
    session_hash = digest_token(session_token)

    try:
        async with db.cursor() as cur:
            await cur.execute(
                "SELECT status, pass, queue_position, expires_at "
                "FROM join_waiting_room(%s, %s)",
                (event_id, session_hash),
            )
            row = await cur.fetchone()
        await db.commit()
    except psycopg.Error as error:
        await db.rollback()
        code = getattr(error, "sqlstate", None)
        if code == "P0001":
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Ese evento no existe"
            ) from error
        raise

    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ese evento no existe")

    return WaitingRoomJoinOut(
        status=row["status"],
        pass_token=row["pass"],
        queue_position=row["queue_position"],
        expires_at=row["expires_at"],
        session_token=session_token,
    )


@router.get(
    "/events/{event_id}/waiting-room/status",
    response_model=WaitingRoomStatusOut,
)
async def waiting_room_status(
    event_id: int,
    session_token: str,
    request: Annotated[None, Depends(_check_rate)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Posición en la fila, sin repartir pases (es lo que hace el polling)."""
    token = (session_token or "").strip()
    if len(token) < 16:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Sesión inválida")

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT status, queue_position, expires_at "
            "FROM waiting_room_status(%s, %s)",
            (event_id, digest_token(token)),
        )
        row = await cur.fetchone()

    return WaitingRoomStatusOut(
        status=row["status"],
        queue_position=row["queue_position"],
        expires_at=row["expires_at"],
    )
