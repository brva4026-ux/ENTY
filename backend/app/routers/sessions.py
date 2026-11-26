"""Sesiones y pases de un evento con varias jornadas.

Una sesión es un evento hijo con su fecha, aforo y localidades. Un pase es una
localidad del evento padre que emite una boleta por sesión al confirmarse el
pago. La emisión vive en la DB (`emit_pass_children`) para que el webhook de
Wompi y la recuperación de pagos usen exactamente la misma regla.
"""
from datetime import datetime, timezone
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    EventSessionCreate,
    EventSessionOut,
    MessageOut,
    PassCreate,
    PassOut,
    PassSessionOut,
)

router = APIRouter(tags=["sesiones"])


async def _parent(venue_id: int, event_id: int, db) -> dict:
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT id, venue_id, name, event_timezone, qr_unlock_minutes,
                   category, min_age, location, description, flyer_url, status
              FROM events
             WHERE id=%s AND venue_id=%s AND parent_event_id IS NULL
            """,
            (event_id, venue_id),
        )
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ese evento no existe")
    return row


@router.get(
    "/venues/{venue_id}/events/{event_id}/sessions",
    response_model=list[EventSessionOut],
)
async def list_sessions(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    await _parent(venue_id, event_id, db)
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT e.id, e.name, e.starts_at, e.ends_at, e.capacity, e.status,
                   (SELECT tt.id FROM ticket_types tt
                     WHERE tt.event_id=e.id AND tt.is_pass_only
                     ORDER BY tt.id LIMIT 1) AS pass_ticket_type_id,
                   (SELECT count(*)::int FROM tickets t
                     WHERE t.event_id=e.id
                       AND t.status IN ('issued','redeemed')) AS issued
              FROM events e
             WHERE e.parent_event_id=%s AND e.venue_id=%s
             ORDER BY e.starts_at, e.id
            """,
            (event_id, venue_id),
        )
        return await cur.fetchall()


@router.post(
    "/venues/{venue_id}/events/{event_id}/sessions",
    response_model=EventSessionOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_session(
    venue_id: int,
    event_id: int,
    body: EventSessionCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    parent = await _parent(venue_id, event_id, db)

    starts = body.starts_at
    if starts.tzinfo is None:
        starts = starts.replace(tzinfo=timezone.utc)
    if starts < datetime.now(timezone.utc):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "La jornada no puede empezar en el pasado",
        )
    ends = body.ends_at
    if ends is not None and ends.tzinfo is None:
        ends = ends.replace(tzinfo=timezone.utc)
    if ends is not None and ends <= starts:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "La jornada debe terminar después de empezar",
        )

    async with db.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO events
                (venue_id, name, description, flyer_url, location, starts_at,
                 ends_at, event_timezone, capacity, qr_unlock_minutes, status,
                 category, min_age, parent_event_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'published',
                    %s, %s, %s)
            RETURNING id
            """,
            (
                venue_id,
                body.name,
                parent["description"],
                parent["flyer_url"],
                parent["location"],
                starts,
                ends,
                parent["event_timezone"],
                body.capacity,
                parent["qr_unlock_minutes"],
                parent["category"],
                parent["min_age"],
                event_id,
            ),
        )
        session_id = (await cur.fetchone())["id"]
        await cur.execute(
            """
            INSERT INTO ticket_types
                (event_id, name, price_cents, quantity, is_courtesy, is_active,
                 is_pass_only)
            VALUES (%s, %s, 0, %s, true, true, true)
            RETURNING id
            """,
            (session_id, f"Pase · {body.name}", body.capacity),
        )
        pass_type_id = (await cur.fetchone())["id"]
        await db.commit()

    return EventSessionOut(
        id=session_id,
        name=body.name,
        starts_at=starts,
        ends_at=ends,
        capacity=body.capacity,
        status="published",
        pass_ticket_type_id=pass_type_id,
        issued=0,
    )


@router.get(
    "/venues/{venue_id}/events/{event_id}/passes",
    response_model=list[PassOut],
)
async def list_passes(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    await _parent(venue_id, event_id, db)
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT tt.id, tt.name, tt.price_cents, tt.quantity, tt.is_active,
                   coalesce(
                     json_agg(
                       json_build_object(
                         'session_event_id', e.id,
                         'session_name', e.name,
                         'starts_at', e.starts_at,
                         'session_ticket_type_id', ps.session_ticket_type_id
                       ) ORDER BY e.starts_at
                     ) FILTER (WHERE e.id IS NOT NULL),
                     '[]'::json
                   ) AS sessions
              FROM ticket_types tt
              JOIN pass_sessions ps ON ps.pass_ticket_type_id = tt.id
              JOIN events e ON e.id = ps.session_event_id
             WHERE tt.event_id=%s
             GROUP BY tt.id
             ORDER BY tt.id DESC
            """,
            (event_id,),
        )
        rows = await cur.fetchall()
    return [
        PassOut(
            id=r["id"],
            name=r["name"],
            price_cents=r["price_cents"],
            quantity=r["quantity"],
            is_active=r["is_active"],
            sessions=[PassSessionOut(**s) for s in r["sessions"]],
        )
        for r in rows
    ]


@router.post(
    "/venues/{venue_id}/events/{event_id}/passes",
    response_model=PassOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_pass(
    venue_id: int,
    event_id: int,
    body: PassCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    parent = await _parent(venue_id, event_id, db)
    if parent["status"] == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, "Ese evento está cancelado")

    session_ids = list(dict.fromkeys(body.session_ids))
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT id, name, starts_at, capacity
              FROM events
             WHERE id = ANY(%s) AND parent_event_id=%s AND venue_id=%s
             ORDER BY starts_at
            """,
            (session_ids, event_id, venue_id),
        )
        sessions = await cur.fetchall()
        if len(sessions) != len(session_ids):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Alguna jornada no pertenece a este evento",
            )
        min_capacity = min(s["capacity"] for s in sessions)
        if body.quantity > min_capacity:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"El pase no puede superar el aforo de la jornada más chica ({min_capacity})",
            )

        await cur.execute(
            """
            INSERT INTO ticket_types
                (event_id, name, price_cents, quantity, is_courtesy, is_active)
            VALUES (%s, %s, %s, %s, false, true)
            RETURNING id
            """,
            (event_id, body.name, body.price_cents, body.quantity),
        )
        pass_type_id = (await cur.fetchone())["id"]

        mapped = []
        for session in sessions:
            await cur.execute(
                """
                SELECT id FROM ticket_types
                 WHERE event_id=%s AND is_pass_only
                 ORDER BY id LIMIT 1
                """,
                (session["id"],),
            )
            hidden = await cur.fetchone()
            if hidden:
                session_type_id = hidden["id"]
            else:
                await cur.execute(
                    """
                    INSERT INTO ticket_types
                        (event_id, name, price_cents, quantity, is_courtesy,
                         is_active, is_pass_only)
                    VALUES (%s, %s, 0, %s, true, true, true)
                    RETURNING id
                    """,
                    (session["id"], f"Pase · {session['name']}", session["capacity"]),
                )
                session_type_id = (await cur.fetchone())["id"]
            await cur.execute(
                """
                INSERT INTO pass_sessions
                    (pass_ticket_type_id, session_event_id, session_ticket_type_id)
                VALUES (%s, %s, %s)
                """,
                (pass_type_id, session["id"], session_type_id),
            )
            mapped.append((session, session_type_id))
        await db.commit()

    return PassOut(
        id=pass_type_id,
        name=body.name,
        price_cents=body.price_cents,
        quantity=body.quantity,
        is_active=True,
        sessions=[
            PassSessionOut(
                session_event_id=s["id"],
                session_name=s["name"],
                starts_at=s["starts_at"],
                session_ticket_type_id=type_id,
            )
            for s, type_id in mapped
        ],
    )


@router.delete(
    "/venues/{venue_id}/events/{event_id}/passes/{pass_id}",
    response_model=MessageOut,
)
async def deactivate_pass(
    venue_id: int,
    event_id: int,
    pass_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    await _parent(venue_id, event_id, db)
    async with db.cursor() as cur:
        await cur.execute(
            """
            UPDATE ticket_types
               SET is_active=false
             WHERE id=%s AND event_id=%s
               AND EXISTS (SELECT 1 FROM pass_sessions ps
                            WHERE ps.pass_ticket_type_id=ticket_types.id)
            """,
            (pass_id, event_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Ese pase no existe"
            )
        await db.commit()
    return MessageOut(detail="Pase archivado")
