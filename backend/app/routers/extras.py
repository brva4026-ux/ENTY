"""Suite operativa y comercial de Enty (mig 071).

Un solo módulo para las piezas que rodean la venta: transporte, plano,
recuperación de compras, turnos, check-in, órdenes, equipos, reservas, hitos,
cortesías, documentos, cambios/upgrades, reventa y pronóstico.
"""
import secrets
from datetime import datetime, timezone
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    BookingIn,
    BundleIn,
    CheckinIn,
    CheckoutRecoveryIn,
    CourtesyIn,
    CourtesyReviewIn,
    DocumentIn,
    EquipmentIn,
    EquipmentPatch,
    MapPointIn,
    MessageOut,
    MilestoneIn,
    OpsOrderIn,
    ResaleIn,
    ResaleRequestIn,
    ResaleSellIn,
    ShiftIn,
    TicketChangeIn,
    TransportPointIn,
)

router = APIRouter(tags=["extras"])


async def _event(cur, venue_id: int, event_id: int) -> dict:
    await cur.execute(
        "SELECT id, venue_id, name, status, capacity, starts_at FROM events"
        " WHERE id=%s AND venue_id=%s",
        (event_id, venue_id),
    )
    row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Evento no encontrado")
    return row


async def _venue(cur, venue_id: int) -> None:
    await cur.execute("SELECT id FROM venues WHERE id=%s", (venue_id,))
    if not await cur.fetchone():
        raise HTTPException(404, "Local no encontrado")


# ---------------------------------------------------------------------------
# Transporte y plano
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/transport")
async def list_transport(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "SELECT * FROM event_transport_points WHERE event_id=%s"
            " ORDER BY sort_order, id",
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/transport", status_code=201)
async def create_transport(
    venue_id: int,
    event_id: int,
    body: TransportPointIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            INSERT INTO event_transport_points
                (event_id, venue_id, kind, name, detail, schedule, map_url, sort_order)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
            """,
            (event_id, venue_id, body.kind, body.name, body.detail,
             body.schedule, body.map_url, body.sort_order),
        )
        row = await cur.fetchone()
        await db.commit()
        return row


@router.patch("/venues/{venue_id}/events/{event_id}/transport/{point_id}")
async def update_transport(
    venue_id: int,
    event_id: int,
    point_id: int,
    body: TransportPointIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            UPDATE event_transport_points
               SET kind=%s, name=%s, detail=%s, schedule=%s, map_url=%s,
                   sort_order=%s
             WHERE id=%s AND event_id=%s RETURNING *
            """,
            (body.kind, body.name, body.detail, body.schedule, body.map_url,
             body.sort_order, point_id, event_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Punto de transporte no encontrado")
        await db.commit()
        return row


@router.delete("/venues/{venue_id}/events/{event_id}/transport/{point_id}",
               response_model=MessageOut)
async def delete_transport(
    venue_id: int,
    event_id: int,
    point_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "DELETE FROM event_transport_points WHERE id=%s AND event_id=%s",
            (point_id, event_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Punto de transporte no encontrado")
        await db.commit()
    return MessageOut(detail="Punto eliminado")


@router.get("/venues/{venue_id}/events/{event_id}/map-points")
async def list_map_points(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "SELECT * FROM event_map_points WHERE event_id=%s"
            " ORDER BY sort_order, id",
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/map-points", status_code=201)
async def create_map_point(
    venue_id: int,
    event_id: int,
    body: MapPointIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            INSERT INTO event_map_points
                (event_id, venue_id, kind, name, description, accessible, sort_order)
            VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *
            """,
            (event_id, venue_id, body.kind, body.name, body.description,
             body.accessible, body.sort_order),
        )
        row = await cur.fetchone()
        await db.commit()
        return row


@router.patch("/venues/{venue_id}/events/{event_id}/map-points/{point_id}")
async def update_map_point(
    venue_id: int,
    event_id: int,
    point_id: int,
    body: MapPointIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            UPDATE event_map_points
               SET kind=%s, name=%s, description=%s, accessible=%s,
                   sort_order=%s
             WHERE id=%s AND event_id=%s RETURNING *
            """,
            (body.kind, body.name, body.description, body.accessible,
             body.sort_order, point_id, event_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Punto del plano no encontrado")
        await db.commit()
        return row


@router.delete("/venues/{venue_id}/events/{event_id}/map-points/{point_id}",
               response_model=MessageOut)
async def delete_map_point(
    venue_id: int,
    event_id: int,
    point_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "DELETE FROM event_map_points WHERE id=%s AND event_id=%s",
            (point_id, event_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Punto del plano no encontrado")
        await db.commit()
    return MessageOut(detail="Punto eliminado")


@router.get("/public/events/{event_id}/extras")
async def public_extras(
    event_id: int,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, name, location FROM events"
            " WHERE id=%s AND status IN ('published','live')",
            (event_id,),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")
        await cur.execute(
            "SELECT id, kind, name, detail, schedule, map_url, sort_order"
            " FROM event_transport_points WHERE event_id=%s"
            " ORDER BY sort_order, id",
            (event_id,),
        )
        transport = await cur.fetchall()
        await cur.execute(
            "SELECT id, kind, name, description, accessible, sort_order"
            " FROM event_map_points WHERE event_id=%s ORDER BY sort_order, id",
            (event_id,),
        )
        points = await cur.fetchall()
    return {"transport": transport, "map_points": points}


# ---------------------------------------------------------------------------
# Compra interrumpida
# ---------------------------------------------------------------------------
@router.post("/public/events/{event_id}/recover-checkout", status_code=201)
async def request_checkout_recovery(
    event_id: int,
    body: CheckoutRecoveryIn,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    token = secrets.token_urlsafe(24)
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id FROM events WHERE id=%s AND status IN ('published','live')"
            " AND starts_at > now()",
            (event_id,),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Ese evento no está vendiendo")
        if body.ticket_type_id is not None:
            await cur.execute(
                "SELECT id FROM ticket_types WHERE id=%s AND event_id=%s",
                (body.ticket_type_id, event_id),
            )
            if not await cur.fetchone():
                raise HTTPException(404, "Localidad no encontrada")
        await cur.execute(
            """
            INSERT INTO checkout_recoveries
                (event_id, ticket_type_id, customer_name, customer_phone,
                 customer_email, token, expires_at)
            VALUES (%s,%s,%s,%s,%s,%s, now() + interval '7 days')
            RETURNING id, token
            """,
            (event_id, body.ticket_type_id, body.customer_name,
             body.customer_phone, body.customer_email, token),
        )
        row = await cur.fetchone()
        await db.commit()
    return {
        "id": row["id"],
        "token": row["token"],
        "path": f"/evento/{event_id}?retomar={row['token']}",
        "message": "Enlace listo para retomar la compra.",
    }


@router.get("/public/checkout-recovery/{token}")
async def read_checkout_recovery(
    token: str,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT r.*, e.name AS event_name, e.starts_at,
                   t.name AS type_name, t.price_cents, t.quantity,
                   (SELECT count(*)::int FROM tickets tk
                     WHERE tk.ticket_type_id=t.id
                       AND tk.status NOT IN ('voided','refunded')) AS issued
              FROM checkout_recoveries r
              JOIN events e ON e.id=r.event_id
              LEFT JOIN ticket_types t ON t.id=r.ticket_type_id
             WHERE r.token=%s
            """,
            (token,),
        )
        row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Enlace no encontrado")
    if row["status"] in ("used", "expired") or row["expires_at"] <= datetime.now(timezone.utc):
        raise HTTPException(410, "Ese enlace ya venció o se usó")
    available = (
        row["quantity"] - row["issued"] if row["quantity"] is not None else None
    )
    return {
        "event_id": row["event_id"],
        "event_name": row["event_name"],
        "starts_at": row["starts_at"],
        "ticket_type_id": row["ticket_type_id"],
        "type_name": row["type_name"],
        "price_cents": row["price_cents"],
        "available": available,
        "customer_name": row["customer_name"],
        "customer_phone": row["customer_phone"],
        "customer_email": row["customer_email"],
    }


@router.post("/public/checkout-recovery/{token}/use", response_model=MessageOut)
async def consume_checkout_recovery(
    token: str,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            "UPDATE checkout_recoveries SET status='used', used_at=now()"
            " WHERE token=%s AND status IN ('pending','sent')",
            (token,),
        )
        await db.commit()
    return MessageOut(detail="Compra retomada")


@router.get("/venues/{venue_id}/events/{event_id}/recoveries")
async def list_checkout_recoveries(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT r.*, t.name AS type_name
              FROM checkout_recoveries r
              LEFT JOIN ticket_types t ON t.id=r.ticket_type_id
             WHERE r.event_id=%s ORDER BY r.created_at DESC LIMIT 200
            """,
            (event_id,),
        )
        return await cur.fetchall()


# ---------------------------------------------------------------------------
# Turnos y check-in
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/shifts")
async def list_shifts(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT s.user_id, u.full_name, s.role, s.door_name,
                   s.shift_start, s.shift_end, s.break_start, s.break_end,
                   s.station
              FROM event_staff s JOIN users u ON u.id=s.user_id
             WHERE s.event_id=%s ORDER BY s.shift_start NULLS LAST, u.full_name
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.patch("/venues/{venue_id}/events/{event_id}/shifts/{user_id}")
async def update_shift(
    venue_id: int,
    event_id: int,
    user_id: int,
    body: ShiftIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            UPDATE event_staff
               SET shift_start=%s, shift_end=%s, break_start=%s, break_end=%s,
                   station=%s
             WHERE event_id=%s AND user_id=%s RETURNING user_id
            """,
            (body.shift_start, body.shift_end, body.break_start,
             body.break_end, body.station, event_id, user_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Esa persona no está asignada al evento")
        await db.commit()
    return {"user_id": user_id, "message": "Turno actualizado"}


@router.get("/venues/{venue_id}/events/{event_id}/staff-checkins")
async def list_staff_checkins(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT c.*, u.full_name
              FROM staff_checkins c JOIN users u ON u.id=c.user_id
             WHERE c.event_id=%s ORDER BY c.checked_in_at DESC LIMIT 200
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/staff-checkin", status_code=201)
async def staff_checkin(
    venue_id: int,
    event_id: int,
    body: CheckinIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT id FROM staff_checkins
             WHERE event_id=%s AND user_id=%s AND checked_out_at IS NULL
             ORDER BY id DESC LIMIT 1
            """,
            (event_id, user["id"]),
        )
        if await cur.fetchone():
            raise HTTPException(409, "Ya tienes un ingreso abierto en este evento")
        await cur.execute(
            """
            INSERT INTO staff_checkins (event_id, user_id, note)
            VALUES (%s,%s,%s) RETURNING *
            """,
            (event_id, user["id"], body.note),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.post("/venues/{venue_id}/events/{event_id}/staff-checkins/{checkin_id}/checkout")
async def staff_checkout(
    venue_id: int,
    event_id: int,
    checkin_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    is_admin = any(
        r in ("super_admin", "admin") for r in user["roles"].get(venue_id, [])
    )
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            UPDATE staff_checkins SET checked_out_at=now()
             WHERE id=%s AND event_id=%s AND checked_out_at IS NULL
               AND (user_id=%s OR %s)
            RETURNING id
            """,
            (checkin_id, event_id, user["id"], is_admin),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Ingreso abierto no encontrado")
        await db.commit()
    return {"id": checkin_id, "message": "Salida registrada"}


# ---------------------------------------------------------------------------
# Órdenes operativas
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/ops-orders")
async def list_ops_orders(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT o.*, u.full_name AS created_by_name,
                   coalesce(
                     json_agg(json_build_object(
                       'user_id', a.user_id, 'door_name', a.door_name,
                       'acked_at', a.acked_at
                     )) FILTER (WHERE a.user_id IS NOT NULL),
                     '[]'::json
                   ) AS acks
              FROM ops_orders o
              LEFT JOIN users u ON u.id=o.created_by
              LEFT JOIN ops_order_acks a ON a.order_id=o.id
             WHERE o.event_id=%s
             GROUP BY o.id, u.full_name
             ORDER BY o.created_at DESC LIMIT 200
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/ops-orders", status_code=201)
async def create_ops_order(
    venue_id: int,
    event_id: int,
    body: OpsOrderIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            INSERT INTO ops_orders (event_id, venue_id, message, target, created_by)
            VALUES (%s,%s,%s,%s,%s) RETURNING *
            """,
            (event_id, venue_id, body.message, body.target, user["id"]),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.post("/venues/{venue_id}/events/{event_id}/ops-orders/{order_id}/ack")
async def ack_ops_order(
    venue_id: int,
    event_id: int,
    order_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "SELECT id FROM ops_orders WHERE id=%s AND event_id=%s",
            (order_id, event_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Orden no encontrada")
        await cur.execute(
            """
            INSERT INTO ops_order_acks (order_id, user_id)
            VALUES (%s,%s) ON CONFLICT (order_id, user_id) DO NOTHING
            """,
            (order_id, user["id"]),
        )
        await db.commit()
    return {"order_id": order_id, "message": "Orden confirmada"}


@router.patch("/venues/{venue_id}/events/{event_id}/ops-orders/{order_id}/resolve")
async def resolve_ops_order(
    venue_id: int,
    event_id: int,
    order_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "UPDATE ops_orders SET resolved_at=now()"
            " WHERE id=%s AND event_id=%s RETURNING id",
            (order_id, event_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Orden no encontrada")
        await db.commit()
    return {"order_id": order_id, "message": "Orden resuelta"}


# ---------------------------------------------------------------------------
# Equipos prestados
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/equipment")
async def list_equipment(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT e.*, u.full_name AS responsible_name
              FROM equipment_loans e
              LEFT JOIN users u ON u.id=e.responsible_user_id
             WHERE e.event_id=%s ORDER BY e.status, e.delivered_at DESC
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/equipment", status_code=201)
async def create_equipment(
    venue_id: int,
    event_id: int,
    body: EquipmentIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            INSERT INTO equipment_loans
                (event_id, item_name, serial, responsible_user_id, notes)
            VALUES (%s,%s,%s,%s,%s) RETURNING *
            """,
            (event_id, body.item_name, body.serial,
             body.responsible_user_id, body.notes),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.patch("/venues/{venue_id}/events/{event_id}/equipment/{loan_id}")
async def update_equipment(
    venue_id: int,
    event_id: int,
    loan_id: int,
    body: EquipmentPatch,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            UPDATE equipment_loans
               SET status=COALESCE(%s, status),
                   responsible_user_id=COALESCE(%s, responsible_user_id),
                   notes=COALESCE(%s, notes),
                   returned_at=CASE WHEN %s='devuelto' THEN now()
                                    ELSE returned_at END
             WHERE id=%s AND event_id=%s RETURNING *
            """,
            (body.status, body.responsible_user_id, body.notes,
             body.status, loan_id, event_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Equipo no encontrado")
        await db.commit()
    return row


# ---------------------------------------------------------------------------
# Calendario de reservas del local
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/bookings")
async def list_bookings(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _venue(cur, venue_id)
        await cur.execute(
            """
            SELECT b.*, e.name AS event_name
              FROM venue_bookings b LEFT JOIN events e ON e.id=b.event_id
             WHERE b.venue_id=%s ORDER BY b.starts_at DESC LIMIT 300
            """,
            (venue_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/bookings", status_code=201)
async def create_booking(
    venue_id: int,
    body: BookingIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    if body.ends_at <= body.starts_at:
        raise HTTPException(422, "La reserva debe terminar después de empezar")
    async with db.cursor() as cur:
        await _venue(cur, venue_id)
        await cur.execute(
            """
            SELECT title FROM venue_bookings
             WHERE venue_id=%s AND status <> 'cancelada'
               AND starts_at < %s AND ends_at > %s
             LIMIT 1
            """,
            (venue_id, body.ends_at, body.starts_at),
        )
        clash = await cur.fetchone()
        if clash:
            raise HTTPException(409, f"Se cruza con “{clash['title']}”")
        await cur.execute(
            """
            INSERT INTO venue_bookings
                (venue_id, event_id, title, starts_at, ends_at,
                 setup_starts_at, teardown_ends_at, status, notes, created_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
            """,
            (venue_id, body.event_id, body.title, body.starts_at, body.ends_at,
             body.setup_starts_at, body.teardown_ends_at, body.status,
             body.notes, user["id"]),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.patch("/venues/{venue_id}/bookings/{booking_id}")
async def update_booking(
    venue_id: int,
    booking_id: int,
    body: BookingIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    if body.ends_at <= body.starts_at:
        raise HTTPException(422, "La reserva debe terminar después de empezar")
    async with db.cursor() as cur:
        await _venue(cur, venue_id)
        await cur.execute(
            """
            SELECT title FROM venue_bookings
             WHERE venue_id=%s AND id<>%s AND status <> 'cancelada'
               AND starts_at < %s AND ends_at > %s LIMIT 1
            """,
            (venue_id, booking_id, body.ends_at, body.starts_at),
        )
        clash = await cur.fetchone()
        if clash:
            raise HTTPException(409, f"Se cruza con “{clash['title']}”")
        await cur.execute(
            """
            UPDATE venue_bookings
               SET event_id=%s, title=%s, starts_at=%s, ends_at=%s,
                   setup_starts_at=%s, teardown_ends_at=%s, status=%s, notes=%s
             WHERE id=%s AND venue_id=%s RETURNING *
            """,
            (body.event_id, body.title, body.starts_at, body.ends_at,
             body.setup_starts_at, body.teardown_ends_at, body.status,
             body.notes, booking_id, venue_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Reserva no encontrada")
        await db.commit()
    return row


@router.delete("/venues/{venue_id}/bookings/{booking_id}", response_model=MessageOut)
async def delete_booking(
    venue_id: int,
    booking_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _venue(cur, venue_id)
        await cur.execute(
            "DELETE FROM venue_bookings WHERE id=%s AND venue_id=%s",
            (booking_id, venue_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Reserva no encontrada")
        await db.commit()
    return MessageOut(detail="Reserva eliminada")


# ---------------------------------------------------------------------------
# Hitos de producción
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/milestones")
async def list_milestones(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT m.*, u.full_name AS owner_name
              FROM production_milestones m
              LEFT JOIN users u ON u.id=m.owner_user_id
             WHERE m.event_id=%s ORDER BY m.due_date, m.id
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/milestones", status_code=201)
async def create_milestone(
    venue_id: int,
    event_id: int,
    body: MilestoneIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            INSERT INTO production_milestones
                (event_id, title, due_date, owner_user_id, status, notes)
            VALUES (%s,%s,%s,%s,%s,%s) RETURNING *
            """,
            (event_id, body.title, body.due_date, body.owner_user_id,
             body.status, body.notes),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.patch("/venues/{venue_id}/events/{event_id}/milestones/{milestone_id}")
async def update_milestone(
    venue_id: int,
    event_id: int,
    milestone_id: int,
    body: MilestoneIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            UPDATE production_milestones
               SET title=%s, due_date=%s, owner_user_id=%s, status=%s,
                   notes=%s,
                   completed_at=CASE WHEN %s='hecho' THEN now() ELSE NULL END
             WHERE id=%s AND event_id=%s RETURNING *
            """,
            (body.title, body.due_date, body.owner_user_id, body.status,
             body.notes, body.status, milestone_id, event_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Hito no encontrado")
        await db.commit()
    return row


@router.delete("/venues/{venue_id}/events/{event_id}/milestones/{milestone_id}",
               response_model=MessageOut)
async def delete_milestone(
    venue_id: int,
    event_id: int,
    milestone_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "DELETE FROM production_milestones WHERE id=%s AND event_id=%s",
            (milestone_id, event_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Hito no encontrado")
        await db.commit()
    return MessageOut(detail="Hito eliminado")


# ---------------------------------------------------------------------------
# Cortesías con aprobación
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/courtesy-requests")
async def list_courtesy_requests(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT c.*, t.name AS type_name, u.full_name AS requested_by_name,
                   reviewer.full_name AS reviewed_by_name,
                   CASE WHEN c.ticket_type_id IS NULL THEN NULL ELSE
                     GREATEST(t.quantity - (
                       SELECT count(*) FROM tickets tk
                        WHERE tk.ticket_type_id=t.id
                          AND tk.status NOT IN ('voided','refunded')
                     ) - (
                       SELECT count(*) FROM ticket_payments p
                        WHERE p.ticket_type_id=t.id AND p.status='pending'
                          AND p.reservation_expires_at > now()
                     ), 0)
                   END AS available
              FROM courtesy_requests c
              LEFT JOIN ticket_types t ON t.id=c.ticket_type_id
              LEFT JOIN users u ON u.id=c.requested_by
              LEFT JOIN users reviewer ON reviewer.id=c.reviewed_by
             WHERE c.event_id=%s ORDER BY c.created_at DESC LIMIT 200
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/courtesy-requests",
             status_code=201)
async def create_courtesy_request(
    venue_id: int,
    event_id: int,
    body: CourtesyIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        if body.ticket_type_id is not None:
            await cur.execute(
                "SELECT id FROM ticket_types WHERE id=%s AND event_id=%s",
                (body.ticket_type_id, event_id),
            )
            if not await cur.fetchone():
                raise HTTPException(404, "Localidad no encontrada")
        await cur.execute(
            """
            INSERT INTO courtesy_requests
                (event_id, ticket_type_id, requested_by, quantity, reason)
            VALUES (%s,%s,%s,%s,%s) RETURNING *
            """,
            (event_id, body.ticket_type_id, user["id"], body.quantity,
             body.reason),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.post("/venues/{venue_id}/events/{event_id}/courtesy-requests/{request_id}/review")
async def review_courtesy_request(
    venue_id: int,
    event_id: int,
    request_id: int,
    body: CourtesyReviewIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "SELECT * FROM courtesy_requests WHERE id=%s AND event_id=%s FOR UPDATE",
            (request_id, event_id),
        )
        req = await cur.fetchone()
        if not req:
            raise HTTPException(404, "Solicitud no encontrada")
        if req["status"] != "pendiente":
            raise HTTPException(409, "Esa solicitud ya fue revisada")
        if body.status == "aprobada" and req["ticket_type_id"] is not None:
            await cur.execute(
                """
                SELECT t.quantity - (
                         SELECT count(*) FROM tickets tk
                          WHERE tk.ticket_type_id=t.id
                            AND tk.status NOT IN ('voided','refunded')
                       ) - (
                         SELECT count(*) FROM ticket_payments p
                          WHERE p.ticket_type_id=t.id AND p.status='pending'
                            AND p.reservation_expires_at > now()
                       ) AS available
                  FROM ticket_types t WHERE t.id=%s
                """,
                (req["ticket_type_id"],),
            )
            available = (await cur.fetchone())["available"]
            if available < req["quantity"]:
                raise HTTPException(
                    409,
                    f"Solo quedan {available} cupos en esa localidad. "
                    "Aprobá menos cortesías o ampliá el cupo.",
                )
        await cur.execute(
            """
            UPDATE courtesy_requests
               SET status=%s, reviewed_by=%s, reviewed_at=now(),
                   notes=COALESCE(%s, notes)
             WHERE id=%s RETURNING *
            """,
            (body.status, user["id"], body.notes, request_id),
        )
        row = await cur.fetchone()
        tickets = []
        if body.status == "aprobada" and row["ticket_type_id"] is not None:
            await cur.execute(
                "SELECT full_name FROM users WHERE id=%s", (row["requested_by"],)
            )
            requester = await cur.fetchone()
            label = f"Cortesía · {requester['full_name'] if requester else 'equipo'}"
            try:
                for _ in range(row["quantity"]):
                    raw = secrets.token_urlsafe(24)
                    await cur.execute(
                        "SELECT emit_ticket(%s,%s,NULL,%s,%s,%s,NULL,NULL,NULL,NULL) AS id",
                        (event_id, row["ticket_type_id"], user["id"], label, raw),
                    )
                    ticket_id = (await cur.fetchone())["id"]
                    await cur.execute(
                        "UPDATE tickets SET price_cents_snapshot=0,"
                        " payment_method='cortesia' WHERE id=%s",
                        (ticket_id,),
                    )
                    tickets.append({"id": ticket_id, "raw_token": raw})
            except psycopg.Error as error:
                await db.rollback()
                msg = str(error).splitlines()[0]
                if "ticket_type_sold_out" in msg or "event_at_capacity" in msg:
                    raise HTTPException(409, "El cupo se llenó mientras aprobabas") from error
                raise HTTPException(409, "No pudimos emitir las cortesías") from error
        await db.commit()
    return {**row, "tickets": tickets}


# ---------------------------------------------------------------------------
# Documentación por evento
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/documents")
async def list_documents(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    roles = user["roles"].get(venue_id, [])
    is_admin = any(r in ("super_admin", "admin") for r in roles)
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        cond = "" if is_admin else " AND access_role IN ('equipo','todos')"
        await cur.execute(
            f"""
            SELECT d.*, u.full_name AS owner_name
              FROM event_documents d LEFT JOIN users u ON u.id=d.owner_user_id
             WHERE d.event_id=%s{cond} ORDER BY d.created_at DESC
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/documents", status_code=201)
async def create_document(
    venue_id: int,
    event_id: int,
    body: DocumentIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            INSERT INTO event_documents
                (event_id, title, url, version, access_role, owner_user_id, notes)
            VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *
            """,
            (event_id, body.title, body.url, body.version, body.access_role,
             body.owner_user_id, body.notes),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.patch("/venues/{venue_id}/events/{event_id}/documents/{document_id}")
async def update_document(
    venue_id: int,
    event_id: int,
    document_id: int,
    body: DocumentIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            UPDATE event_documents
               SET title=%s, url=%s, version=%s, access_role=%s,
                   owner_user_id=%s, notes=%s
             WHERE id=%s AND event_id=%s RETURNING *
            """,
            (body.title, body.url, body.version, body.access_role,
             body.owner_user_id, body.notes, document_id, event_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Documento no encontrado")
        await db.commit()
    return row


@router.delete("/venues/{venue_id}/events/{event_id}/documents/{document_id}",
               response_model=MessageOut)
async def delete_document(
    venue_id: int,
    event_id: int,
    document_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "DELETE FROM event_documents WHERE id=%s AND event_id=%s",
            (document_id, event_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Documento no encontrado")
        await db.commit()
    return MessageOut(detail="Documento eliminado")


# ---------------------------------------------------------------------------
# Cambio de función y upgrade de boleta
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/ticket-changes")
async def list_ticket_changes(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT c.*, ot.name AS old_type_name, nt.name AS new_type_name,
                   t.customer_name, t.customer_phone
              FROM ticket_changes c
              LEFT JOIN ticket_types ot ON ot.id=c.old_type_id
              LEFT JOIN ticket_types nt ON nt.id=c.new_type_id
              LEFT JOIN tickets t ON t.id=c.new_ticket_id
             WHERE c.venue_id=%s
               AND (c.event_id=%s OR EXISTS (
                    SELECT 1 FROM tickets x WHERE x.id=c.old_ticket_id
                     AND x.event_id=%s))
             ORDER BY c.created_at DESC LIMIT 200
            """,
            (venue_id, event_id, event_id),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/tickets/{ticket_id}/change")
async def change_ticket(
    venue_id: int,
    event_id: int,
    ticket_id: int,
    body: TicketChangeIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    raw_token = secrets.token_urlsafe(24)
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT t.id, t.status, t.sold_by_user_id, t.price_cents_snapshot,
                   t.ticket_type_id
              FROM tickets t WHERE t.id=%s AND t.event_id=%s
            """,
            (ticket_id, event_id),
        )
        old = await cur.fetchone()
        if not old:
            raise HTTPException(404, "Boleta no encontrada")
        roles = user["roles"].get(venue_id, [])
        if not any(r in ("super_admin", "admin") for r in roles):
            if old["sold_by_user_id"] != user["id"]:
                raise HTTPException(403, "Solo puedes cambiar tus propias boletas")
        await cur.execute(
            """
            SELECT t.id, t.name, t.price_cents, e.name AS event_name
              FROM ticket_types t JOIN events e ON e.id=t.event_id
             WHERE t.id=%s AND e.id=%s AND e.venue_id=%s
            """,
            (body.new_type_id, body.new_event_id, venue_id),
        )
        new_type = await cur.fetchone()
        if not new_type:
            raise HTTPException(404, "La localidad destino no pertenece a este local")
        try:
            await cur.execute(
                "SELECT change_ticket(%s,%s,%s,%s,%s,%s,%s) AS id",
                (ticket_id, body.new_event_id, body.new_type_id, raw_token,
                 user["id"], body.payment_method, body.reason),
            )
            new_id = (await cur.fetchone())["id"]
            await db.commit()
        except psycopg.Error as error:
            await db.rollback()
            msg = str(error).splitlines()[0]
            if "ticket_not_changeable" in msg:
                raise HTTPException(409, "La boleta ya se usó, se anuló o no está vigente") from error
            if "ticket_type_sold_out" in msg:
                raise HTTPException(409, "La localidad destino está agotada") from error
            if "event_at_capacity" in msg:
                raise HTTPException(409, "El evento destino está lleno") from error
            raise HTTPException(409, "No pudimos completar el cambio") from error

        await cur.execute(
            """
            SELECT amount_due_cents, refund_cents, kind
              FROM ticket_changes WHERE new_ticket_id=%s ORDER BY id DESC LIMIT 1
            """,
            (new_id,),
        )
        change = await cur.fetchone()
    return {
        "old_ticket_id": ticket_id,
        "new_ticket_id": new_id,
        "raw_token": raw_token,
        "new_event_id": body.new_event_id,
        "new_event_name": new_type["event_name"],
        "new_type_id": body.new_type_id,
        "new_type_name": new_type["name"],
        "amount_due_cents": change["amount_due_cents"] if change else 0,
        "refund_cents": change["refund_cents"] if change else 0,
        "kind": change["kind"] if change else "cambio",
        "message": "Cambio realizado. El QR anterior quedó anulado.",
    }


# ---------------------------------------------------------------------------
# Reventa oficial
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/resales")
async def list_resales(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT r.*, tt.name AS type_name, t.customer_name AS original_name,
                   t.price_cents_snapshot AS original_price_cents
              FROM ticket_resales r
              JOIN tickets t ON t.id=r.ticket_id
              JOIN ticket_types tt ON tt.id=t.ticket_type_id
             WHERE r.event_id=%s ORDER BY r.created_at DESC
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/resales", status_code=201)
async def create_resale(
    venue_id: int,
    event_id: int,
    body: ResaleIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT t.id, t.status, t.price_cents_snapshot, t.sold_by_user_id
              FROM tickets t WHERE t.id=%s AND t.event_id=%s
            """,
            (body.ticket_id, event_id),
        )
        ticket = await cur.fetchone()
        if not ticket:
            raise HTTPException(404, "Boleta no encontrada")
        if ticket["status"] != "issued":
            raise HTTPException(409, "Solo se puede revender una boleta vigente")
        roles = user["roles"].get(venue_id, [])
        if not any(r in ("super_admin", "admin") for r in roles):
            if ticket["sold_by_user_id"] != user["id"]:
                raise HTTPException(403, "Solo puedes revender tus propias boletas")
        if body.price_cents > ticket["price_cents_snapshot"]:
            raise HTTPException(
                422,
                "El precio de reventa no puede superar el precio original "
                f"({ticket['price_cents_snapshot']} centavos)",
            )
        await cur.execute(
            "SELECT id FROM ticket_resales WHERE ticket_id=%s"
            " AND status IN ('publicada','solicitada')",
            (body.ticket_id,),
        )
        if await cur.fetchone():
            raise HTTPException(409, "Esa boleta ya está publicada para reventa")
        await cur.execute(
            """
            INSERT INTO ticket_resales
                (venue_id, event_id, ticket_id, seller_name, seller_phone,
                 price_cents, created_by, notes)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
            """,
            (venue_id, event_id, body.ticket_id, body.seller_name,
             body.seller_phone, body.price_cents, user["id"], body.notes),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.post("/venues/{venue_id}/events/{event_id}/resales/{resale_id}/sell")
async def sell_resale(
    venue_id: int,
    event_id: int,
    resale_id: int,
    body: ResaleSellIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    raw_token = secrets.token_urlsafe(24)
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "SELECT id FROM ticket_resales WHERE id=%s AND event_id=%s",
            (resale_id, event_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Reventa no encontrada")
        try:
            await cur.execute(
                "SELECT sell_resale(%s,%s,%s,%s,%s,%s,%s) AS id",
                (resale_id, body.buyer_name, body.buyer_phone,
                 body.buyer_email, raw_token, user["id"],
                 body.payment_method),
            )
            new_id = (await cur.fetchone())["id"]
            await db.commit()
        except psycopg.Error as error:
            await db.rollback()
            msg = str(error).splitlines()[0]
            if "ticket_not_changeable" in msg:
                raise HTTPException(409, "La boleta original ya no está vigente") from error
            if "resale_not_available" in msg:
                raise HTTPException(409, "Esa reventa ya se cerró") from error
            raise HTTPException(409, "No pudimos completar la reventa") from error
    return {
        "resale_id": resale_id,
        "new_ticket_id": new_id,
        "raw_token": raw_token,
        "buyer_name": body.buyer_name,
        "message": "Reventa completada. El QR anterior quedó anulado.",
    }


@router.patch("/venues/{venue_id}/events/{event_id}/resales/{resale_id}/cancel",
              response_model=MessageOut)
async def cancel_resale(
    venue_id: int,
    event_id: int,
    resale_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "UPDATE ticket_resales SET status='cancelada'"
            " WHERE id=%s AND event_id=%s AND status IN ('publicada','solicitada')",
            (resale_id, event_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Reventa activa no encontrada")
        await db.commit()
    return MessageOut(detail="Reventa cancelada")


@router.get("/public/events/{event_id}/resales")
async def public_resales(
    event_id: int,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT r.id, r.price_cents, tt.name AS type_name,
                   split_part(coalesce(r.seller_name, t.customer_name, 'Alguien'), ' ', 1)
                     AS seller_first_name,
                   r.created_at
              FROM ticket_resales r
              JOIN tickets t ON t.id=r.ticket_id
              JOIN ticket_types tt ON tt.id=t.ticket_type_id
             WHERE r.event_id=%s AND r.status='publicada'
             ORDER BY r.price_cents, r.id
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/public/resales/{resale_id}/request", response_model=MessageOut)
async def request_resale(
    resale_id: int,
    body: ResaleRequestIn,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            """
            UPDATE ticket_resales
               SET status='solicitada', buyer_name=%s, buyer_phone=%s,
                   buyer_email=%s
             WHERE id=%s AND status='publicada'
            """,
            (body.buyer_name, body.buyer_phone, body.buyer_email, resale_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(409, "Esa reventa ya no está disponible")
        await db.commit()
    return MessageOut(
        message="Solicitud enviada. El organizador confirmará el pago y te "
        "entregará la boleta nueva."
    )


# ---------------------------------------------------------------------------
# Pronóstico de demanda
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/forecast")
async def demand_forecast(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT e.id, e.capacity, e.starts_at, e.created_at, e.category,
                   (SELECT count(*)::int FROM tickets t
                     WHERE t.event_id=e.id
                       AND t.status IN ('issued','redeemed')) AS sold
              FROM events e WHERE e.id=%s AND e.venue_id=%s
            """,
            (event_id, venue_id),
        )
        ev = await cur.fetchone()
        if not ev:
            raise HTTPException(404, "Evento no encontrado")
        await cur.execute(
            """
            SELECT e.id, e.name, e.capacity,
                   count(t.id) FILTER (
                     WHERE t.status IN ('issued','redeemed')
                   )::int AS sold
              FROM events e
              LEFT JOIN tickets t ON t.event_id=e.id
             WHERE e.venue_id=%s AND e.id<>%s
               AND e.status IN ('ended','live')
               AND e.starts_at >= now() - interval '180 days'
               AND e.starts_at < now()
               AND e.category IS NOT DISTINCT FROM %s::text
             GROUP BY e.id
             ORDER BY e.starts_at DESC LIMIT 12
            """,
            (venue_id, event_id, ev["category"]),
        )
        similar = await cur.fetchall()

    now = datetime.now(timezone.utc)
    days_to = max((ev["starts_at"] - now).days, 0)
    days_since = max((now - ev["created_at"]).days, 1)
    pace = ev["sold"] / days_since
    projected = min(ev["capacity"], round(ev["sold"] + pace * days_to))
    pct = round(projected * 100 / ev["capacity"], 1) if ev["capacity"] else 0
    comparable = [
        {
            "id": s["id"],
            "name": s["name"],
            "capacity": s["capacity"],
            "sold": s["sold"],
            "sold_pct": round(s["sold"] * 100 / s["capacity"], 1)
            if s["capacity"] else 0,
        }
        for s in similar
    ]
    avg_pct = (
        sum(c["sold_pct"] for c in comparable) / len(comparable)
        if comparable else pct
    )
    if pct >= 90:
        message = "La proyección está cerca del lleno. Considera subir precio o abrir otra fecha."
    elif pct >= 60:
        message = "Buen ritmo. Refuerza la comunicación en los próximos días."
    else:
        message = "El ritmo es lento para el tiempo que queda. Activa promotores o un cupón."
    return {
        "event_id": event_id,
        "capacity": ev["capacity"],
        "sold": ev["sold"],
        "days_to_event": days_to,
        "daily_pace": round(pace, 2),
        "projected_sold": projected,
        "projected_pct": pct,
        "comparable_events": comparable,
        "comparable_avg_pct": round(avg_pct, 1),
        "message": message,
    }


# ---------------------------------------------------------------------------
# Paquete de varios eventos independientes
# ---------------------------------------------------------------------------
@router.post("/venues/{venue_id}/events/{event_id}/bundle", status_code=201)
async def create_bundle(
    venue_id: int,
    event_id: int,
    body: BundleIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    ids = list(dict.fromkeys(body.event_ids))
    if event_id in ids:
        raise HTTPException(422, "El evento padre no puede ser parte del paquete")
    async with db.cursor() as cur:
        parent = await _event(cur, venue_id, event_id)
        if parent["status"] == "cancelled":
            raise HTTPException(409, "El evento padre está cancelado")
        await cur.execute(
            """
            SELECT id, name, capacity, starts_at
              FROM events
             WHERE id = ANY(%s) AND venue_id=%s AND parent_event_id IS NULL
               AND status IN ('published','live')
             ORDER BY starts_at
            """,
            (ids, venue_id),
        )
        events = await cur.fetchall()
        if len(events) != len(ids):
            raise HTTPException(
                422,
                "Algún evento no existe, no es independiente o no está publicado",
            )
        min_capacity = min(e["capacity"] for e in events)
        if body.quantity > min_capacity:
            raise HTTPException(
                422,
                f"El paquete no puede superar el aforo del evento más chico ({min_capacity})",
            )
        await cur.execute(
            """
            INSERT INTO ticket_types
                (event_id, name, price_cents, quantity, is_courtesy, is_active)
            VALUES (%s,%s,%s,%s,false,true)
            ON CONFLICT (event_id, name) DO UPDATE
               SET price_cents=EXCLUDED.price_cents,
                   quantity=EXCLUDED.quantity, is_active=true
            RETURNING id
            """,
            (event_id, body.name, body.price_cents, body.quantity),
        )
        pass_type_id = (await cur.fetchone())["id"]
        for ev in events:
            await cur.execute(
                """
                INSERT INTO ticket_types
                    (event_id, name, price_cents, quantity, is_courtesy,
                     is_active, is_pass_only)
                VALUES (%s,%s,0,%s,true,true,true)
                ON CONFLICT (event_id, name) DO UPDATE
                   SET is_pass_only=true, is_active=true
                RETURNING id
                """,
                (ev["id"], f"Pase · {ev['name']}", ev["capacity"]),
            )
            session_type_id = (await cur.fetchone())["id"]
            await cur.execute(
                "UPDATE events SET parent_event_id=%s WHERE id=%s",
                (event_id, ev["id"]),
            )
            await cur.execute(
                """
                INSERT INTO pass_sessions
                    (pass_ticket_type_id, session_event_id, session_ticket_type_id)
                VALUES (%s,%s,%s)
                ON CONFLICT (pass_ticket_type_id, session_event_id) DO UPDATE
                   SET session_ticket_type_id=EXCLUDED.session_ticket_type_id
                """,
                (pass_type_id, ev["id"], session_type_id),
            )
        await db.commit()
    return {
        "pass_ticket_type_id": pass_type_id,
        "name": body.name,
        "price_cents": body.price_cents,
        "quantity": body.quantity,
        "events": [
            {"id": e["id"], "name": e["name"], "starts_at": e["starts_at"]}
            for e in events
        ],
        "message": "Paquete creado. Al venderse emite una boleta por evento.",
    }
