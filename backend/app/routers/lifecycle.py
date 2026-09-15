"""Ciclo de vida del evento (publish/live/end/cancel), anulacion de boletas
y listado de usuarios de la venue (para asignar cupos con nombres reales)."""
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    CreateVenueUser,
    EventOut,
    MessageOut,
    TicketOut,
    VenueUserOut,
    VoidRequest,
)

router = APIRouter(prefix="/venues/{venue_id}", tags=["ciclo de vida"])

VALID_TRANSITIONS = {
    "publish": ("draft", "published"),
    "live": ("published", "live"),
    "end": ("live", "ended"),
    "cancel": ("draft", "cancelled"),
}


def _error_to_http(e: psycopg.errors.Error) -> HTTPException:
    diag = getattr(e, "diag", None)
    primary = getattr(diag, "message_primary", "") or str(e)
    if "invalid_transition" in primary:
        return HTTPException(409, "El evento no está en el estado esperado para esa transición")
    if "ticket_not_found" in primary:
        return HTTPException(404, "Boleta no encontrada")
    if "cannot_void_redeemed" in primary:
        return HTTPException(409, "No se puede anular una boleta ya redimida")
    if "event_closed" in primary or "cannot_void_ticket" in primary:
        return HTTPException(409, "La boleta no puede anularse en este estado")
    return HTTPException(500, "Error interno")


async def _transition(venue_id, event_id, user, db, action):
    """Ejecuta set_event_status(...) dentro de la transición válida."""
    ensure_roles(user, venue_id, "super_admin", "admin")
    if venue_id not in user["venue_ids"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No perteneces a esta venue")
    p_from, p_to = VALID_TRANSITIONS[action]

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")
        try:
            await cur.execute("SELECT set_event_status(%s, %s, %s)", (event_id, p_from, p_to))
        except psycopg.errors.Error as e:
            raise _error_to_http(e)
        await cur.execute(
            "SELECT id, venue_id, name, starts_at, capacity, status "
            "FROM events WHERE id=%s",
            (event_id,),
        )
        out = await cur.fetchone()
        await db.commit()
    return out


@router.post("/events/{event_id}/publish", response_model=EventOut)
async def publish_event(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    return await _transition(venue_id, event_id, user, db, "publish")


@router.post("/events/{event_id}/live", response_model=EventOut)
async def go_live(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    return await _transition(venue_id, event_id, user, db, "live")


@router.post("/events/{event_id}/end", response_model=EventOut)
async def end_event(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    return await _transition(venue_id, event_id, user, db, "end")


@router.post("/events/{event_id}/cancel", response_model=EventOut)
async def cancel_event(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    return await _transition(venue_id, event_id, user, db, "cancel")


# ---------------------------------------------------------------------------
# Anular boleta
# ---------------------------------------------------------------------------
@router.post("/events/{event_id}/tickets/{ticket_id}/void", response_model=MessageOut)
async def void_ticket(
    venue_id: int, event_id: int, ticket_id: int,
    body: VoidRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        # La boleta debe pertenecer a la venue (via evento).
        await cur.execute(
            """
            SELECT t.id FROM tickets t
            JOIN events e ON e.id = t.event_id
            WHERE t.id=%s AND t.event_id=%s AND e.venue_id=%s
            """,
            (ticket_id, event_id, venue_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Boleta no encontrada en este evento")
        try:
            await cur.execute(
                "SELECT void_ticket(%s, %s, %s)", (ticket_id, body.reason, user["id"])
            )
        except psycopg.errors.Error as e:
            raise _error_to_http(e)
        await db.commit()
    return MessageOut(detail="Boleta anulada. El cupo quedó liberado.")


# ---------------------------------------------------------------------------
# Listado de usuarios de la venue (admins asignan cupos con nombres reales)
# ---------------------------------------------------------------------------
@router.get("/users", response_model=list[VenueUserOut])
async def list_users(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    if venue_id not in user["venue_ids"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No perteneces a esta venue")
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT u.id, u.email, u.full_name,
                   array_agg(DISTINCT r.role)::text[] AS roles
            FROM venue_user_roles r
            JOIN users u ON u.id = r.user_id AND u.is_active
            WHERE r.venue_id = %s
            GROUP BY u.id, u.email, u.full_name
            ORDER BY u.full_name
            """,
            (venue_id,),
        )
        rows = await cur.fetchall()
    return rows


# ---------------------------------------------------------------------------
# Alta de personal de la venue (equipo) desde la UI del admin
# ---------------------------------------------------------------------------
@router.post("/users", response_model=VenueUserOut, status_code=status.HTTP_201_CREATED)
async def create_venue_user(
    venue_id: int,
    body: CreateVenueUser,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Crea (o reutiliza) un usuario y le asigna rol en esta venue.

    - Email existente: solo agrega el rol (si ya lo tiene, es idempotente).
    - Email nuevo: crea el usuario con el password dado (hasheado bcrypt).
    - super_admin nunca se asigna desde aqui (es rol de plataforma).
    """
    from app.core.security import hash_password

    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute("SELECT id FROM venues WHERE id=%s", (venue_id,))
        if not await cur.fetchone():
            raise HTTPException(404, "Venue no encontrada")

        await cur.execute(
            "SELECT id FROM users WHERE lower(email)=lower(%s)", (body.email,)
        )
        row = await cur.fetchone()
        if row:
            target_id = row["id"]
        else:
            await cur.execute(
                """
                INSERT INTO users (email, password_hash, full_name)
                VALUES (%s, %s, %s)
                RETURNING id
                """,
                (body.email, hash_password(body.password), body.full_name),
            )
            target_id = (await cur.fetchone())["id"]

        await cur.execute(
            """
            INSERT INTO venue_user_roles (venue_id, user_id, role)
            VALUES (%s, %s, %s)
            ON CONFLICT DO NOTHING
            """,
            (venue_id, target_id, body.role),
        )

        await cur.execute(
            """
            SELECT u.id, u.email, u.full_name,
                   array_agg(DISTINCT r.role)::text[] AS roles
            FROM users u
            JOIN venue_user_roles r ON r.user_id = u.id AND r.venue_id = %s
            WHERE u.id = %s
            GROUP BY u.id, u.email, u.full_name
            """,
            (venue_id, target_id),
        )
        out = await cur.fetchone()
        await db.commit()
    return out


# ---------------------------------------------------------------------------
# Listado de boletas del evento (para revisar y anular desde la UI)
# ---------------------------------------------------------------------------
@router.get("/events/{event_id}/tickets", response_model=list[TicketOut])
async def list_tickets(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")
        await cur.execute(
            """
            SELECT t.id, t.customer_name, t.customer_phone, t.status,
                   t.issued_at, t.price_cents_snapshot,
                   tt.name AS type_name,
                   u.full_name AS sold_by_name,
                   (a.id IS NOT NULL) AS from_allocation
            FROM tickets t
            JOIN ticket_types tt ON tt.id = t.ticket_type_id
            LEFT JOIN users u ON u.id = t.sold_by_user_id
            LEFT JOIN promoter_allocations a ON a.id = t.allocation_id
            WHERE t.event_id = %s
            ORDER BY t.id DESC
            LIMIT 200
            """,
            (event_id,),
        )
        rows = await cur.fetchall()
    return rows
