"""Reporte en vivo del evento: agregados por estado, por tipo y por promotor."""
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import EventReport

router = APIRouter(prefix="/venues/{venue_id}", tags=["reporte"])


@router.get("/events/{event_id}/report", response_model=EventReport)
async def event_report(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")

    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT id, name, capacity FROM events WHERE id=%s AND venue_id=%s
            """,
            (event_id, venue_id),
        )
        ev = await cur.fetchone()
        if not ev:
            from fastapi import HTTPException

            raise HTTPException(404, "Evento no encontrado")

        await cur.execute(
            """
            SELECT status, count(*)::int AS n
            FROM tickets WHERE event_id=%s GROUP BY status
            """,
            (event_id,),
        )
        by_status = {r["status"]: r["n"] for r in await cur.fetchall()}

        await cur.execute(
            """
            SELECT tt.name, tt.price_cents, count(t.id)::int AS issued,
                   count(t.id) FILTER (WHERE t.status='redeemed')::int AS redeemed
            FROM ticket_types tt
            LEFT JOIN tickets t ON t.ticket_type_id=tt.id AND t.event_id=%s
            WHERE tt.event_id=%s
            GROUP BY tt.id ORDER BY tt.id
            """,
            (event_id, event_id),
        )
        by_type = await cur.fetchall()

        await cur.execute(
            """
            SELECT u.full_name, u.id AS promoter_id,
                   count(t.id)::int AS issued,
                   count(t.id) FILTER (WHERE t.status='redeemed')::int AS redeemed,
                   a.capacity
            FROM promoter_allocations a
            JOIN users u ON u.id=a.promoter_id
            LEFT JOIN tickets t ON t.allocation_id=a.id
            WHERE a.event_id=%s
            GROUP BY u.id, u.full_name, a.capacity
            ORDER BY u.full_name
            """,
            (event_id,),
        )
        by_promoter = await cur.fetchall()

    total_active = by_status.get("issued", 0) + by_status.get("redeemed", 0)
    redeemed = by_status.get("redeemed", 0)
    voided = by_status.get("voided", 0)
    pending = total_active - redeemed
    occupancy = (total_active / ev["capacity"] * 100) if ev["capacity"] else 0

    return EventReport(
        event_id=ev["id"],
        event_name=ev["name"],
        capacity=ev["capacity"],
        issued=total_active,
        redeemed=redeemed,
        pending=pending,
        voided=voided,
        occupancy_pct=round(occupancy, 1),
        by_type=by_type,
        by_promoter=by_promoter,
    )