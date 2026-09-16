"""CRUD de eventos, tipos de boleta y asignacion de cupos a promotores."""
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    AllocationCreate,
    AllocationOut,
    EventCreate,
    EventOut,
    MessageOut,
    TicketTypeCreate,
    TicketTypeOut,
)

router = APIRouter(prefix="/venues/{venue_id}", tags=["eventos"])

# `issued` = boletas vivas contra el cupo (mismo criterio que emit_ticket:
# anuladas y reembolsadas no consumen). Se calcula aca y no se almacena para
# no tener un contador que se desincronice del estado real de las boletas.
_ALLOC_COLUMNS = """
    a.id, a.event_id, a.ticket_type_id, a.promoter_id, a.capacity, a.is_active,
    (SELECT count(*)::int FROM tickets t
      WHERE t.allocation_id = a.id
        AND t.status NOT IN ('voided', 'refunded')) AS issued
"""


def _event_ctx(venue_id: int, user: dict):
    if venue_id not in user["venue_ids"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No perteneces a esta venue")


# --------------------------------------------------------------------------
# Eventos
# --------------------------------------------------------------------------
@router.get("/events", response_model=list[EventOut])
async def list_events(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    _event_ctx(venue_id, user)
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, venue_id, name, starts_at, capacity, status "
            "FROM events WHERE venue_id=%s ORDER BY starts_at DESC",
            (venue_id,),
        )
        return await cur.fetchall()


@router.post("/events", response_model=EventOut, status_code=status.HTTP_201_CREATED)
async def create_event(
    venue_id: int,
    body: EventCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO events (venue_id, name, description, flyer_url,
                                starts_at, ends_at, event_timezone, capacity, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'draft')
            RETURNING id, venue_id, name, starts_at, capacity, status
            """,
            (venue_id, body.name, body.description, body.flyer_url,
             body.starts_at, body.ends_at, body.event_timezone, body.capacity),
        )
        created = await cur.fetchone()
        await db.commit()
    return created


# --------------------------------------------------------------------------
# Tipos de boleta
# --------------------------------------------------------------------------
@router.get("/events/{event_id}/types", response_model=list[TicketTypeOut])
async def list_types(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    _event_ctx(venue_id, user)
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, event_id, name, price_cents, quantity, is_courtesy "
            "FROM ticket_types WHERE event_id=%s ORDER BY id",
            (event_id,),
        )
        return await cur.fetchall()


@router.post(
    "/events/{event_id}/types", response_model=TicketTypeOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_type(
    venue_id: int,
    event_id: int,
    body: TicketTypeCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")
        await cur.execute(
            """
            INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (event_id, name) DO NOTHING
            RETURNING id, event_id, name, price_cents, quantity, is_courtesy
            """,
            (event_id, body.name, body.price_cents, body.quantity, body.is_courtesy),
        )
        created = await cur.fetchone()
        if not created:
            raise HTTPException(409, "Ya existe un tipo con ese nombre")
        await db.commit()
    return created


# --------------------------------------------------------------------------
# Cupos de promotor
# --------------------------------------------------------------------------
@router.get("/events/{event_id}/allocations", response_model=list[AllocationOut])
async def list_allocations(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    _event_ctx(venue_id, user)
    async with db.cursor() as cur:
        await cur.execute(
            f"""
            SELECT {_ALLOC_COLUMNS}
            FROM promoter_allocations a WHERE a.event_id=%s ORDER BY a.promoter_id
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post(
    "/events/{event_id}/allocations", response_model=AllocationOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_allocation(
    venue_id: int,
    event_id: int,
    body: AllocationCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        # verifica que el tipo de boleta pertenezca al evento
        await cur.execute(
            "SELECT id FROM ticket_types WHERE id=%s AND event_id=%s",
            (body.ticket_type_id, event_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Tipo de boleta no pertenece a este evento")
        await cur.execute(
            f"""
            INSERT INTO promoter_allocations AS a (event_id, ticket_type_id, promoter_id, capacity)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (event_id, ticket_type_id, promoter_id) DO UPDATE SET capacity=EXCLUDED.capacity
            RETURNING {_ALLOC_COLUMNS}
            """,
            (event_id, body.ticket_type_id, body.promoter_id, body.capacity),
        )
        created = await cur.fetchone()
        await db.commit()
    return created