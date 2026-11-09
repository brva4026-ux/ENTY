"""Lista de espera del evento (mig 022, E2 del ciclo DICE).

El evento agotado captura demanda: el fan entra a la fila SIN cuentas (el
telefono es la identidad y el token crudo del join es su credencial, igual
que el token del QR). Al liberarse un lugar —una devolucion E1— la oferta va
al primero con una ventana corta; si no reclama, hereda al siguiente.

Sin autenticacion a proposito: el publico no tiene cuenta en el sistema. El
token crudo viaja en el cuerpo (nunca en la URL) por la misma razon que el
token de la boleta: no terminar en logs ni historial.
"""
from datetime import datetime, timedelta
from time import monotonic
from typing import Annotated
from zoneinfo import ZoneInfo

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.core.db import get_db
from app.core.db_errors import translate_db_error
from app.core.security import digest_token
from app.schemas import (
    WaitlistClaimOut,
    WaitlistJoinOut,
    WaitlistJoinRequest,
    WaitlistStatusOut,
    WaitlistTokenRequest,
)

router = APIRouter(prefix="/waitlist", tags=["lista-de-espera"])

# Rate limit en memoria por IP (best-effort, igual que las boletas publicas):
# sin el, el join es un vector de escritura barato contra la fila.
_MAX_REQUESTS = 60
_WINDOW_SECONDS = 300.0
_HITS: dict[str, list[float]] = {}


def _check_rate(request: Request) -> None:
    fwd = request.headers.get("x-forwarded-for", "")
    ip = (
        request.headers.get("x-real-ip")
        or (fwd.split(",")[0].strip() if fwd else "")
        or "unknown"
    )
    now = monotonic()
    q = _HITS.setdefault(ip, [])
    while q and now - q[0] > _WINDOW_SECONDS:
        q.pop(0)
    if len(q) >= _MAX_REQUESTS:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Demasiadas solicitudes")
    q.append(now)
    if len(_HITS) > 10_000:
        for k in [k for k, v in _HITS.items() if not v or now - v[-1] > _WINDOW_SECONDS]:
            _HITS.pop(k, None)


def _handle_waitlist_error(e: psycopg.errors.Error) -> None:
    """Errores SQL de la lista a HTTP legible (público, sin jerga). Mapa único."""
    http = translate_db_error(
        e,
        overrides={
            "waitlist_not_needed": (
                409,
                "El evento aun tiene boletas: no hay lista de espera",
            ),
            "waitlist_offer_expired": (
                409,
                "Tu ventana de reclamo cerro: el lugar paso al siguiente",
            ),
            "waitlist_spot_gone": (
                409,
                "El lugar ya no esta disponible: se ofrecio al siguiente",
            ),
            "waitlist_entry_not_found": (404, "No estas en la lista de este evento"),
        },
    )
    if http is not None:
        raise http
    raise e


async def _expire_stale(cur: psycopg.AsyncCursor) -> None:
    """Watchdog perezoso (patron mig 020): expira ofertas vencidas y hereda
    el lugar al siguiente. Lo llaman TODOS los endpoints: el polling de los
    propios interesados es el cron que serverless no tiene."""
    await cur.execute("SELECT expire_waitlist_offers()")


@router.post("/{event_id}/join", response_model=WaitlistJoinOut, status_code=201)
async def join_waitlist(
    event_id: int,
    body: WaitlistJoinRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """El fan entra a la fila de un evento agotado.

    Idempotente por telefono: re-entrar actualiza el nombre y confirma la
    posicion, sin duplicar. El token crudo solo se entrega en el PRIMER join
    (en la DB queda su hash): quien perdio su enlace no puede recuperar la
    credencial (igual que una boleta), pero no pierde su lugar.
    """
    _check_rate(request)
    import secrets

    raw_token = ""
    position = 0
    out_status = "waiting"

    async with db.cursor() as cur:
        await _expire_stale(cur)
        await cur.execute(
            "SELECT status::text AS status FROM event_waitlist WHERE event_id=%s AND phone=%s",
            (event_id, body.phone.strip()),
        )
        existing = await cur.fetchone()

        try:
            if existing is None:
                raw_token = secrets.token_urlsafe(24)
                await cur.execute(
                    "SELECT join_waitlist(%s, %s, %s, %s)",
                    (event_id, body.name, body.phone, raw_token),
                )
                position = (await cur.fetchone())["join_waitlist"]
            else:
                # Re-join: mismos datos, misma credencial en DB (la funcion
                # solo actualiza el nombre cuando el telefono ya existe; el
                # token que pasa aqui nunca se usa).
                await cur.execute(
                    "SELECT join_waitlist(%s, %s, %s, %s)",
                    (event_id, body.name, body.phone,
                     "rejoin::" + secrets.token_urlsafe(8)),
                )
                position = (await cur.fetchone())["join_waitlist"]
                out_status = existing["status"]
                if out_status != "waiting":
                    position = 0  # ya no hay "posicion": tiene oferta cerrada
            await db.commit()
        except psycopg.errors.Error as e:
            _handle_waitlist_error(e)

    return WaitlistJoinOut(token=raw_token, position=position, status=out_status)


@router.post("/status", response_model=WaitlistStatusOut)
async def waitlist_status(
    body: WaitlistTokenRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Estado del fan en la fila: posicion, u oferta con su cuenta regresiva."""
    _check_rate(request)
    token_hash = digest_token(body.token)
    async with db.cursor() as cur:
        await _expire_stale(cur)
        await cur.execute(
            """
            SELECT w.status::text AS status, w.offered_at, w.created_at, w.id AS wid,
                   e.name AS event_name, e.event_timezone, e.waitlist_offer_minutes,
                   v.name AS venue_name,
                   to_char(e.starts_at AT TIME ZONE e.event_timezone,
                           'DD/MM/YYYY HH24:MI') AS starts_at
              FROM event_waitlist w
              JOIN events e ON e.id = w.event_id
              JOIN venues v ON v.id = e.venue_id
             WHERE w.token_hash = %s
            """,
            (token_hash,),
        )
        row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "No estas en la lista de este evento")

    position = None
    offer_expires_at = None
    offer_seconds_left = None
    if row["status"] == "waiting":
        async with db.cursor() as cur2:
            await cur2.execute(
                """
                SELECT count(*) AS ahead FROM event_waitlist w
                 WHERE w.event_id = (SELECT event_id FROM event_waitlist
                                      WHERE id = %s)
                   AND w.status = 'waiting'
                   AND (w.created_at, w.id) < (%s, %s)
                """,
                (row["wid"], row["created_at"], row["wid"]),
            )
            position = (await cur2.fetchone())["ahead"] + 1
    elif row["status"] == "offered":
        expires = row["offered_at"] + timedelta(minutes=row["waitlist_offer_minutes"])
        try:
            tz = ZoneInfo(row["event_timezone"])
        except Exception:
            tz = expires.tzinfo
        offer_expires_at = expires.astimezone(tz).strftime("%H:%M")
        offer_seconds_left = max(
            0, int((expires - datetime.now(expires.tzinfo)).total_seconds())
        )

    return WaitlistStatusOut(
        status=row["status"],
        position=position,
        event_name=row["event_name"],
        venue_name=row["venue_name"],
        starts_at=row["starts_at"],
        offer_expires_at=offer_expires_at,
        offer_seconds_left=offer_seconds_left,
    )


@router.post("/claim", response_model=WaitlistClaimOut)
async def claim_waitlist(
    body: WaitlistTokenRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Reclamar la oferta = boleta NUEVA contra el lugar liberado.

    El token crudo de la boleta se genera aqui y viaja UNA sola vez en la
    respuesta; en la DB queda su hash (mismo contrato que emitir). La
    credencial del fan deja de servir tras el reclamo.
    """
    _check_rate(request)
    import secrets

    raw_ticket_token = secrets.token_urlsafe(24)
    token_hash = digest_token(body.token)

    async with db.cursor() as cur:
        try:
            await cur.execute(
                "SELECT claim_waitlist(%s, %s)",
                (token_hash, raw_ticket_token),
            )
            ticket_id = (await cur.fetchone())["claim_waitlist"]
            await db.commit()
        except psycopg.errors.Error as e:
            _handle_waitlist_error(e)

    return WaitlistClaimOut(ticket_id=ticket_id, raw_token=raw_ticket_token)


@router.post("/leave")
async def leave_waitlist(
    body: WaitlistTokenRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """El fan se va de la fila por voluntad propia; si tenia oferta activa,
    el turno se hereda al siguiente con el mismo lugar."""
    _check_rate(request)
    async with db.cursor() as cur:
        try:
            await cur.execute(
                "SELECT leave_waitlist(%s)",
                (digest_token(body.token),),
            )
            await db.commit()
        except psycopg.errors.Error as e:
            _handle_waitlist_error(e)
    return {"status": "left"}
