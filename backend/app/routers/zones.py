"""Zonas físicas del recinto y su aforo (mig 070).

Una zona agrupa una o varias localidades. El aforo se mide con la presencia
real (`ticket_presence.state='inside'`), no con las boletas emitidas: el
recinto puede tener cupo global y, al mismo tiempo, el VIP lleno.
"""
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    EventZoneOut,
    MessageOut,
    ZoneCreate,
    ZoneTicketTypeOut,
    ZoneUpdate,
)

router = APIRouter(prefix="/venues/{venue_id}", tags=["zonas"])


async def _event_or_404(cur, venue_id: int, event_id: int) -> None:
    await cur.execute(
        "SELECT id FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
    )
    if not await cur.fetchone():
        raise HTTPException(404, "Evento no encontrado")


async def _zone_rows(cur, venue_id: int, event_id: int) -> list[dict]:
    await cur.execute(
        """
        WITH occ AS (SELECT * FROM event_zone_occupancy(%s))
        SELECT z.id, z.event_id, z.name, z.capacity, z.sort_order,
               COALESCE(o.inside, 0)::int AS inside,
               COALESCE(o.free_seats, z.capacity)::int AS free_seats,
               COALESCE(o.status, 'open') AS status
          FROM event_zones z
          LEFT JOIN occ o ON o.zone_id = z.id
         WHERE z.event_id=%s AND z.venue_id=%s
         ORDER BY z.sort_order, z.name
        """,
        (event_id, event_id, venue_id),
    )
    zones = [dict(r) for r in await cur.fetchall()]
    if not zones:
        return zones

    await cur.execute(
        """
        SELECT tt.id, tt.name, tt.quantity, tt.zone_id,
               count(t.id) FILTER (
                   WHERE t.status NOT IN ('voided', 'refunded')
               )::int AS issued
          FROM ticket_types tt
          LEFT JOIN tickets t ON t.ticket_type_id = tt.id
         WHERE tt.event_id=%s AND tt.zone_id IS NOT NULL
         GROUP BY tt.id, tt.name, tt.quantity, tt.zone_id
         ORDER BY tt.name
        """,
        (event_id,),
    )
    by_zone: dict[int, list[dict]] = {}
    for row in await cur.fetchall():
        by_zone.setdefault(row["zone_id"], []).append(dict(row))

    for zone in zones:
        types = by_zone.get(zone["id"], [])
        zone["ticket_types"] = [ZoneTicketTypeOut(**t) for t in types]
        zone["ticket_type_count"] = len(types)
        zone["ticket_type_names"] = [t["name"] for t in types]
        zone["issued"] = sum(t["issued"] for t in types)
    return zones


@router.get("/events/{event_id}/zones", response_model=list[EventZoneOut])
async def list_zones(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        return await _zone_rows(cur, venue_id, event_id)


@router.post(
    "/events/{event_id}/zones",
    response_model=EventZoneOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_zone(
    venue_id: int,
    event_id: int,
    body: ZoneCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        try:
            await cur.execute(
                """
                INSERT INTO event_zones
                    (event_id, venue_id, name, capacity, sort_order)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id
                """,
                (event_id, venue_id, body.name.strip(), body.capacity, body.sort_order),
            )
        except psycopg.errors.UniqueViolation:
            await db.rollback()
            raise HTTPException(409, "Ya existe una zona con ese nombre")
        zone_id = (await cur.fetchone())["id"]
        await db.commit()
        rows = await _zone_rows(cur, venue_id, event_id)
    return next(z for z in rows if z["id"] == zone_id)


@router.patch("/events/{event_id}/zones/{zone_id}", response_model=EventZoneOut)
async def update_zone(
    venue_id: int,
    event_id: int,
    zone_id: int,
    body: ZoneUpdate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        await cur.execute(
            "SELECT id FROM event_zones WHERE id=%s AND event_id=%s AND venue_id=%s",
            (zone_id, event_id, venue_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Zona no encontrada")

        data = body.model_dump(exclude_unset=True)
        if data.get("name") is not None:
            data["name"] = data["name"].strip()
        if not data:
            rows = await _zone_rows(cur, venue_id, event_id)
            return next(z for z in rows if z["id"] == zone_id)
        try:
            await cur.execute(
                """
                UPDATE event_zones
                   SET name=COALESCE(%s, name),
                       capacity=COALESCE(%s, capacity),
                       sort_order=COALESCE(%s, sort_order),
                       updated_at=now()
                 WHERE id=%s
                """,
                (data.get("name"), data.get("capacity"), data.get("sort_order"), zone_id),
            )
        except psycopg.errors.UniqueViolation:
            await db.rollback()
            raise HTTPException(409, "Ya existe una zona con ese nombre")
        await db.commit()
        rows = await _zone_rows(cur, venue_id, event_id)
    return next(z for z in rows if z["id"] == zone_id)


@router.delete("/events/{event_id}/zones/{zone_id}", response_model=MessageOut)
async def delete_zone(
    venue_id: int,
    event_id: int,
    zone_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        await cur.execute(
            "SELECT id FROM event_zones WHERE id=%s AND event_id=%s AND venue_id=%s",
            (zone_id, event_id, venue_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Zona no encontrada")
        await cur.execute(
            "SELECT count(*)::int AS n FROM ticket_types WHERE zone_id=%s",
            (zone_id,),
        )
        if (await cur.fetchone())["n"] > 0:
            raise HTTPException(
                409,
                "Reasigna las localidades a otra zona antes de eliminar esta.",
            )
        await cur.execute("DELETE FROM event_zones WHERE id=%s", (zone_id,))
        await db.commit()
    return MessageOut(detail="Zona eliminada")
