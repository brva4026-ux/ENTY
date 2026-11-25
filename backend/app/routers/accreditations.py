"""Acreditaciones operativas de una noche.

No son boletas: no venden, no consumen aforo y no entran en la caja. Sirven
para prensa, artistas, producción y patrocinadores, cada una con su vigencia,
zona y número de ingresos. La puerta las escanea con el mismo lector que las
boletas; el router de tickets detecta el token y aplica estas reglas.
"""
import hashlib
from datetime import datetime, timezone
from secrets import token_urlsafe
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    AccreditationCreate,
    AccreditationCreated,
    AccreditationOut,
    MessageOut,
)

router = APIRouter(tags=["acreditaciones"])

_COLUMNS = """
    id, event_id, holder_name, holder_email, holder_phone, category, zone,
    valid_from, valid_until, entries_allowed, entries_used, status,
    created_at, revoked_at
"""


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


async def _assert_event(venue_id: int, event_id: int, db) -> dict:
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, name, status FROM events WHERE id=%s AND venue_id=%s",
            (event_id, venue_id),
        )
        ev = await cur.fetchone()
    if not ev:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ese evento no existe")
    return ev


@router.get(
    "/venues/{venue_id}/events/{event_id}/accreditations",
    response_model=list[AccreditationOut],
)
async def list_accreditations(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    await _assert_event(venue_id, event_id, db)
    async with db.cursor() as cur:
        await cur.execute(
            f"""
            SELECT {_COLUMNS}
              FROM event_accreditations
             WHERE venue_id=%s AND event_id=%s
             ORDER BY (status='active') DESC, created_at DESC, id DESC
            """,
            (venue_id, event_id),
        )
        return await cur.fetchall()


@router.post(
    "/venues/{venue_id}/events/{event_id}/accreditations",
    response_model=AccreditationCreated,
    status_code=status.HTTP_201_CREATED,
)
async def create_accreditation(
    venue_id: int,
    event_id: int,
    body: AccreditationCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    ev = await _assert_event(venue_id, event_id, db)
    if ev["status"] == "cancelled":
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Ese evento está cancelado"
        )

    now = datetime.now(timezone.utc)
    valid_from = body.valid_from or now
    if valid_from.tzinfo is None:
        valid_from = valid_from.replace(tzinfo=timezone.utc)
    valid_until = body.valid_until
    if valid_until is not None:
        if valid_until.tzinfo is None:
            valid_until = valid_until.replace(tzinfo=timezone.utc)
        if valid_until <= valid_from:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "La vigencia debe terminar después de empezar",
            )

    raw_token = token_urlsafe(24)
    async with db.cursor() as cur:
        await cur.execute(
            f"""
            INSERT INTO event_accreditations
                (venue_id, event_id, holder_name, holder_email, holder_phone,
                 category, zone, valid_from, valid_until, entries_allowed,
                 token_hash, issued_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {_COLUMNS}
            """,
            (
                venue_id,
                event_id,
                body.holder_name,
                body.holder_email,
                body.holder_phone,
                body.category,
                body.zone,
                valid_from,
                valid_until,
                body.entries_allowed,
                _hash_token(raw_token),
                user["id"],
            ),
        )
        row = await cur.fetchone()
        await db.commit()
    return AccreditationCreated(**row, raw_token=raw_token)


@router.delete(
    "/venues/{venue_id}/events/{event_id}/accreditations/{accreditation_id}",
    response_model=MessageOut,
)
async def revoke_accreditation(
    venue_id: int,
    event_id: int,
    accreditation_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    await _assert_event(venue_id, event_id, db)
    async with db.cursor() as cur:
        await cur.execute(
            """
            UPDATE event_accreditations
               SET status='revoked', revoked_at=now()
             WHERE id=%s AND venue_id=%s AND event_id=%s
               AND status='active'
            """,
            (accreditation_id, venue_id, event_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Esa acreditación no existe o ya fue revocada",
            )
        await db.commit()
    return MessageOut(detail="Acreditación revocada")
