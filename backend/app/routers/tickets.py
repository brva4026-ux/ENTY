"""Emision y redencion de boletas.

La logica transaccional vive en la DB (emit_ticket/redeem_ticket). Aqui solo
expresamos los parametros y generamos el token crudo de alta entropia que va
en el QR (en la DB se guarda unicamente su SHA-256).
"""
import secrets
from datetime import datetime, timezone
from typing import Annotated
from zoneinfo import ZoneInfo

import psycopg
from fastapi import APIRouter, Depends, Header, HTTPException, status

from app.core.db import get_db
from app.core.db_errors import translate_db_error
from app.core.door_auth import authorize_door_device
from app.core.lifecycle import auto_close_expired
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    DoorSnapshotEntry,
    DoorSnapshotOut,
    DoorSyncItem,
    DoorSyncOut,
    DoorSyncResult,
    PaymentOut,
    RedeemOut,
    TicketContactEditOut,
    TicketContactEditRequest,
    TicketContactEditResponse,
    TicketEmitRequest,
    TicketEmitResponse,
    TicketHistoryItem,
    TicketHistoryOut,
    TicketOperationalHistoryOut,
    TicketRedeemRequest,
    TicketReissueRequest,
    TicketReissueResponse,
    TicketReturnOut,
    TicketTimelineEntry,
)

router = APIRouter(prefix="/venues/{venue_id}", tags=["tickets"])


# ---------------------------------------------------------------------------
# Modo offline de puerta (snapshot + sync)
#
# El canje normal es server-autoritativo y sigue siéndolo. Esto existe para
# el caso real de un roncino sin señal: el escáner descarga los HASHES de
# las boletas vivas ANTES de que se caiga la red, valida localmente y envía
# las redenciones cuando vuelve la conexión. La DB re-evalúa cada token con
# redeem_ticket al sincronizar, así que el árbitro final sigue siendo la DB.
# ---------------------------------------------------------------------------


def _handle(venue_id: int, e: psycopg.errors.Error) -> None:
    """Errores SQL de negocio a HTTP, con el mapa único de `db_errors`.

    Solo se sobreescriben los mensajes donde la puerta de emisión aporta algo
    que el texto canónico no dice (el escáner manda a elegir otro evento; el
    tipo se busca dentro del evento abierto). El resto sale del mapa único,
    para que el mismo error no suene distinto según por dónde entró.
    """
    http = translate_db_error(
        e,
        overrides={
            "ticket_type_not_found": (404, "Ese tipo de boleta no existe en este evento"),
            "event_not_found": (
                404,
                "El evento de este escaneo ya no existe: selecciona otro en el escaner",
            ),
            "return_window_closed": (
                409,
                "La ventana de devolucion cerro: el QR ya esta activo",
            ),
        },
    )
    if http is not None:
        raise http
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
        # Idempotencia (mig 063): un doble toque o un reintento después de
        # perder la respuesta no puede gastar dos cupos. La clave es del
        # cliente y se guarda con la boleta; el índice único cierra la carrera
        # entre dos requests simultáneos.
        if body.client_request_id:
            await cur.execute(
                """
                SELECT id, status::text AS status, sale_channel
                  FROM tickets
                 WHERE event_id=%s AND sold_by_user_id=%s
                   AND client_request_id=%s
                """,
                (event_id, user["id"], body.client_request_id),
            )
            existing = await cur.fetchone()
            if existing:
                return TicketEmitResponse(
                    ticket_id=existing["id"],
                    raw_token=None,
                    status=existing["status"],
                    duplicate=True,
                    sale_channel=existing["sale_channel"],
                )

        await cur.execute(
            "SELECT 1 FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")

        # Origen legible: cupo asignado, emisión directa del promotor o venta
        # de taquilla de la organización. La atribución (sold_by_user_id) ya
        # existía; esto la vuelve explícita para ventas y comisiones.
        roles_here = (user.get("roles") or {}).get(venue_id) or []
        if body.allocation_id is not None:
            sale_channel = "promoter_quota"
        elif "promotor" in roles_here and "admin" not in roles_here:
            sale_channel = "promoter_direct"
        else:
            sale_channel = "venue"

        try:
            await cur.execute(
                """
                SELECT emit_ticket(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
                    body.payment_method,
                    body.customer_birth_date,
                ),
            )
            row = await cur.fetchone()
            ticket_id = row["emit_ticket"] if isinstance(row, dict) else row[0]
            if body.client_request_id:
                await cur.execute(
                    "UPDATE tickets SET client_request_id=%s, sale_channel=%s WHERE id=%s",
                    (body.client_request_id, sale_channel, ticket_id),
                )
            else:
                await cur.execute(
                    "UPDATE tickets SET sale_channel=%s WHERE id=%s",
                    (sale_channel, ticket_id),
                )
            await db.commit()
        except psycopg.errors.UniqueViolation:
            # Otra request con la misma clave ganó la carrera. Se revierte
            # esta emisión y se devuelve la boleta que sí quedó guardada.
            await db.rollback()
            async with db.cursor() as cur2:
                await cur2.execute(
                    """
                    SELECT id, status::text AS status, sale_channel
                      FROM tickets
                     WHERE event_id=%s AND sold_by_user_id=%s
                       AND client_request_id=%s
                    """,
                    (event_id, user["id"], body.client_request_id),
                )
                existing = await cur2.fetchone()
            if not existing:
                raise
            return TicketEmitResponse(
                ticket_id=existing["id"],
                raw_token=None,
                status=existing["status"],
                duplicate=True,
                sale_channel=existing["sale_channel"],
            )
        except psycopg.errors.Error as e:
            _handle(venue_id, e)

    return TicketEmitResponse(
        ticket_id=ticket_id,
        raw_token=raw_token,
        status="issued",
        sale_channel=sale_channel,
    )


@router.get(
    "/events/{event_id}/tickets/by-request/{client_request_id}",
    response_model=TicketEmitResponse,
)
async def ticket_by_request(
    venue_id: int,
    event_id: int,
    client_request_id: str,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Recupera el resultado de una emisión cuyo response se perdió.

    No devuelve el token crudo (la DB solo guarda su hash). La UI muestra
    «Comprobando emisión» y, si la boleta existe, ofrece reemitir el enlace.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT t.id, t.status::text AS status, t.sale_channel
              FROM tickets t
              JOIN events e ON e.id = t.event_id
             WHERE t.event_id=%s AND e.venue_id=%s
               AND t.sold_by_user_id=%s AND t.client_request_id=%s
            """,
            (event_id, venue_id, user["id"], client_request_id),
        )
        row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Todavía no hay una boleta para este intento")
    return TicketEmitResponse(
        ticket_id=row["id"],
        raw_token=None,
        status=row["status"],
        duplicate=True,
        sale_channel=row["sale_channel"],
    )


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
            SELECT t.id, t.customer_name, t.customer_phone, t.customer_email,
                   t.status::text AS status, t.issued_at, t.redeemed_at,
                   t.price_cents_snapshot, t.payment_method, t.sale_channel,
                   tt.name AS ticket_type, tt.is_courtesy
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
                customer_email=r["customer_email"],
                ticket_type=r["ticket_type"],
                is_courtesy=r["is_courtesy"] or False,
                status=r["status"],
                issued_at=r["issued_at"],
                price_cents=r["price_cents_snapshot"] or 0,
                payment_method=r["payment_method"],
                sale_channel=r["sale_channel"] or "venue",
                redeemed_at=r["redeemed_at"],
            )
            for r in rows
        ]
    )


@router.get(
    "/events/{event_id}/tickets/{ticket_id}/history",
    response_model=TicketOperationalHistoryOut,
)
async def ticket_operational_history(
    venue_id: int,
    event_id: int,
    ticket_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Expediente operativo de una boleta.

    Responde en una sola vista las preguntas que hoy obligan a saltar entre
    listados: ¿cómo se pagó?, ¿quién la emitió?, ¿se reemitió?, ¿entró?,
    ¿hubo una incidencia? El promotor ve solo sus boletas; el admin, todas
    las del evento. Los hashes del QR no se exponen: se cuenta qué pasó.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    roles = user["roles"].get(venue_id, [])
    is_staff = any(r in ("super_admin", "admin") for r in roles)

    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT t.id, t.event_id, t.status::text AS status, t.issued_at,
                   t.voided_at, t.redeemed_at, t.price_cents_snapshot,
                   t.payment_method, t.sold_by_user_id, t.customer_name,
                   t.customer_phone, t.customer_email,
                   COALESCE(t.sale_channel, 'venue') AS sale_channel,
                   tt.name AS type_name, tt.is_courtesy,
                   us.full_name AS sold_by_name,
                   ur.full_name AS redeemed_by_name
              FROM tickets t
              JOIN events e ON e.id = t.event_id
              JOIN ticket_types tt ON tt.id = t.ticket_type_id
              LEFT JOIN users us ON us.id = t.sold_by_user_id
              LEFT JOIN users ur ON ur.id = t.redeemed_by_user_id
             WHERE t.id=%s AND t.event_id=%s AND e.venue_id=%s
            """,
            (ticket_id, event_id, venue_id),
        )
        ticket = await cur.fetchone()
        if not ticket:
            raise HTTPException(404, "Boleta no encontrada")
        if not is_staff and ticket["sold_by_user_id"] != user["id"]:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Solo puedes ver el historial de tus propias boletas",
            )

        await cur.execute(
            """
            SELECT id, reference, status, amount_in_cents, customer_name,
                   customer_phone, customer_email, transaction_id,
                   approved_at, created_at, fulfillment_error
              FROM ticket_payments
             WHERE ticket_id=%s
             ORDER BY id DESC LIMIT 1
            """,
            (ticket_id,),
        )
        pay = await cur.fetchone()

        payment = (
            PaymentOut(
                id=pay["id"],
                reference=pay["reference"],
                status=pay["status"],
                amount_in_cents=pay["amount_in_cents"],
                customer_name=pay["customer_name"],
                customer_phone=pay["customer_phone"],
                customer_email=pay["customer_email"],
                ticket_id=ticket_id,
                transaction_id=pay["transaction_id"],
                approved_at=pay["approved_at"],
                created_at=pay["created_at"],
                fulfillment_error=pay["fulfillment_error"],
            )
            if pay
            else None
        )

        entries: list[TicketTimelineEntry] = []

        channel_label = {
            "venue": "Taquilla de la organización",
            "public": "Compra en línea",
            "promoter_direct": "Emisión directa del promotor",
            "promoter_quota": "Cupo del promotor",
            "promoter_link": "Enlace del promotor",
            "online": "Compra en línea",
        }.get(ticket["sale_channel"], ticket["sale_channel"])
        entries.append(
            TicketTimelineEntry(
                id=f"ticket-{ticket_id}-issued",
                kind="issued",
                at=ticket["issued_at"],
                title="Boleta emitida",
                detail=(
                    f"{ticket['type_name']} · {channel_label}"
                    + (" · Cortesía" if ticket["is_courtesy"] else "")
                ),
                actor_name=ticket["sold_by_name"],
                amount_cents=ticket["price_cents_snapshot"],
                status=ticket["status"],
                channel=ticket["sale_channel"],
            )
        )

        if payment:
            entries.append(
                TicketTimelineEntry(
                    id=f"payment-{payment.id}-created",
                    kind="payment_created",
                    at=payment.created_at,
                    title="Cobro creado",
                    detail=f"Referencia {payment.reference}",
                    amount_cents=payment.amount_in_cents,
                    status=payment.status,
                    channel="online",
                )
            )
            if payment.status == "approved":
                entries.append(
                    TicketTimelineEntry(
                        id=f"payment-{payment.id}-approved",
                        kind="payment_approved",
                        at=payment.approved_at or payment.created_at,
                        title="Pago aprobado",
                        detail="El cobro quedó conciliado con esta boleta.",
                        amount_cents=payment.amount_in_cents,
                        status="approved",
                        channel="online",
                    )
                )
            elif payment.status == "paid_unfulfilled":
                entries.append(
                    TicketTimelineEntry(
                        id=f"payment-{payment.id}-review",
                        kind="payment_review",
                        at=payment.approved_at or payment.created_at,
                        title="Pago aprobado sin boleta",
                        detail=payment.fulfillment_error
                        or "El cobro se aprobó pero la emisión no se completó.",
                        amount_cents=payment.amount_in_cents,
                        status="paid_unfulfilled",
                        channel="online",
                    )
                )
            elif payment.status in ("declined", "voided", "expired"):
                entries.append(
                    TicketTimelineEntry(
                        id=f"payment-{payment.id}-closed",
                        kind="payment_closed",
                        at=payment.created_at,
                        title={
                            "declined": "Pago rechazado",
                            "voided": "Cobro anulado",
                            "expired": "Cobro expirado",
                        }[payment.status],
                        detail="Este cobro no emitió una boleta.",
                        amount_cents=payment.amount_in_cents,
                        status=payment.status,
                        channel="online",
                    )
                )

        await cur.execute(
            """
            SELECT r.id, r.created_at, r.reason, u.full_name AS actor_name
              FROM ticket_reissues r
              LEFT JOIN users u ON u.id = r.reissued_by_user_id
             WHERE r.ticket_id=%s
             ORDER BY r.created_at, r.id
            """,
            (ticket_id,),
        )
        for row in await cur.fetchall():
            entries.append(
                TicketTimelineEntry(
                    id=f"reissue-{row['id']}",
                    kind="reissued",
                    at=row["created_at"],
                    title="QR reemitido",
                    detail=(
                        "Se generó un QR nuevo y el anterior dejó de funcionar."
                        + (f" Motivo: {row['reason']}" if row["reason"] else "")
                    ),
                    actor_name=row["actor_name"],
                    status="issued",
                    channel="reissue",
                )
            )

        await cur.execute(
            """
            SELECT ce.id, ce.created_at, ce.old_name, ce.new_name,
                   ce.old_phone, ce.new_phone, ce.reason,
                   u.full_name AS actor_name
              FROM ticket_contact_edits ce
              LEFT JOIN users u ON u.id = ce.edited_by_user_id
             WHERE ce.ticket_id=%s
             ORDER BY ce.created_at, ce.id
            """,
            (ticket_id,),
        )
        for row in await cur.fetchall():
            changes = []
            if row["old_name"] != row["new_name"]:
                changes.append(f"nombre: {row['old_name']} → {row['new_name']}")
            if row["old_phone"] != row["new_phone"]:
                changes.append(
                    f"teléfono: {row['old_phone'] or 'sin dato'} → "
                    f"{row['new_phone'] or 'sin dato'}"
                )
            entries.append(
                TicketTimelineEntry(
                    id=f"contact-{row['id']}",
                    kind="contact_updated",
                    at=row["created_at"],
                    title="Contacto corregido",
                    detail="; ".join(changes)
                    + (f" · Motivo: {row['reason']}" if row["reason"] else ""),
                    actor_name=row["actor_name"],
                    channel="contact",
                )
            )

        await cur.execute(
            """
            SELECT r.id, r.scanned_at, r.outcome, r.door_id,
                   u.full_name AS actor_name
              FROM redemptions r
              LEFT JOIN users u ON u.id = r.scanned_by_user_id
             WHERE r.ticket_id=%s
             ORDER BY r.scanned_at, r.id
            """,
            (ticket_id,),
        )
        scan_copy = {
            "granted": ("Ingreso registrado", "Entrada válida."),
            "granted_forced": (
                "Ingreso autorizado",
                "Administración permitió el ingreso fuera de la ventana del QR.",
            ),
            "already_redeemed": (
                "Segundo escaneo",
                "El QR ya había sido usado; no sumó otro ingreso.",
            ),
            "wrong_type": (
                "QR rechazado por acceso",
                "La boleta es de otra localidad; no se consumió.",
            ),
            "not_active": ("QR rechazado", "El QR aún no estaba activo."),
            "under_age": ("QR rechazado", "No cumple la edad mínima del evento."),
            "not_found": ("QR no encontrado", "El código no corresponde a una boleta."),
            "not_valid": (
                "QR rechazado",
                "La boleta está anulada o reembolsada; no se consumió.",
            ),
            "invalid_event": (
                "QR de otro evento",
                "La boleta pertenece a un evento distinto.",
            ),
            "event_not_live": (
                "Evento no abierto",
                "El evento no estaba en venta ni en puerta al escanear.",
            ),
            "capacity_reached": (
                "Aforo completo",
                "El recinto llegó a su capacidad; la boleta no se consumió.",
            ),
        }
        for row in await cur.fetchall():
            # El procedimiento guarda el outcome en minúsculas; normalizar
            # evita que una variante histórica se muestre como "no reconocido".
            outcome = str(row["outcome"]).lower()
            title, detail = scan_copy.get(
                outcome, ("Intento de escaneo", "Resultado no reconocido.")
            )
            entries.append(
                TicketTimelineEntry(
                    id=f"scan-{row['id']}",
                    kind=(
                        "scan_granted"
                        if outcome in ("granted", "granted_forced")
                        else "scan_duplicate"
                        if outcome == "already_redeemed"
                        else "scan_rejected"
                    ),
                    at=row["scanned_at"],
                    title=title,
                    detail=detail + (f" Puerta: {row['door_id']}." if row["door_id"] else ""),
                    actor_name=row["actor_name"],
                    status=outcome,
                    channel=row["door_id"] or "door",
                )
            )

        await cur.execute(
            """
            SELECT tr.id, tr.created_at, u.full_name AS actor_name
              FROM ticket_returns tr
              LEFT JOIN users u ON u.id = tr.returned_by_user_id
             WHERE tr.ticket_id=%s
             ORDER BY tr.created_at, tr.id
            """,
            (ticket_id,),
        )
        for row in await cur.fetchall():
            entries.append(
                TicketTimelineEntry(
                    id=f"return-{row['id']}",
                    kind="returned",
                    at=row["created_at"],
                    title="Boleta devuelta",
                    detail="El QR anterior quedó invalidado y el cupo volvió al evento.",
                    actor_name=row["actor_name"],
                    channel="return",
                )
            )

        await cur.execute(
            """
            SELECT rf.id, rf.created_at, rf.amount_in_cents, rf.reason,
                   u.full_name AS actor_name
              FROM ticket_refunds rf
              LEFT JOIN users u ON u.id = rf.refunded_by_user_id
             WHERE rf.ticket_id=%s
             ORDER BY rf.created_at, rf.id
            """,
            (ticket_id,),
        )
        for row in await cur.fetchall():
            entries.append(
                TicketTimelineEntry(
                    id=f"refund-{row['id']}",
                    kind="refunded",
                    at=row["created_at"],
                    title="Reembolso registrado",
                    detail=row["reason"] or "Sin motivo registrado.",
                    actor_name=row["actor_name"],
                    amount_cents=row["amount_in_cents"],
                    channel="refund",
                )
            )

        await cur.execute(
            """
            SELECT i.id, i.created_at, i.status, i.reason, i.note,
                   i.resolution_guidance, i.resolved_at,
                   u.full_name AS actor_name
              FROM door_incidents i
              LEFT JOIN users u ON u.id = i.created_by
             WHERE i.ticket_id=%s
             ORDER BY i.created_at, i.id
            """,
            (ticket_id,),
        )
        for row in await cur.fetchall():
            entries.append(
                TicketTimelineEntry(
                    id=f"incident-{row['id']}",
                    kind="incident",
                    at=row["created_at"],
                    title="Incidencia en puerta",
                    detail=" · ".join(
                        part for part in (row["reason"], row["note"]) if part
                    ),
                    actor_name=row["actor_name"],
                    status=row["status"],
                    channel="incident",
                )
            )
            if row["resolved_at"]:
                entries.append(
                    TicketTimelineEntry(
                        id=f"incident-{row['id']}-resolved",
                        kind="incident_resolved",
                        at=row["resolved_at"],
                        title="Incidencia resuelta",
                        detail=row["resolution_guidance"]
                        or "Administración cerró la incidencia.",
                        status="resolved",
                        channel="incident",
                    )
                )

        await cur.execute(
            """
            SELECT c.id, c.created_at, c.body, c.author_role,
                   u.full_name AS actor_name
              FROM door_incident_comments c
              JOIN door_incidents i ON i.id = c.incident_id
              JOIN users u ON u.id = c.author_id
             WHERE i.ticket_id=%s
             ORDER BY c.created_at, c.id
            """,
            (ticket_id,),
        )
        for row in await cur.fetchall():
            entries.append(
                TicketTimelineEntry(
                    id=f"incident-comment-{row['id']}",
                    kind="incident_comment",
                    at=row["created_at"],
                    title="Comentario de la incidencia",
                    detail=row["body"],
                    actor_name=row["actor_name"],
                    actor_role=row["author_role"],
                    channel="incident",
                )
            )

        await cur.execute(
            """
            SELECT a.id, a.created_at, a.details, u.full_name AS actor_name
              FROM audit_log a
              LEFT JOIN users u ON u.id = a.actor_id
             WHERE a.entity='ticket' AND a.entity_id=%s
               AND a.kind='ticket_voided'
             ORDER BY a.created_at, a.id
            """,
            (ticket_id,),
        )
        void_rows = await cur.fetchall()
        for row in void_rows:
            entries.append(
                TicketTimelineEntry(
                    id=f"void-{row['id']}",
                    kind="voided",
                    at=row["created_at"],
                    title="Boleta anulada",
                    detail=(row["details"] or {}).get("reason")
                    or "Sin motivo registrado.",
                    actor_name=row["actor_name"],
                    status="voided",
                    channel="void",
                )
            )
        if ticket["voided_at"] and not void_rows:
            entries.append(
                TicketTimelineEntry(
                    id=f"ticket-{ticket_id}-voided",
                    kind="voided",
                    at=ticket["voided_at"],
                    title="Boleta anulada",
                    detail="Anulación anterior al registro de auditoría.",
                    status="voided",
                    channel="void",
                )
            )

    entries.sort(key=lambda e: (e.at, e.id))
    return TicketOperationalHistoryOut(
        ticket_id=ticket["id"],
        event_id=ticket["event_id"],
        ticket_type=ticket["type_name"],
        status=ticket["status"],
        issued_at=ticket["issued_at"],
        redeemed_at=ticket["redeemed_at"],
        redeemed_by_name=ticket["redeemed_by_name"],
        customer_name=ticket["customer_name"],
        customer_phone=ticket["customer_phone"],
        customer_email=ticket["customer_email"],
        price_cents=ticket["price_cents_snapshot"] or 0,
        payment_method=ticket["payment_method"],
        sale_channel=ticket["sale_channel"],
        payment=payment,
        timeline=entries,
        viewer_role="admin" if is_staff else "promotor",
        can_reissue=ticket["status"] == "issued",
        can_refund=is_staff and ticket["status"] == "issued",
        can_void=is_staff and ticket["status"] == "issued",
        can_retry_fulfillment=bool(
            is_staff and payment and payment.status == "paid_unfulfilled"
        ),
    )


@router.post("/events/{event_id}/redeem", response_model=RedeemOut)
async def redeem(
    venue_id: int,
    event_id: int,
    body: TicketRedeemRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    x_door_device: Annotated[str | None, Header(alias="X-Door-Device")] = None,
):
    ensure_roles(user, venue_id, "super_admin", "admin", "bouncer")
    roles = user["roles"].get(venue_id, [])

    # Turno de esta noche (event_staff). Si a esta persona se le fijó una
    # ventana, la puerta solo acepta escaneos dentro de ella: el bouncer de las
    # 22:00 no sigue abriendo a las 4:00 con el mismo link. Sin fila en el
    # roster, o con la fila sin turno, NO hay restricción — la ausencia de dato
    # no cierra puertas (la mayoría del staff no tiene turno definido).
    # Admin/super_admin quedan exentos: son quienes cubren huecos de último
    # minuto y no viven en el roster como bouncer.
    if not any(r in ("super_admin", "admin") for r in roles):
        async with db.cursor() as cur:
            await cur.execute(
                """
                SELECT (COALESCE(shift_start <= now(), true)
                        AND COALESCE(now() <= shift_end, true)) AS dentro
                FROM event_staff WHERE event_id = %s AND user_id = %s
                """,
                (event_id, user["id"]),
            )
            shift = await cur.fetchone()
        if shift and not shift["dentro"]:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Estás fuera de tu turno para esta noche. Si tenés que seguir "
                "en puerta, pedile al admin que lo ajuste.",
            )

    # Autorización del teléfono (mig 064). El bouncer no puede escanear con
    # cualquier sesión: el puesto y el ticket type salen del dispositivo, no
    # del cuerpo del request. Administración sigue exenta para cubrir huecos.
    async with db.cursor() as cur_auth:
        device = await authorize_door_device(
            cur_auth,
            event_id=event_id,
            venue_id=venue_id,
            user=user,
            raw_token=x_door_device,
        )
    effective_type = device["ticket_type_id"] if device else body.ticket_type_id
    effective_door = (device["door_name"] if device else None) or body.door_id

    # Rate limit de puerta (mig 019): cada redeem escribe en redemptions, así
    # que el límite se calcula con lo que ya hay. 40 escaneos / 10 s por
    # usuario (4/s) está muy por encima del ritmo humano de una fila y muy
    # por debajo de una máquina probando tokens. El token de 192 bits ya hace
    # inviable la fuerza bruta: esto solo frena spam y desbordes de log.
    async with db.cursor() as cur:
        await cur.execute(
            """SELECT count(*)::int AS n FROM redemptions
               WHERE scanned_by_user_id = %s
                 AND scanned_at > now() - INTERVAL '10 seconds'""",
            (user["id"],),
        )
        if (await cur.fetchone())["n"] >= 40:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Demasiados escaneos en poco tiempo. Espera unos segundos.",
            )

    # `force` (mig 013): solo staff, nunca el escáner automático del bouncer.
    if body.force:
        ensure_roles(user, venue_id, "super_admin", "admin")

    async with db.cursor() as cur:
        try:
            await cur.execute(
                "SELECT redeem_ticket(%s, %s, %s, %s, %s, %s)",
                (event_id, body.raw_token, user["id"], effective_type,
                 None, effective_door),
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
                # Esta rama SOLO corre si redeem_ticket dijo NOT_ACTIVE
                # (ventana CERRADA). La consulta pregunta si la ventana ya
                # abrio: si abrio (ok=True) ya no corresponde forzar - el
                # canje debe volver a pasar por la logica normal. Antes la
                # condicion estaba invertida (pedia ok=True para forzar):
                # era imposible y el "forzar ingreso" de mig 013 nunca
                # funciono (codigo muerto).
                forced = not (await cur.fetchone())["ok"]
                if forced:
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
            def fmt(d):
                return d.astimezone(tz).strftime("%H:%M")

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
                out.ticket_type = info["type_name"]
                out.detail = f"Boleta de {info['type_name']}"
                if device and device["door_name"]:
                    out.detail += f" · este acceso es {device['door_name']}"
    if code == "ALREADY_REDEEMED":
        # La discusión clásica de puerta ("¿ya la usé?") se resuelve con el
        # NOMBRE y la HORA del primer canje, no con un "presentada antes" seco.
        # El ticket guarda redeemed_at; la hora se muestra en la zona del
        # evento (misma regla que NOT_ACTIVE: "vuelve a las 22:00", no UTC).
        async with db.cursor() as cur2:
            await cur2.execute(
                """
                SELECT t.id, t.customer_name, t.redeemed_at,
                       e.event_timezone, tt.name AS type_name
                FROM tickets t
                JOIN events e ON e.id = t.event_id
                LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
                WHERE t.event_id=%s
                  AND t.token_hash = encode(digest(%s, 'sha256'), 'hex')
                """,
                (event_id, body.raw_token),
            )
            info = await cur2.fetchone()
        if info:
            out.ticket_id = info["id"]
            out.customer_name = info["customer_name"]
            out.ticket_type = info["type_name"]
            if info["redeemed_at"]:
                try:
                    tz = ZoneInfo(info["event_timezone"])
                except Exception:
                    tz = ZoneInfo("UTC")
                when = info["redeemed_at"].astimezone(tz).strftime("%H:%M")
                out.detail = f"Ya entró a las {when}"
            else:
                out.detail = "Ya presentada anteriormente"
    if code == "UNDER_AGE":
        # Edad mínima (mig 051): la boleta es válida, pero su dueño no cumple
        # la restricción del evento. No se consumió. Se muestra el nombre y la
        # edad mínima para que el bouncer lo resuelva en la puerta.
        async with db.cursor() as cur2:
            await cur2.execute(
                """
                SELECT t.id, t.customer_name, e.min_age
                FROM tickets t JOIN events e ON e.id = t.event_id
                WHERE t.event_id=%s
                  AND t.token_hash = encode(digest(%s, 'sha256'), 'hex')
                """,
                (event_id, body.raw_token),
            )
            info = await cur2.fetchone()
        if info:
            out.ticket_id = info["id"]
            out.customer_name = info["customer_name"]
            out.detail = f"Evento para {info['min_age']}+: no puede entrar"
    if code == "GRANTED":
        async with db.cursor() as cur2:
            await cur2.execute(
                """
                SELECT t.id, t.customer_name, tt.name AS type_name
                FROM tickets t
                LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
                WHERE t.event_id=%s AND t.status='redeemed'
                  AND t.token_hash = encode(digest(%s, 'sha256'), 'hex')
                """,
                (event_id, body.raw_token),
            )
            info = await cur2.fetchone()
            if info:
                out.ticket_id = info["id"]
                out.customer_name = info["customer_name"]
                out.ticket_type = info["type_name"]
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


@router.patch(
    "/events/{event_id}/tickets/{ticket_id}/contact",
    response_model=TicketContactEditResponse,
)
async def edit_ticket_contact(
    venue_id: int,
    event_id: int,
    ticket_id: int,
    body: TicketContactEditRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Corrige nombre y/o teléfono del asistente de una boleta vigente.

    El error más común del flujo de emisión: el promotor digitó mal el teléfono
    y el WhatsApp del QR nunca llegó. Antes la única salida era anular +
    reemitir (fricción doble); ahora se corrige al vuelo, con auditoría completa
    en la DB (mig 015: quién, cuándo, valores anteriores).

    Permisos espejo de reissue: el promotor corrige SOLO sus boletas; el staff
    (super_admin/admin) cualquiera del evento. El motivo es opcional y queda en
    la auditoría.
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

        # Espejo del reissue: un promotor no puede tocar boletas ajenas (podría
        # redirigir el QR de un invitado de otro promotor).
        roles = user["roles"].get(venue_id, [])
        is_staff = any(r in ("super_admin", "admin") for r in roles)
        if not is_staff and row["sold_by_user_id"] != user["id"]:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Solo puedes corregir tus propias boletas"
            )

        try:
            await cur.execute(
                "SELECT correct_ticket_contact(%s, %s, %s, %s, %s)",
                (ticket_id, body.customer_name, body.customer_phone, user["id"], body.reason),
            )
            await db.commit()
        except psycopg.errors.Error as e:
            _handle(venue_id, e)

        await cur.execute(
            "SELECT id, customer_name, customer_phone, status::text AS status FROM tickets WHERE id = %s",
            (ticket_id,),
        )
        info = await cur.fetchone()

    return TicketContactEditResponse(
        ticket_id=info["id"],
        customer_name=info["customer_name"],
        customer_phone=info["customer_phone"],
        status=info["status"],
    )


@router.get(
    "/events/{event_id}/tickets/{ticket_id}/contact-edits",
    response_model=list[TicketContactEditOut],
)
async def list_ticket_contact_edits(
    venue_id: int,
    event_id: int,
    ticket_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Auditoría de correcciones de contacto de una boleta (mig 015).

    Misma política que el PATCH: el promotor ve el historial de SUS boletas y
    el staff el de cualquiera del evento. Sirve para responder "quién cambió
    el teléfono y cuándo" sin abrir la DB.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")

    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT t.sold_by_user_id
              FROM tickets t
              JOIN events e ON e.id = t.event_id
             WHERE t.id = %s AND t.event_id = %s AND e.venue_id = %s
            """,
            (ticket_id, event_id, venue_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Boleta no encontrada")

        roles = user["roles"].get(venue_id, [])
        is_staff = any(r in ("super_admin", "admin") for r in roles)
        if not is_staff and row["sold_by_user_id"] != user["id"]:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Solo puedes ver el historial de tus propias boletas"
            )

        await cur.execute(
            """
            SELECT ce.id, ce.old_name, ce.new_name, ce.old_phone, ce.new_phone,
                   ce.reason, ce.created_at, u.full_name AS edited_by_name
              FROM ticket_contact_edits ce
              LEFT JOIN users u ON u.id = ce.edited_by_user_id
             WHERE ce.ticket_id = %s
             ORDER BY ce.created_at DESC, ce.id DESC
            """,
            (ticket_id,),
        )
        rows = await cur.fetchall()

    return rows


@router.post(
    "/events/{event_id}/tickets/{ticket_id}/return",
    response_model=TicketReturnOut,
)
async def return_ticket_staff(
    venue_id: int,
    event_id: int,
    ticket_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Devolucion de una boleta por parte del staff (mig 021).

    Caso real: el invitado escribe "no puedo ir" por WhatsApp en vez de usar
    el boton de su enlace. El promotor (dueno de la boleta) o el admin lo
    registra aqui para liberar el cupo YA, con la misma auditoria y la misma
    ventana limite que la devolucion del invitado.

    Es la contraparte autenticada de POST /tickets/return (publico): misma
    funcion SQL, sin hash esperado — la credencial aqui es el rol.
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

        # Espejo de reissue/contact: un promotor solo devuelve SUS boletas.
        roles = user["roles"].get(venue_id, [])
        is_staff = any(r in ("super_admin", "admin") for r in roles)
        if not is_staff and row["sold_by_user_id"] != user["id"]:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Solo puedes devolver tus propias boletas"
            )

        try:
            await cur.execute(
                "SELECT return_ticket(%s, NULL, %s)",
                (ticket_id, user["id"]),
            )
            await db.commit()
        except psycopg.errors.Error as e:
            _handle(venue_id, e)

    return TicketReturnOut(ticket_id=ticket_id, status="returned")


# ---------------------------------------------------------------------------
# Snapshot de puerta: hashes de las boletas vivas del evento
# ---------------------------------------------------------------------------


@router.get("/events/{event_id}/door-snapshot", response_model=DoorSnapshotOut)
async def door_snapshot(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    x_door_device: Annotated[str | None, Header(alias="X-Door-Device")] = None,
):
    """Lista de validación para la puerta SIN red.

    Solo boletas vivas (`issued`; las `redeemed` no: contra el snapshot no se
    puede distinguir "ya entró" de "entró en otro teléfono" y esa decisión
    la toma el sync). Solo staff de puerta. Es un export de datos personales
    (nombre por boleta): mismo tratamiento de auditoría que invitados.csv.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "bouncer")

    # La puerta también cierra lo vencido (app/core/lifecycle.py): es la
    # pantalla que el bouncer abre antes de la fiesta, sin pasar por el panel.
    await auto_close_expired(db, context="door_snapshot")
    async with db.cursor() as cur_auth:
        await authorize_door_device(
            cur_auth,
            event_id=event_id,
            venue_id=venue_id,
            user=user,
            raw_token=x_door_device,
        )

    async with db.cursor() as cur:
        await cur.execute(
            """SELECT id, name, status FROM events
               WHERE id=%s AND venue_id=%s""",
            (event_id, venue_id),
        )
        ev = await cur.fetchone()
        if not ev:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Evento no encontrado")

        await cur.execute(
            """
            SELECT t.token_hash AS h, t.status::text AS s,
                   t.ticket_type_id AS t, t.customer_name AS n
            FROM tickets t
            WHERE t.event_id = %s AND t.status = 'issued'
            ORDER BY t.id
            """,
            (event_id,),
        )
        rows = await cur.fetchall()

    entries = [
        DoorSnapshotEntry(h=r["h"], s=r["s"], t=r["t"], n=r["n"]) for r in rows
    ]
    return DoorSnapshotOut(
        event_id=event_id,
        generated_at=datetime.now(timezone.utc),
        count=len(entries),
        live_event=(ev["status"] == "live"),
        entries=entries,
    )


# ---------------------------------------------------------------------------
# Sync de la cola offline: la DB re-evalúa cada token
# ---------------------------------------------------------------------------


@router.post("/events/{event_id}/door-sync", response_model=DoorSyncOut)
async def door_sync(
    venue_id: int,
    event_id: int,
    body: list[DoorSyncItem],
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    x_door_device: Annotated[str | None, Header(alias="X-Door-Device")] = None,
):
    """Reconcilia las redenciones que el bouncer hizo sin red.

    Cada token pasa por `redeem_ticket` COMO SI FUERA AHORA: si la boleta fue
    anulada o ya canjeada mientras el teléfono estaba offline, la DB lo dice
    y el resultado refleja la verdad final (granted / already_redeemed /
    rejected).

    Idempotencia (mig 034): cada item trae un `scan_id` que el teléfono generó
    al escanear. Si el sync se reintenta (corte de red, la app se cierra a
    medias), el scan_id ya visto devuelve su resultado SIN volver a canjear:
    el reintento deja de falsear el conteo de la puerta. `scanned_at` es la
    hora real del escaneo, saneada en SQL.

    La respuesta trae `results` en el MISMO orden que la entrada: el cliente
    borra de IndexedDB solo lo que el server confirmó.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "bouncer")
    # La misma válvula anti-spam del redeem en línea: una cola offline nunca
    # debería traer más de lo que una fila humana generó, pero el límite
    # protege el log de redemptions de un cliente desbocado.
    if len(body) > 200:
        # 413 literal: ver media.py — el nombre nuevo de Starlette no existe
        # en todas las versiones soportadas y el viejo está deprecado.
        raise HTTPException(
            413,
            "Demasiados escaneos en una sola sincronización (máx 200)",
        )

    async with db.cursor() as cur_auth:
        device = await authorize_door_device(
            cur_auth,
            event_id=event_id,
            venue_id=venue_id,
            user=user,
            raw_token=x_door_device,
        )
    effective_type = device["ticket_type_id"] if device else None
    effective_door = device["door_name"] if device else None

    granted = already = rejected = 0
    results: list[DoorSyncResult] = []
    async with db.cursor() as cur:
        for item in body:
            # 1) ¿Ya procesamos este scan_id? Devolver el recibo, sin canjear.
            if item.scan_id:
                try:
                    await cur.execute(
                        "SELECT outcome FROM door_sync_receipts "
                        "WHERE event_id = %s AND scan_id = %s",
                        (event_id, item.scan_id),
                    )
                    prev = await cur.fetchone()
                except psycopg.errors.Error:
                    # Un scan_id malformado (no uuid) no debe tumbar la cola:
                    # se sigue como si no hubiera recibo.
                    await db.rollback()
                    prev = None
                if prev:
                    code = prev["outcome"] if isinstance(prev, dict) else prev[0]
                    results.append(DoorSyncResult(scan_id=item.scan_id, code=code))
                    if code == "GRANTED":
                        granted += 1
                    elif code == "ALREADY_REDEEMED":
                        already += 1
                    else:
                        rejected += 1
                    continue

            # 2) Canje real. La hora del escaneo viaja al SQL (saneada ahí).
            try:
                await cur.execute(
                    "SELECT redeem_ticket(%s, %s, %s, %s, %s, %s)",
                    (
                        event_id,
                        item.raw_token,
                        user["id"],
                        effective_type if effective_type is not None else item.ticket_type_id,
                        item.scanned_at,
                        effective_door or item.door_id,
                    ),
                )
                row = await cur.fetchone()
                code = row["redeem_ticket"] if isinstance(row, dict) else row[0]
            except psycopg.errors.Error:
                # Un token problemático no tira la cola entera: se cuenta como
                # rechazado y se sigue con el resto.
                await db.rollback()
                code = "INVALID"
                results.append(DoorSyncResult(scan_id=item.scan_id, code=code))
                rejected += 1
                continue

            # 3) Dejar el recibo para que un reintento sea no-op.
            if item.scan_id:
                try:
                    await cur.execute(
                        "INSERT INTO door_sync_receipts (event_id, scan_id, outcome) "
                        "VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                        (event_id, item.scan_id, code),
                    )
                except psycopg.errors.Error:
                    # El recibo es una optimización: si falla (scan_id no uuid),
                    # el canje ya ocurrió y la respuesta sigue siendo válida.
                    await db.rollback()

            results.append(DoorSyncResult(scan_id=item.scan_id, code=code))
            if code == "GRANTED":
                granted += 1
            elif code == "ALREADY_REDEEMED":
                already += 1
            else:
                rejected += 1

    await db.commit()
    return DoorSyncOut(
        processed=len(body),
        granted=granted,
        already_redeemed=already,
        rejected=rejected,
        results=results,
    )