"""Boleta del invitado: consulta publica y descarga de la imagen.

El promotor emite la boleta y le comparte un **enlace**; el invitado lo abre en
su telefono y ve el QR para que el bouncer lo escanee. El token crudo es la
credencial (192 bits, no adivinable) y no se guarda en la DB: solo su SHA-256.
Por eso estos endpoints reciben el token en el cuerpo (nunca en la URL, que
terminaria en logs e historial del navegador).

Sin autenticacion a proposito: el invitado no tiene cuenta en el sistema.
"""
from collections import defaultdict, deque
from time import monotonic
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.core.db import get_db
from app.core.security import digest_token
from app.schemas import (
    PublicTicketOut,
    TicketLookupRequest,
    TicketReturnOut,
    TicketReturnRequest,
)
from app.services.ticket_image import build_ticket_image

router = APIRouter(prefix="/tickets", tags=["boleta-publica"])

# Rate limit en memoria por IP (best-effort, igual que el login). El endpoint
# de imagen compone un JPEG con Pillow: sin limite, es un vector de agotamiento
# de CPU barato de disparar.
_MAX_REQUESTS = 60
_WINDOW_SECONDS = 300.0
_HITS: dict[str, deque[float]] = defaultdict(deque)


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return (
        request.headers.get("x-real-ip")
        or (fwd.split(",")[0].strip() if fwd else "")
        or "unknown"
    )


def _check_rate(request: Request) -> None:
    key = _client_ip(request)
    q = _HITS[key]
    now = monotonic()
    while q and now - q[0] > _WINDOW_SECONDS:
        q.popleft()
    if len(q) >= _MAX_REQUESTS:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Demasiadas solicitudes")
    q.append(now)
    if len(_HITS) > 10_000:
        for k in [k for k, v in _HITS.items() if not v or now - v[-1] > _WINDOW_SECONDS]:
            _HITS.pop(k, None)


# Un solo SELECT para las dos vistas: la boleta se identifica por el hash del
# token, que es lo unico que guarda la DB. Trae también la ventana de
# activación del QR (mig 013): el QR se dibuja solo dentro de la ventana.
_TICKET_SQL = """
    SELECT t.id                AS ticket_id,
           t.customer_name     AS customer_name,
           t.status::text      AS status,
           e.name              AS event_name,
           e.location          AS location,
           e.event_timezone    AS event_timezone,
           e.starts_at         AS starts_at_raw,
           e.qr_unlock_minutes AS qr_unlock_minutes,
           to_char(e.starts_at AT TIME ZONE e.event_timezone,
                   'DD/MM/YYYY HH24:MI') AS starts_at,
           EXISTS (SELECT 1 FROM ticket_returns tr
                    WHERE tr.ticket_id = t.id) AS was_returned,
           v.name              AS venue_name
      FROM tickets t
      JOIN events e ON e.id = t.event_id
      JOIN venues v ON v.id = e.venue_id
     WHERE t.token_hash = encode(digest(%s, 'sha256'), 'hex')
"""


def _handle_return(e: psycopg.errors.Error) -> None:
    """Errores SQL de return_ticket a HTTP legible (invitado, sin jerga)."""
    primary = str(e)
    diag = getattr(e, "diag", None)
    if diag is not None and getattr(diag, "message_primary", ""):
        primary = diag.message_primary
    if "return_window_closed" in primary:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "La ventana de devolución ya cerró"
        )
    if "token_stale" in primary:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Este enlace ya no es la credencial vigente: pide la boleta de nuevo",
        )
    if "cannot_return_ticket" in primary or "ticket_not_found" in primary:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Esta boleta ya no se puede devolver"
        )
    raise e


def _activation(row: dict) -> tuple[bool, str | None]:
    """Devuelve (qr_visible, motivo_para_la_ui).

    Regla DICE: el QR se dibuja solo dentro de la ventana
    [starts_at - unlock, fin). 0 = se activa con la apertura.
    """
    unlock = row.get("qr_unlock_minutes")
    starts_at: datetime = row["starts_at_raw"]
    if unlock is None:
        unlock = 60
    qr_ready_at = starts_at - timedelta(minutes=unlock)
    if datetime.now( qr_ready_at.tzinfo) >= qr_ready_at:
        return True, None
    # Fuera de ventana: la UI recibe cuándo se activa y cuándo empieza.
    try:
        tz = ZoneInfo(row["event_timezone"])
    except Exception:
        tz = qr_ready_at.tzinfo
    fmt = lambda d: d.astimezone(tz).strftime("%d/%m %H:%M")
    return False, f"Tu QR se activa el {fmt(qr_ready_at)} · El evento empieza el {fmt(starts_at)}"


async def _load_ticket(db: psycopg.AsyncConnection, raw_token: str) -> dict:
    async with db.cursor() as cur:
        await cur.execute(_TICKET_SQL, (raw_token,))
        row = await cur.fetchone()
    if not row:
        # Mismo mensaje para token invalido y boleta inexistente: no damos
        # senal de si un token existe o no.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Boleta no encontrada")
    return row


@router.post("/preview", response_model=PublicTicketOut)
async def preview_ticket(
    body: TicketLookupRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Datos de la boleta para pintarla en la pagina del invitado."""
    _check_rate(request)
    row = await _load_ticket(db, body.raw_token)
    active, msg = _activation(row)
    # Devolucion (E1): el boton "No puedo ir" se ofrece solo mientras la
    # ventana esta ABIERTA, es decir ANTES del unlock del QR (devolver cerca
    # de la noche ya no ayuda a nadie: el cupo es compromiso de puerta).
    # Pasado el limite, la DB responde 'return_window_closed' y aqui el
    # boton desaparece: misma regla, dos capas.
    can_return = (row["status"] == "issued") and not active
    # Hasta cuando puede devolver: el instante de activacion del QR, en la
    # zona del evento (misma que empieza a contar el unlock).
    return_until = None
    if can_return:
        try:
            tz = ZoneInfo(row["event_timezone"])
        except Exception:
            tz = row["starts_at_raw"].tzinfo
        unlock = row.get("qr_unlock_minutes")
        if unlock is None:
            unlock = 60
        return_until = (
            row["starts_at_raw"] - timedelta(minutes=unlock)
        ).astimezone(tz).strftime("%d/%m %H:%M")
    return PublicTicketOut(
        ticket_id=row["ticket_id"],
        customer_name=row["customer_name"],
        event_name=row["event_name"],
        venue_name=row["venue_name"],
        location=row["location"],
        starts_at=row["starts_at"],
        status=row["status"],
        qr_active=active,
        qr_message=msg,
        can_return=can_return,
        return_until=return_until,
        was_returned=bool(row.get("was_returned")),
    )


@router.post("/image")
async def ticket_image(
    body: TicketLookupRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Imagen JPEG de la boleta (flyer + QR) para descargar o compartir."""
    _check_rate(request)
    row = await _load_ticket(db, body.raw_token)
    active, msg = _activation(row)
    if row["status"] not in ("issued", "redeemed"):
        # E1-4: el link sigue circulando por WhatsApp. Para una boleta
        # devuelta/anulada el QR no se puede regenerar por NINGUN canal: un
        # 410 explicito en vez de un QR que la puerta ya va a rechazar.
        raise HTTPException(status.HTTP_410_GONE, "Boleta no vigente")
    if not active:
        # La imagen lleva el QR dentro: fuera de la ventana NO se compone.
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            msg or "El QR aún no está activo",
        )

    jpeg = build_ticket_image(
        ticket_number=row["ticket_id"],
        customer_name=row["customer_name"],
        event_name=row["event_name"],
        starts_at=row["starts_at"],
        raw_token=body.raw_token,
        venue_name=row["venue_name"],
        location=row["location"],
    )
    # no-store: la imagen lleva el token del QR dentro; que no quede en caches
    # intermedias ni en el disco del navegador.
    return Response(
        content=jpeg,
        media_type="image/jpeg",
        headers={
            "Content-Disposition": f'inline; filename="boleta-{row["ticket_id"]}.jpg"',
            "Cache-Control": "no-store, private",
        },
    )


@router.post("/return", response_model=TicketReturnOut)
async def return_ticket(
    body: TicketReturnRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """El invitado devuelve su boleta: "No puedo ir" (mig 021, E1 del ciclo DICE).

    Sin auth a proposito: el token crudo es la credencial (192 bits), igual
    que en preview/image. Se manda el ticket_id junto al token para que la
    funcion SQL verifique que ESE token sigue siendo la credencial VIGENTE de
    ESA boleta (hash esperado): si el promotor reemitio mientras el invitado
    tenia la pagina abierta, el token viejo ya no mata la boleta nueva.

    La ventana limite vive en la DB ('return_window_closed'): nunca despues
    del unlock del QR, cuando el cupo ya es compromiso de puerta.
    """
    _check_rate(request)
    token_hash = digest_token(body.raw_token)

    async with db.cursor() as cur:
        # Primero validar que el token sea la credencial vigente de la boleta:
        # mismisimo mensaje para 404 y hash distinto (no senalar cual de los
        # dos fallo: no damos informacion a quien adivina tokens).
        await cur.execute(
            """
            SELECT (t.token_hash = encode(digest(%s, 'sha256'), 'hex')) AS owns
              FROM tickets t
             WHERE t.id = %s
            """,
            (body.raw_token, body.ticket_id),
        )
        r = await cur.fetchone()
        if not r or not r["owns"]:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Boleta no encontrada"
            )

        try:
            await cur.execute(
                "SELECT return_ticket(%s, %s, NULL)",
                (body.ticket_id, token_hash),
            )
            await db.commit()
        except psycopg.errors.Error as e:
            _handle_return(e)

    return TicketReturnOut(ticket_id=body.ticket_id, status="returned")
