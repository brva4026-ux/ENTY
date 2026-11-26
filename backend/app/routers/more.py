"""Doce frentes nuevos de Enty (mig 072)."""
import hashlib
import secrets
from datetime import datetime, timezone
from typing import Annotated

import httpx
import psycopg
from fastapi import APIRouter, Depends, HTTPException

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    AccessRulesIn,
    ArchiveIn,
    DisputeIn,
    DisputePatch,
    FeeConfigIn,
    LinkCheckIn,
    LotteryEntryIn,
    LotteryIn,
    ManualAdmissionIn,
    MessageOut,
    PollIn,
    PollStatusIn,
    PollVoteIn,
    RecordingIn,
    RsvpIn,
    RsvpStatusIn,
    VenueProfileIn,
)

router = APIRouter(tags=["more"])


async def _event(cur, venue_id: int, event_id: int) -> dict:
    await cur.execute(
        "SELECT id, venue_id, name, status, capacity, starts_at, flyer_url"
        " FROM events WHERE id=%s AND venue_id=%s",
        (event_id, venue_id),
    )
    row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Evento no encontrado")
    return row


async def _ticket_by_token(cur, event_id: int, raw_token: str) -> dict:
    digest = hashlib.sha256(raw_token.encode()).hexdigest()
    await cur.execute(
        """
        SELECT t.*, tt.name AS type_name
          FROM tickets t JOIN ticket_types tt ON tt.id=t.ticket_type_id
         WHERE t.event_id=%s AND t.token_hash=%s
        """,
        (event_id, digest),
    )
    row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Boleta no encontrada")
    return row


# ---------------------------------------------------------------------------
# 1. Ingreso sin celular
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/door/lookup")
async def door_lookup(
    venue_id: int,
    event_id: int,
    q: str,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    term = f"%{q.strip()}%"
    if len(q.strip()) < 3:
        raise HTTPException(422, "Escribe al menos 3 caracteres")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT t.id, t.customer_name, t.customer_phone, t.customer_email,
                   t.status, t.redeemed_at, t.price_cents_snapshot,
                   tt.name AS type_name
              FROM tickets t JOIN ticket_types tt ON tt.id=t.ticket_type_id
             WHERE t.event_id=%s
               AND (t.customer_name ILIKE %s OR t.customer_phone ILIKE %s
                    OR t.customer_email ILIKE %s)
             ORDER BY t.customer_name, t.id LIMIT 25
            """,
            (event_id, term, term, term),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/door/manual-admission", status_code=201)
async def manual_admission(
    venue_id: int,
    event_id: int,
    body: ManualAdmissionIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "SELECT id, status, customer_name FROM tickets"
            " WHERE id=%s AND event_id=%s FOR UPDATE",
            (body.ticket_id, event_id),
        )
        ticket = await cur.fetchone()
        if not ticket:
            raise HTTPException(404, "Boleta no encontrada")
        if ticket["status"] == "redeemed":
            raise HTTPException(409, "Esa boleta ya había ingresado")
        if ticket["status"] != "issued":
            raise HTTPException(409, "La boleta no está vigente")
        await cur.execute(
            "UPDATE tickets SET status='redeemed', redeemed_at=now(),"
            " redeemed_by_user_id=%s, updated_at=now() WHERE id=%s",
            (user["id"], body.ticket_id),
        )
        await cur.execute(
            """
            INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id,
                                     outcome, door_id)
            VALUES (%s,%s,%s,'GRANTED','manual')
            """,
            (body.ticket_id, event_id, user["id"]),
        )
        await cur.execute(
            """
            INSERT INTO ticket_presence
                (ticket_id, event_id, state, admissions, last_in_at, last_in_door)
            VALUES (%s,%s,'inside',1,now(),'manual')
            ON CONFLICT (ticket_id) DO UPDATE
               SET state='inside', admissions=ticket_presence.admissions + 1,
                   last_in_at=now(), last_in_door='manual', updated_at=now()
            """,
            (body.ticket_id, event_id),
        )
        await cur.execute(
            """
            INSERT INTO door_manual_admissions
                (venue_id, event_id, ticket_id, staff_user_id, reason, verification)
            VALUES (%s,%s,%s,%s,%s,%s) RETURNING *
            """,
            (venue_id, event_id, body.ticket_id, user["id"], body.reason,
             body.verification),
        )
        row = await cur.fetchone()
        await db.commit()
    return {
        **row,
        "customer_name": ticket["customer_name"],
        "message": "Ingreso registrado. El QR queda marcado como utilizado.",
    }


@router.get("/venues/{venue_id}/events/{event_id}/door/manual-admissions")
async def list_manual_admissions(
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
            SELECT m.*, t.customer_name, u.full_name AS staff_name
              FROM door_manual_admissions m
              JOIN tickets t ON t.id=m.ticket_id
              LEFT JOIN users u ON u.id=m.staff_user_id
             WHERE m.event_id=%s ORDER BY m.created_at DESC LIMIT 200
            """,
            (event_id,),
        )
        return await cur.fetchall()


# ---------------------------------------------------------------------------
# 4. Reglas de vestimenta y objetos
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/access-rules")
async def get_access_rules(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "SELECT * FROM event_access_rules WHERE event_id=%s", (event_id,)
        )
        return await cur.fetchone() or {
            "event_id": event_id, "dress_code": None, "bags_policy": None,
            "prohibited_items": [], "version": 0,
        }


@router.put("/venues/{venue_id}/events/{event_id}/access-rules")
async def put_access_rules(
    venue_id: int,
    event_id: int,
    body: AccessRulesIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            INSERT INTO event_access_rules
                (event_id, dress_code, bags_policy, prohibited_items,
                 version, updated_by)
            VALUES (%s,%s,%s,%s,1,%s)
            ON CONFLICT (event_id) DO UPDATE
               SET dress_code=EXCLUDED.dress_code,
                   bags_policy=EXCLUDED.bags_policy,
                   prohibited_items=EXCLUDED.prohibited_items,
                   version=event_access_rules.version + 1,
                   updated_by=EXCLUDED.updated_by, updated_at=now()
            RETURNING *
            """,
            (event_id, body.dress_code, body.bags_policy,
             body.prohibited_items, user["id"]),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.get("/public/events/{event_id}/access-rules")
async def public_access_rules(
    event_id: int,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id FROM events WHERE id=%s AND status IN ('published','live','ended')",
            (event_id,),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")
        await cur.execute(
            "SELECT dress_code, bags_policy, prohibited_items, version, updated_at"
            " FROM event_access_rules WHERE event_id=%s",
            (event_id,),
        )
        return await cur.fetchone() or {
            "dress_code": None, "bags_policy": None,
            "prohibited_items": [], "version": 0, "updated_at": None,
        }


# ---------------------------------------------------------------------------
# 3. Costos transparentes
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/fee-config")
async def get_fee_config(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "SELECT * FROM event_fee_config WHERE event_id=%s", (event_id,)
        )
        return await cur.fetchone() or {
            "event_id": event_id, "service_fee_cents": 0,
            "payment_fee_pct": 0, "tax_pct": 0, "show_breakdown": True,
        }


@router.put("/venues/{venue_id}/events/{event_id}/fee-config")
async def put_fee_config(
    venue_id: int,
    event_id: int,
    body: FeeConfigIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            INSERT INTO event_fee_config
                (event_id, service_fee_cents, payment_fee_pct, tax_pct,
                 show_breakdown)
            VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT (event_id) DO UPDATE
               SET service_fee_cents=EXCLUDED.service_fee_cents,
                   payment_fee_pct=EXCLUDED.payment_fee_pct,
                   tax_pct=EXCLUDED.tax_pct,
                   show_breakdown=EXCLUDED.show_breakdown, updated_at=now()
            RETURNING *
            """,
            (event_id, body.service_fee_cents, body.payment_fee_pct,
             body.tax_pct, body.show_breakdown),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.get("/public/events/{event_id}/fees")
async def public_fees(
    event_id: int,
    ticket_type_id: int,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT price_cents FROM ticket_types WHERE id=%s AND event_id=%s",
            (ticket_type_id, event_id),
        )
        tipo = await cur.fetchone()
        if not tipo:
            raise HTTPException(404, "Localidad no encontrada")
        await cur.execute(
            "SELECT * FROM event_fee_config WHERE event_id=%s", (event_id,)
        )
        cfg = await cur.fetchone()
    base = tipo["price_cents"]
    service = cfg["service_fee_cents"] if cfg else 0
    payment = round((base + service) * float(cfg["payment_fee_pct"] if cfg else 0) / 100)
    tax = round((base + service) * float(cfg["tax_pct"] if cfg else 0) / 100)
    return {
        "base_cents": base,
        "service_fee_cents": service,
        "payment_fee_cents": payment,
        "tax_cents": tax,
        "total_cents": base + service + payment + tax,
        "show_breakdown": cfg["show_breakdown"] if cfg else True,
    }


# ---------------------------------------------------------------------------
# 2. Contracargos
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/disputes")
async def list_disputes(
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
            SELECT d.*, p.reference, p.customer_name, p.status AS payment_status,
                   p.amount_in_cents AS payment_amount_cents,
                   (d.due_at IS NOT NULL AND d.due_at < now()
                    AND d.status IN ('abierta','en_revision')) AS overdue
              FROM payment_disputes d
              LEFT JOIN ticket_payments p ON p.id=d.payment_id
             WHERE d.event_id=%s
             ORDER BY d.status IN ('abierta','en_revision') DESC, d.due_at NULLS LAST
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/disputes", status_code=201)
async def create_dispute(
    venue_id: int,
    event_id: int,
    body: DisputeIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        if body.payment_id is not None:
            await cur.execute(
                "SELECT id FROM ticket_payments WHERE id=%s AND event_id=%s",
                (body.payment_id, event_id),
            )
            if not await cur.fetchone():
                raise HTTPException(404, "Pago no encontrado")
        await cur.execute(
            """
            INSERT INTO payment_disputes
                (venue_id, event_id, payment_id, amount_cents, reason,
                 due_at, notes, created_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *
            """,
            (venue_id, event_id, body.payment_id, body.amount_cents,
             body.reason, body.due_at, body.notes, user["id"]),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.patch("/venues/{venue_id}/events/{event_id}/disputes/{dispute_id}")
async def update_dispute(
    venue_id: int,
    event_id: int,
    dispute_id: int,
    body: DisputePatch,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            UPDATE payment_disputes
               SET status=COALESCE(%s, status),
                   notes=COALESCE(%s, notes),
                   evidence=COALESCE(%s, evidence),
                   updated_at=now()
             WHERE id=%s AND event_id=%s RETURNING *
            """,
            (body.status, body.notes, body.evidence, dispute_id, event_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Disputa no encontrada")
        await db.commit()
    return row


# ---------------------------------------------------------------------------
# 5. Votaciones
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/polls")
async def list_polls(
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
            SELECT p.*,
                   coalesce(json_agg(json_build_object(
                     'id', o.id, 'label', o.label, 'votes', (
                       SELECT count(*) FROM event_poll_votes v
                        WHERE v.option_id=o.id
                     )
                   ) ORDER BY o.sort_order, o.id)
                   FILTER (WHERE o.id IS NOT NULL), '[]'::json) AS options
              FROM event_polls p
              LEFT JOIN event_poll_options o ON o.poll_id=p.id
             WHERE p.event_id=%s GROUP BY p.id ORDER BY p.created_at DESC
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/polls", status_code=201)
async def create_poll(
    venue_id: int,
    event_id: int,
    body: PollIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            INSERT INTO event_polls (event_id, question, opens_at, closes_at, created_by)
            VALUES (%s,%s,%s,%s,%s) RETURNING *
            """,
            (event_id, body.question, body.opens_at, body.closes_at, user["id"]),
        )
        poll = await cur.fetchone()
        for index, label in enumerate(body.options):
            await cur.execute(
                "INSERT INTO event_poll_options (poll_id, label, sort_order)"
                " VALUES (%s,%s,%s)",
                (poll["id"], label, index),
            )
        await db.commit()
    return poll


@router.patch("/venues/{venue_id}/events/{event_id}/polls/{poll_id}")
async def update_poll_status(
    venue_id: int,
    event_id: int,
    poll_id: int,
    body: PollStatusIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "UPDATE event_polls SET status=%s WHERE id=%s AND event_id=%s RETURNING *",
            (body.status, poll_id, event_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Votación no encontrada")
        await db.commit()
    return row


@router.get("/public/events/{event_id}/polls")
async def public_polls(
    event_id: int,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT p.id, p.question, p.status, p.opens_at, p.closes_at,
                   coalesce(json_agg(json_build_object(
                     'id', o.id, 'label', o.label,
                     'votes', CASE WHEN p.status='publicada' THEN (
                       SELECT count(*) FROM event_poll_votes v
                        WHERE v.option_id=o.id
                     ) ELSE NULL END
                   ) ORDER BY o.sort_order, o.id)
                   FILTER (WHERE o.id IS NOT NULL), '[]'::json) AS options
              FROM event_polls p
              LEFT JOIN event_poll_options o ON o.poll_id=p.id
             WHERE p.event_id=%s AND p.status IN ('abierta','cerrada','publicada')
             GROUP BY p.id ORDER BY p.created_at DESC
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/public/polls/{poll_id}/vote")
async def vote_poll(
    poll_id: int,
    body: PollVoteIn,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute("SELECT * FROM event_polls WHERE id=%s", (poll_id,))
        poll = await cur.fetchone()
        if not poll:
            raise HTTPException(404, "Votación no encontrada")
        if poll["status"] != "abierta":
            raise HTTPException(409, "La votación no está abierta")
        now = datetime.now(timezone.utc)
        if poll["opens_at"] and poll["opens_at"] > now:
            raise HTTPException(409, "La votación todavía no abre")
        if poll["closes_at"] and poll["closes_at"] < now:
            raise HTTPException(409, "La votación ya cerró")
        await cur.execute(
            "SELECT id FROM event_poll_options WHERE id=%s AND poll_id=%s",
            (body.option_id, poll_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Opción no encontrada")
        ticket = await _ticket_by_token(cur, poll["event_id"], body.ticket_token)
        if ticket["status"] not in ("issued", "redeemed"):
            raise HTTPException(409, "La boleta no está vigente")
        try:
            await cur.execute(
                "INSERT INTO event_poll_votes (poll_id, option_id, ticket_id)"
                " VALUES (%s,%s,%s)",
                (poll_id, body.option_id, ticket["id"]),
            )
            await db.commit()
        except psycopg.errors.UniqueViolation as error:
            await db.rollback()
            raise HTTPException(409, "Esa boleta ya votó") from error
    return MessageOut(detail="Voto registrado")


# ---------------------------------------------------------------------------
# 6. Grabaciones
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/recordings")
async def list_recordings(
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
            SELECT r.*, tt.name AS type_name
              FROM event_recordings r
              LEFT JOIN ticket_types tt ON tt.id=r.ticket_type_id
             WHERE r.event_id=%s ORDER BY r.created_at DESC
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/recordings", status_code=201)
async def create_recording(
    venue_id: int,
    event_id: int,
    body: RecordingIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            INSERT INTO event_recordings
                (event_id, ticket_type_id, title, url, available_from,
                 available_until, created_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *
            """,
            (event_id, body.ticket_type_id, body.title, body.url,
             body.available_from, body.available_until, user["id"]),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.delete("/venues/{venue_id}/events/{event_id}/recordings/{recording_id}",
               response_model=MessageOut)
async def delete_recording(
    venue_id: int,
    event_id: int,
    recording_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "DELETE FROM event_recordings WHERE id=%s AND event_id=%s",
            (recording_id, event_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Grabación no encontrada")
        await db.commit()
    return MessageOut(detail="Grabación eliminada")


@router.get("/public/events/{event_id}/recordings")
async def public_recordings(
    event_id: int,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    ticket_token: str | None = None,
):
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id FROM events WHERE id=%s AND status IN ('published','live','ended')",
            (event_id,),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")
        type_id = None
        if ticket_token:
            ticket = await _ticket_by_token(cur, event_id, ticket_token)
            if ticket["status"] not in ("issued", "redeemed"):
                raise HTTPException(409, "La boleta no está vigente")
            type_id = ticket["ticket_type_id"]
        await cur.execute(
            """
            SELECT id, title, url, ticket_type_id, available_from, available_until
              FROM event_recordings
             WHERE event_id=%s
               AND (available_from IS NULL OR available_from <= now())
               AND (available_until IS NULL OR available_until >= now())
               AND (ticket_type_id IS NULL OR ticket_type_id=%s)
             ORDER BY created_at DESC
            """,
            (event_id, type_id),
        )
        return await cur.fetchall()


# ---------------------------------------------------------------------------
# 7. Sorteo de acceso
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/lotteries")
async def list_lotteries(
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
            SELECT l.*,
                   (SELECT count(*) FROM event_lottery_entries e
                     WHERE e.lottery_id=l.id) AS entries,
                   (SELECT count(*) FROM event_lottery_winners w
                     WHERE w.lottery_id=l.id) AS winners
              FROM event_lotteries l WHERE l.event_id=%s
             ORDER BY l.created_at DESC
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/lotteries", status_code=201)
async def create_lottery(
    venue_id: int,
    event_id: int,
    body: LotteryIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    if body.closes_at <= body.opens_at:
        raise HTTPException(422, "El cierre debe ser después de la apertura")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            INSERT INTO event_lotteries
                (event_id, name, opens_at, closes_at, draw_at, quantity,
                 status, terms, created_by)
            VALUES (%s,%s,%s,%s,%s,%s,'abierta',%s,%s) RETURNING *
            """,
            (event_id, body.name, body.opens_at, body.closes_at,
             body.draw_at, body.quantity, body.terms, user["id"]),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.post("/venues/{venue_id}/events/{event_id}/lotteries/{lottery_id}/draw")
async def draw_lottery(
    venue_id: int,
    event_id: int,
    lottery_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "SELECT * FROM event_lotteries WHERE id=%s AND event_id=%s FOR UPDATE",
            (lottery_id, event_id),
        )
        lottery = await cur.fetchone()
        if not lottery:
            raise HTTPException(404, "Sorteo no encontrado")
        await cur.execute(
            """
            SELECT e.* FROM event_lottery_entries e
             WHERE e.lottery_id=%s
               AND NOT EXISTS (SELECT 1 FROM event_lottery_winners w
                                WHERE w.entry_id=e.id)
             ORDER BY random() LIMIT %s
            """,
            (lottery_id, lottery["quantity"]),
        )
        entries = await cur.fetchall()
        winners = []
        for entry in entries:
            token = secrets.token_urlsafe(24)
            await cur.execute(
                """
                INSERT INTO event_lottery_winners
                    (lottery_id, entry_id, token, reserved_until)
                VALUES (%s,%s,%s, now() + interval '48 hours')
                RETURNING *
                """,
                (lottery_id, entry["id"], token),
            )
            winners.append({**await cur.fetchone(), "name": entry["name"],
                            "email": entry["email"]})
        await cur.execute(
            "UPDATE event_lotteries SET status='sorteada', draw_at=now()"
            " WHERE id=%s",
            (lottery_id,),
        )
        await db.commit()
    return {"lottery_id": lottery_id, "winners": winners}


@router.get("/venues/{venue_id}/events/{event_id}/lotteries/{lottery_id}/winners")
async def list_lottery_winners(
    venue_id: int,
    event_id: int,
    lottery_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT w.*, e.name, e.email, e.phone
              FROM event_lottery_winners w
              JOIN event_lottery_entries e ON e.id=w.entry_id
             WHERE w.lottery_id=%s ORDER BY w.created_at
            """,
            (lottery_id,),
        )
        return await cur.fetchall()


@router.get("/public/events/{event_id}/lotteries")
async def public_lotteries(
    event_id: int,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT l.id, l.name, l.opens_at, l.closes_at, l.quantity,
                   l.status, l.terms,
                   (SELECT count(*) FROM event_lottery_entries e
                     WHERE e.lottery_id=l.id) AS entries
              FROM event_lotteries l
             WHERE l.event_id=%s AND l.status IN ('abierta','sorteada')
             ORDER BY l.opens_at DESC
            """,
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/public/lotteries/{lottery_id}/enter", status_code=201)
async def enter_lottery(
    lottery_id: int,
    body: LotteryEntryIn,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    token = secrets.token_urlsafe(24)
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT * FROM event_lotteries WHERE id=%s", (lottery_id,)
        )
        lottery = await cur.fetchone()
        if not lottery:
            raise HTTPException(404, "Sorteo no encontrado")
        now = datetime.now(timezone.utc)
        if lottery["status"] != "abierta":
            raise HTTPException(409, "El sorteo no está abierto")
        if lottery["opens_at"] > now or lottery["closes_at"] < now:
            raise HTTPException(409, "El período de inscripción está cerrado")
        try:
            await cur.execute(
                """
                INSERT INTO event_lottery_entries
                    (lottery_id, name, email, phone, token)
                VALUES (%s,%s,%s,%s,%s) RETURNING id, token
                """,
                (lottery_id, body.name, body.email.lower(), body.phone, token),
            )
            row = await cur.fetchone()
            await db.commit()
        except psycopg.errors.UniqueViolation as error:
            await db.rollback()
            raise HTTPException(409, "Ese correo ya está inscrito") from error
    return {**row, "message": "Quedaste inscrito. Te avisaremos si sales sorteado."}


@router.get("/public/lottery-winners/{token}")
async def read_lottery_winner(
    token: str,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT w.*, e.name, e.email, l.event_id, l.name AS lottery_name,
                   ev.name AS event_name, ev.starts_at
              FROM event_lottery_winners w
              JOIN event_lottery_entries e ON e.id=w.entry_id
              JOIN event_lotteries l ON l.id=w.lottery_id
              JOIN events ev ON ev.id=l.event_id
             WHERE w.token=%s
            """,
            (token,),
        )
        row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Ganador no encontrado")
    return row


@router.post("/public/lottery-winners/{token}/claim")
async def claim_lottery_winner(
    token: str,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            "UPDATE event_lottery_winners SET claimed_at=now()"
            " WHERE token=%s AND claimed_at IS NULL RETURNING id",
            (token,),
        )
        if not await cur.fetchone():
            raise HTTPException(409, "Ese derecho ya se usó o no existe")
        await db.commit()
    return MessageOut(detail="Derecho a compra confirmado")


# ---------------------------------------------------------------------------
# 8. Registro gratuito (RSVP)
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/rsvps")
async def list_rsvps(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "SELECT * FROM event_rsvps WHERE event_id=%s"
            " ORDER BY status, created_at DESC",
            (event_id,),
        )
        return await cur.fetchall()


@router.patch("/venues/{venue_id}/events/{event_id}/rsvps/{rsvp_id}")
async def update_rsvp(
    venue_id: int,
    event_id: int,
    rsvp_id: int,
    body: RsvpStatusIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "UPDATE event_rsvps SET status=%s, updated_at=now()"
            " WHERE id=%s AND event_id=%s RETURNING *",
            (body.status, rsvp_id, event_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Registro no encontrado")
        await db.commit()
    return row


@router.post("/public/events/{event_id}/rsvp", status_code=201)
async def create_rsvp(
    event_id: int,
    body: RsvpIn,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    token = secrets.token_urlsafe(24)
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id FROM events WHERE id=%s AND status IN ('published','live')",
            (event_id,),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")
        await cur.execute(
            """
            INSERT INTO event_rsvps (event_id, name, email, phone, token)
            VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT (event_id, email) DO UPDATE
               SET name=EXCLUDED.name, phone=EXCLUDED.phone,
                   status='confirmada', updated_at=now()
            RETURNING id, token, status
            """,
            (event_id, body.name, body.email.lower(), body.phone, token),
        )
        row = await cur.fetchone()
        await db.commit()
    return {**row, "message": "Asistencia confirmada."}


@router.get("/public/rsvps/{token}")
async def read_rsvp(
    token: str,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT r.*, e.name AS event_name, e.starts_at
              FROM event_rsvps r JOIN events e ON e.id=r.event_id
             WHERE r.token=%s
            """,
            (token,),
        )
        row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Registro no encontrado")
    return row


@router.post("/public/rsvps/{token}/cancel")
async def cancel_rsvp(
    token: str,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            "UPDATE event_rsvps SET status='cancelada', updated_at=now()"
            " WHERE token=%s RETURNING id",
            (token,),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Registro no encontrado")
        await db.commit()
    return MessageOut(detail="Lugar liberado")


# ---------------------------------------------------------------------------
# 9. Catálogo de recintos
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/profile")
async def get_venue_profile(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await cur.execute("SELECT id FROM venues WHERE id=%s", (venue_id,))
        if not await cur.fetchone():
            raise HTTPException(404, "Local no encontrado")
        await cur.execute(
            "SELECT * FROM venue_profiles WHERE venue_id=%s", (venue_id,)
        )
        return await cur.fetchone() or {"venue_id": venue_id}


@router.put("/venues/{venue_id}/profile")
async def put_venue_profile(
    venue_id: int,
    body: VenueProfileIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute("SELECT id FROM venues WHERE id=%s", (venue_id,))
        if not await cur.fetchone():
            raise HTTPException(404, "Local no encontrado")
        await cur.execute(
            """
            INSERT INTO venue_profiles
                (venue_id, stage_width_m, stage_depth_m, load_in_start,
                 load_in_end, sound_system, lighting, power, capacity_notes,
                 technical_contact)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (venue_id) DO UPDATE
               SET stage_width_m=EXCLUDED.stage_width_m,
                   stage_depth_m=EXCLUDED.stage_depth_m,
                   load_in_start=EXCLUDED.load_in_start,
                   load_in_end=EXCLUDED.load_in_end,
                   sound_system=EXCLUDED.sound_system,
                   lighting=EXCLUDED.lighting, power=EXCLUDED.power,
                   capacity_notes=EXCLUDED.capacity_notes,
                   technical_contact=EXCLUDED.technical_contact,
                   updated_at=now()
            RETURNING *
            """,
            (venue_id, body.stage_width_m, body.stage_depth_m,
             body.load_in_start, body.load_in_end, body.sound_system,
             body.lighting, body.power, body.capacity_notes,
             body.technical_contact),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.get("/public/venues/{venue_id}/profile")
async def public_venue_profile(
    venue_id: int,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, name, slug FROM venues WHERE id=%s", (venue_id,)
        )
        venue = await cur.fetchone()
        if not venue:
            raise HTTPException(404, "Local no encontrado")
        await cur.execute(
            "SELECT * FROM venue_profiles WHERE venue_id=%s", (venue_id,)
        )
        return {**venue, "profile": await cur.fetchone()}


# ---------------------------------------------------------------------------
# 10. Previsión de personal
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/staffing-forecast")
async def staffing_forecast(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        event = await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT e.id, e.name, e.starts_at, e.capacity,
                   count(r.id) FILTER (WHERE r.outcome='GRANTED')::int AS admitted
              FROM events e
              LEFT JOIN redemptions r ON r.event_id=e.id
             WHERE e.venue_id=%s AND e.id<>%s
               AND e.starts_at >= now() - interval '180 days'
               AND e.starts_at < now()
             GROUP BY e.id ORDER BY e.starts_at DESC LIMIT 12
            """,
            (venue_id, event_id),
        )
        comparable = await cur.fetchall()
        ids = [c["id"] for c in comparable]
        hours = {}
        if ids:
            await cur.execute(
                """
                SELECT extract(hour FROM (r.scanned_at - e.starts_at))::int AS rel_hour,
                       count(*)::int AS admitted
                  FROM redemptions r JOIN events e ON e.id=r.event_id
                 WHERE r.event_id = ANY(%s) AND r.outcome='GRANTED'
                 GROUP BY 1 ORDER BY 1
                """,
                (ids,),
            )
            for row in await cur.fetchall():
                hours[row["rel_hour"]] = row["admitted"] / len(ids)
        await cur.execute(
            """
            SELECT count(*) FILTER (WHERE status IN ('issued','redeemed'))::int AS sold,
                   count(*) FILTER (WHERE status='redeemed')::int AS admitted
              FROM tickets WHERE event_id=%s
            """,
            (event_id,),
        )
        current = await cur.fetchone()

    avg_total = (
        sum(c["admitted"] for c in comparable) / len(comparable)
        if comparable else current["sold"]
    )
    plan = []
    for hour in sorted(hours):
        expected = round(hours[hour])
        plan.append({
            "relative_hour": hour,
            "expected_entries": expected,
            "recommended_staff": max(1, -(-expected // 75)),
        })
    return {
        "event_id": event_id,
        "sold": current["sold"],
        "admitted": current["admitted"],
        "capacity": event["capacity"],
        "comparable_events": [
            {"id": c["id"], "name": c["name"], "admitted": c["admitted"]}
            for c in comparable
        ],
        "average_admitted": round(avg_total),
        "hourly_plan": plan,
        "basis": f"{len(comparable)} eventos comparables de los últimos 180 días"
        if comparable else "Sin eventos comparables: se usan las ventas actuales",
    }


# ---------------------------------------------------------------------------
# 11. Revisión de enlaces
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/link-checks")
async def list_link_checks(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "SELECT * FROM event_link_checks WHERE event_id=%s"
            " ORDER BY checked_at DESC LIMIT 50",
            (event_id,),
        )
        return await cur.fetchall()


@router.post("/venues/{venue_id}/events/{event_id}/link-checks", status_code=201)
async def run_link_check(
    venue_id: int,
    event_id: int,
    body: LinkCheckIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        event = await _event(cur, venue_id, event_id)
    checks = []
    status = "ok"
    try:
        async with httpx.AsyncClient(timeout=6, follow_redirects=True) as client:
            res = await client.get(body.url)
        reachable = res.status_code < 400
        checks.append({"name": "Enlace responde", "ok": reachable,
                       "detail": f"HTTP {res.status_code}"})
        if not reachable:
            status = "fail"
    except Exception as error:  # red externa: se reporta, no se rompe
        checks.append({"name": "Enlace responde", "ok": False,
                       "detail": str(error)[:200]})
        status = "fail"
    selling = event["status"] in ("published", "live")
    checks.append({"name": "Venta habilitada", "ok": selling,
                   "detail": f"Estado: {event['status']}"})
    if not selling:
        status = "fail"
    flyer_ok = bool(event["flyer_url"])
    checks.append({"name": "Imagen para compartir", "ok": flyer_ok,
                   "detail": "Configurada" if flyer_ok else "Falta el afiche"})
    if not flyer_ok and status == "ok":
        status = "warn"
    async with db.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO event_link_checks
                (event_id, url, kind, status, details, checked_by)
            VALUES (%s,%s,%s,%s,%s,%s) RETURNING *
            """,
            (event_id, body.url, body.kind, status,
             psycopg.types.json.Jsonb({"checks": checks}), user["id"]),
        )
        row = await cur.fetchone()
        await db.commit()
    return {**row, "checks": checks}


# ---------------------------------------------------------------------------
# 12. Archivo público
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/archive")
async def get_archive(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            "SELECT * FROM event_archives WHERE event_id=%s", (event_id,)
        )
        return await cur.fetchone() or {"event_id": event_id, "enabled": False,
                                        "photos": []}


@router.put("/venues/{venue_id}/events/{event_id}/archive")
async def put_archive(
    venue_id: int,
    event_id: int,
    body: ArchiveIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            """
            INSERT INTO event_archives
                (event_id, enabled, headline, summary, photos, video_url,
                 next_event_id)
            VALUES (%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (event_id) DO UPDATE
               SET enabled=EXCLUDED.enabled, headline=EXCLUDED.headline,
                   summary=EXCLUDED.summary, photos=EXCLUDED.photos,
                   video_url=EXCLUDED.video_url,
                   next_event_id=EXCLUDED.next_event_id, updated_at=now()
            RETURNING *
            """,
            (event_id, body.enabled, body.headline, body.summary,
             psycopg.types.json.Jsonb(body.photos), body.video_url,
             body.next_event_id),
        )
        row = await cur.fetchone()
        await db.commit()
    return row


@router.get("/public/events/{event_id}/archive")
async def public_archive(
    event_id: int,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT a.*, e.name, e.starts_at, e.location, e.venue_id,
                   n.id AS next_id, n.name AS next_name, n.starts_at AS next_starts_at
              FROM event_archives a
              JOIN events e ON e.id=a.event_id
              LEFT JOIN events n ON n.id=a.next_event_id
             WHERE a.event_id=%s AND a.enabled=true
            """,
            (event_id,),
        )
        row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Este evento no tiene archivo público")
    return row
