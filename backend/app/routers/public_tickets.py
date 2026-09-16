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

from app.core.db import get_db
from app.schemas import PublicTicketOut, TicketLookupRequest
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
# token, que es lo unico que guarda la DB.
_TICKET_SQL = """
    SELECT t.id                AS ticket_id,
           t.customer_name     AS customer_name,
           t.status::text      AS status,
           e.name              AS event_name,
           e.event_timezone    AS event_timezone,
           to_char(e.starts_at AT TIME ZONE e.event_timezone,
                   'DD/MM/YYYY HH24:MI') AS starts_at,
           v.name              AS venue_name
      FROM tickets t
      JOIN events e ON e.id = t.event_id
      JOIN venues v ON v.id = e.venue_id
     WHERE t.token_hash = encode(digest(%s, 'sha256'), 'hex')
"""


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
    return await _load_ticket(db, body.raw_token)


@router.post("/image")
async def ticket_image(
    body: TicketLookupRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Imagen JPEG de la boleta (flyer + QR) para descargar o compartir."""
    _check_rate(request)
    row = await _load_ticket(db, body.raw_token)

    jpeg = build_ticket_image(
        ticket_number=row["ticket_id"],
        customer_name=row["customer_name"],
        event_name=row["event_name"],
        starts_at=row["starts_at"],
        raw_token=body.raw_token,
        venue_name=row["venue_name"],
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
