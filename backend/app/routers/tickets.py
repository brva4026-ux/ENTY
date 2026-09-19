"""Emision y redencion de boletas.

La logica transaccional vive en la DB (emit_ticket/redeem_ticket). Aqui solo
expresamos los parametros y generamos el token crudo de alta entropia que va
en el QR (en la DB se guarda unicamente su SHA-256).
"""
import secrets
from datetime import datetime, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo

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
    TicketReissueRequest,
    TicketReissueResponse,
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
    if "ticket_not_found" in primary:
        raise HTTPException(404, "Boleta no encontrada")
    if "cannot_reissue_redeemed" in primary:
        raise HTTPException(409, "La boleta ya fue usada: no se puede reemitir")
    if "cannot_reissue_ticket" in primary:
        raise HTTPException(
            409, "La boleta no esta vigente (anulada o reembolsada): no se puede reemitir"
        )
    if "event_closed" in primary:
        raise HTTPException(409, "El evento ya cerro: no se puede reemitir")
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

    # `force` (mig 013): solo staff, nunca el escáner automático del bouncer.
    if body.force:
        ensure_roles(user, venue_id, "super_admin", "admin")

    async with db.cursor() as cur:
        try:
            await cur.execute(
                "SELECT redeem_ticket(%s, %s, %s, %s)",
                (event_id, body.raw_token, user["id"], body.ticket_type_id),
            )
            row = await cur.fetchone()
            code = row["redeem_ticket"] if isinstance(row, dict) else row[0]

            if code == "NOT_ACTIVE" and body.force:
                # El staff decide dejar pasar fuera de ventana: consulta la
                # ventana sin exigirla. La boleta aún NO está consumida: el
                # UPDATE de abajo hace el canje real (mismo CAS de siempre).
                await cur.execute(
                    """
                    SELECT (starts_at - (qr_unlock_minutes * INTERVAL '1 minute')) <= now()
                           OR qr_unlock_minutes = 0
                       AS ok
                    FROM events WHERE id=%s
                    """,
                    (event_id,),
                )
                forced = (await cur.fetchone())["ok"]
                if forced:  # NOT_ACTIVE es exactamente 'no'; si ya activó, no forzar
                    await cur.execute(
                        """
                        UPDATE tickets
                           SET status='redeemed', redeemed_at=now(),
                               redeemed_by_user_id=%s
                         WHERE id=(SELECT id FROM tickets
                                    WHERE token_hash=encode(digest(%s,'sha256'),'hex'))
                           AND status='issued'
                        """,
                        (user["id"], body.raw_token),
                    )
                    if cur.rowcount == 1:
                        await cur.execute(
                            """
                            INSERT INTO redemptions
                                (ticket_id, event_id, scanned_by_user_id, outcome)
                            SELECT id, %s, %s, 'granted_forced' FROM tickets
                             WHERE token_hash=encode(digest(%s,'sha256'),'hex')
                            """,
                            (event_id, user["id"], body.raw_token),
                        )
                        code = "GRANTED"
            await db.commit()
        except psycopg.errors.Error as e:
            _handle(venue_id, e)

    out = RedeemOut(code=code, redeemed=(code == "GRANTED"))
    if code == "NOT_ACTIVE":
        # Mig 013: boleta válida pero su QR aún no se activa (fuera de la
        # ventana). No se consumió: podrá entrar cuando abra la ventana. Se
        # informa LA HORA exacta (en la zona del evento): en la puerta eso es
        # lo accionable — "vuelve a las 22:00" y no "vuelve más tarde".
        async with db.cursor() as cur2:
            await cur2.execute(
                """
                SELECT starts_at, event_timezone,
                       (starts_at - (qr_unlock_minutes * INTERVAL '1 minute')) AS ready_at
                FROM events WHERE id = %s
                """,
                (event_id,),
            )
            ev = await cur2.fetchone()
        if ev:
            try:
                tz = ZoneInfo(ev["event_timezone"])
            except Exception:
                tz = ZoneInfo("UTC")
            fmt = lambda d: d.astimezone(tz).strftime("%H:%M")
            out.detail = (
                f"QR se activa a las {fmt(ev['ready_at'])} "
                f"(evento {fmt(ev['starts_at'])})"
            )
        else:
            out.detail = "El QR de esta boleta aún no está activo"
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


@router.post(
    "/events/{event_id}/tickets/{ticket_id}/reissue",
    response_model=TicketReissueResponse,
)
async def reissue_ticket(
    venue_id: int,
    event_id: int,
    ticket_id: int,
    body: TicketReissueRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Recupera una boleta viva rotando su token y devuelve el QR nuevo.

    El token crudo se entrego una sola vez al emitir y en la DB solo hay su
    SHA-256, asi que la boleta era irrecuperable si el invitado perdia el enlace
    (WhatsApp no salio, borro el chat, el promotor cerro la pestaña). No se puede
    resucitar el token viejo sin guardarlo en claro -justo lo que el hash evita-,
    asi que se emite uno nuevo: misma boleta, mismo cupo, mismo aforo.

    El token anterior deja de servir en el acto (el hash se reemplaza), lo que
    ademas corta cualquier copia del QR viejo que haya circulado.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")

    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT t.status, t.sold_by_user_id
              FROM tickets t
              JOIN events e ON e.id = t.event_id
             WHERE t.id = %s AND t.event_id = %s AND e.venue_id = %s
            """,
            (ticket_id, event_id, venue_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Boleta no encontrada")

        # Un promotor solo reemite SUS boletas: si no, podria rotar el QR de un
        # invitado ajeno y quedarse con la entrada (o invalidarsela).
        roles = user["roles"].get(venue_id, [])
        is_staff = any(r in ("super_admin", "admin") for r in roles)
        if not is_staff and row["sold_by_user_id"] != user["id"]:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Solo puedes reemitir tus propias boletas"
            )

        raw_token = secrets.token_urlsafe(24)  # credencial nueva para el QR
        try:
            await cur.execute(
                "SELECT reissue_ticket(%s, %s, %s, %s)",
                (ticket_id, raw_token, user["id"], body.reason),
            )
            await db.commit()
        except psycopg.errors.Error as e:
            _handle(venue_id, e)

        await cur.execute(
            "SELECT customer_name, customer_phone FROM tickets WHERE id = %s",
            (ticket_id,),
        )
        info = await cur.fetchone()

    return TicketReissueResponse(
        ticket_id=ticket_id,
        raw_token=raw_token,
        customer_name=info["customer_name"],
        customer_phone=info["customer_phone"],
        status="issued",
    )