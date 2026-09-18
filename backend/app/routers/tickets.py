"""Emision y redencion de boletas.

La logica transaccional vive en la DB (emit_ticket/redeem_ticket). Aqui solo
expresamos los parametros y generamos el token crudo de alta entropia que va
en el QR (en la DB se guarda unicamente su SHA-256).
"""
import secrets
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    RedeemOut,
    TicketEmitRequest,
    TicketEmitResponse,
    TicketHistoryItem,
    TicketHistoryOut,
    TicketRedeemRequest,
)

router = APIRouter(prefix="/venues/{venue_id}", tags=["tickets"])


def _handle(venue_id: int, e: psycopg.errors.Error) -> None:
    """Traduce errores SQL de negocio a HTTP legibles."""
    msg = str(e)

    # psycopg mete el mensaje en e.diag.message_primary
    diag = getattr(e, "diag", None)
    primary = getattr(diag, "message_primary", "") or msg

    if "promoter_quota_exceeded" in primary:
        raise HTTPException(409, "Cupo de promotor agotado para este tipo de boleta")
    if "ticket_type_not_found" in primary:
        raise HTTPException(404, "Ese tipo de boleta no existe en este evento")
    if "ticket_type_sold_out" in primary or "event_at_capacity" in primary:
        raise HTTPException(409, "Sin disponibilidad para este tipo/evento")
    if "event_not_open_for_sales" in primary:
        raise HTTPException(409, "El evento no esta abierto para emision")
    # Migracion 004: el tipo/cupo archivado no acepta boletas nuevas (trigger).
    if "ticket_type_inactive" in primary:
        raise HTTPException(
            409, "Ese tipo de boleta esta archivado: no se pueden emitir mas boletas de ese tipo"
        )
    if "allocation_inactive" in primary:
        raise HTTPException(
            409, "Tu cupo esta archivado: pidele al admin que lo reactive"
        )
    if "paid_ticket_tied_to_promoter_allocation" in primary:
        raise HTTPException(400, "Una boleta de pago no puede usar cupo de promotor")
    if "event_not_found" in primary:
        raise HTTPException(
            404, "El evento de este escaneo ya no existe: selecciona otro en el escaner"
        )
    raise e


@router.post("/events/{event_id}/tickets", response_model=TicketEmitResponse, status_code=201)
async def emit_ticket(
    venue_id: int,
    event_id: int,
    body: TicketEmitRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    raw_token = secrets.token_urlsafe(24)  # ~32 bytes de entropia -> va al QR

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")

        try:
            await cur.execute(
                """
                SELECT emit_ticket(%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    event_id,
                    body.ticket_type_id,
                    body.allocation_id,
                    user["id"],
                    body.customer_name,
                    raw_token,
                    body.customer_phone,
                    body.customer_email,
                ),
            )
            row = await cur.fetchone()
            await db.commit()
        except psycopg.errors.Error as e:
            _handle(venue_id, e)

    ticket_id = row["emit_ticket"] if isinstance(row, dict) else row[0]
    return TicketEmitResponse(ticket_id=ticket_id, raw_token=raw_token, status="issued")


@router.get("/events/{event_id}/tickets/mine", response_model=TicketHistoryOut)
async def my_tickets(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Historial de boletas emitidas por el usuario actual en este evento.

    Visible para cualquier rol de la venue (el promotor ve lo suyo; el admin
    tambien puede llamarlo para auditar emisiones de un usuario puntual).
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")

        await cur.execute(
            """
            SELECT t.id, t.customer_name, t.customer_phone, t.status::text AS status,
                   t.issued_at, tt.name AS ticket_type, tt.is_courtesy
            FROM tickets t
            JOIN ticket_types tt ON tt.id = t.ticket_type_id
            WHERE t.event_id = %s AND t.sold_by_user_id = %s
            ORDER BY t.issued_at DESC, t.id DESC
            LIMIT 100
            """,
            (event_id, user["id"]),
        )
        rows = await cur.fetchall()

    return TicketHistoryOut(
        tickets=[
            TicketHistoryItem(
                ticket_id=r["id"],
                customer_name=r["customer_name"],
                customer_phone=r["customer_phone"],
                ticket_type=r["ticket_type"],
                is_courtesy=r["is_courtesy"] or False,
                status=r["status"],
                issued_at=r["issued_at"],
            )
            for r in rows
        ]
    )


@router.post("/events/{event_id}/redeem", response_model=RedeemOut)
async def redeem(
    venue_id: int,
    event_id: int,
    body: TicketRedeemRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "bouncer")

    async with db.cursor() as cur:
        try:
            await cur.execute(
                "SELECT redeem_ticket(%s, %s, %s, %s)",
                (event_id, body.raw_token, user["id"], body.ticket_type_id),
            )
            row = await cur.fetchone()
            code = row["redeem_ticket"] if isinstance(row, dict) else row[0]
            await db.commit()
        except psycopg.errors.Error as e:
            _handle(venue_id, e)

    out = RedeemOut(code=code, redeemed=(code == "GRANTED"))
    if code == "WRONG_TYPE":
        # Boleta válida del evento pero de otra fila: no se consumió. Se
        # informa el tipo real para que el portero la redireccione.
        async with db.cursor() as cur2:
            await cur2.execute(
                """
                SELECT t.id, t.customer_name, tt.name AS type_name
                FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id
                WHERE t.event_id=%s
                  AND t.token_hash = encode(digest(%s, 'sha256'), 'hex')
                """,
                (event_id, body.raw_token),
            )
            info = await cur2.fetchone()
            if info:
                out.ticket_id = info["id"]
                out.customer_name = info["customer_name"]
                out.detail = f"Boleta de {info['type_name']}"
    if code == "GRANTED":
        async with db.cursor() as cur2:
            await cur2.execute(
                """
                SELECT t.id, t.customer_name FROM tickets t
                WHERE t.event_id=%s AND t.status='redeemed'
                  AND t.token_hash = encode(digest(%s, 'sha256'), 'hex')
                """,
                (event_id, body.raw_token),
            )
            info = await cur2.fetchone()
            if info:
                out.ticket_id = info["id"]
                out.customer_name = info["customer_name"]
    return out