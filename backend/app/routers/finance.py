"""Costos del evento y punto de equilibrio.

El objetivo es que el administrador abra Enty ANTES de la noche y sepa si la
venta actual cubre lo que ya contrató. No se inventan costos: cada fila es un
costo que alguien registró, con su etapa (estimado, registrado o pagado).

El dinero cobrado es el de las boletas activas menos los reembolsos. Las
cortesías no suman caja. La proyección usa el precio promedio realmente
cobrado y el inventario que queda, no el aforo teórico.
"""
import math
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.audit import write_audit
from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    BreakEvenOut,
    EventCostCreate,
    EventCostOut,
    EventCostUpdate,
    MessageOut,
)

router = APIRouter(prefix="/venues/{venue_id}", tags=["finanzas"])

_COST_COLUMNS = (
    "id, description, category, amount_cents, status, notes, created_at, updated_at"
)


async def _event_or_404(cur, venue_id: int, event_id: int) -> dict:
    await cur.execute(
        "SELECT id, name, capacity FROM events WHERE id=%s AND venue_id=%s",
        (event_id, venue_id),
    )
    ev = await cur.fetchone()
    if not ev:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Evento no encontrado")
    return ev


async def _costs(cur, event_id: int) -> list[dict]:
    await cur.execute(
        f"SELECT {_COST_COLUMNS} FROM event_costs WHERE event_id=%s "
        "ORDER BY created_at DESC, id DESC",
        (event_id,),
    )
    return await cur.fetchall()


@router.get(
    "/events/{event_id}/break-even",
    response_model=BreakEvenOut,
)
async def break_even(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        ev = await _event_or_404(cur, venue_id, event_id)
        await cur.execute(
            """
            SELECT count(*) FILTER (WHERE status IN ('issued','redeemed'))::int
                       AS live_tickets,
                   count(*) FILTER (
                       WHERE status IN ('issued','redeemed')
                         AND price_cents_snapshot > 0
                   )::int AS paid_tickets,
                   coalesce(sum(price_cents_snapshot) FILTER (
                       WHERE status IN ('issued','redeemed')
                   ), 0)::bigint AS gross_revenue_cents,
                   (SELECT coalesce(avg(price_cents), 0)::bigint
                      FROM ticket_types
                     WHERE event_id=%s AND is_active AND NOT is_courtesy
                       AND NOT is_pass_only AND price_cents > 0)
                       AS list_price_cents
              FROM tickets WHERE event_id=%s
            """,
            (event_id, event_id),
        )
        sales = await cur.fetchone()
        await cur.execute(
            "SELECT coalesce(sum(amount_in_cents), 0)::bigint AS refunded_cents "
            "FROM ticket_refunds WHERE event_id=%s",
            (event_id,),
        )
        refunded = (await cur.fetchone())["refunded_cents"]
        await cur.execute(
            """
            SELECT status, coalesce(sum(amount_cents), 0)::bigint AS amount_cents
              FROM event_costs WHERE event_id=%s GROUP BY status
            """,
            (event_id,),
        )
        by_status = {
            row["status"]: int(row["amount_cents"]) for row in await cur.fetchall()
        }
        costs = await _costs(cur, event_id)

    estimated = by_status.get("estimated", 0)
    committed = by_status.get("committed", 0) + by_status.get("paid", 0)
    paid = by_status.get("paid", 0)
    if committed > 0:
        target, basis = committed, "registrado"
    elif estimated > 0:
        target, basis = estimated, "estimado"
    else:
        target, basis = 0, "sin_costos"

    gross = int(sales["gross_revenue_cents"])
    collected = gross - int(refunded)
    remaining = max(target - collected, 0)
    covered = (
        round(min(100.0, max(0.0, collected / target * 100.0)), 1)
        if target > 0
        else 0.0
    )

    paid_tickets = int(sales["paid_tickets"])
    if paid_tickets > 0:
        avg_ticket = round(gross / paid_tickets)
        avg_basis = "ventas"
    else:
        avg_ticket = int(sales["list_price_cents"])
        avg_basis = "lista"
    capacity_left = max(int(ev["capacity"]) - int(sales["live_tickets"]), 0)
    projected = collected + capacity_left * avg_ticket
    tickets_remaining = (
        math.ceil(remaining / avg_ticket) if avg_ticket > 0 and remaining > 0 else 0
    )

    if target == 0:
        state = "sin_costos"
    elif collected >= target:
        state = "cubierto"
    elif projected >= target:
        state = "en_camino"
    else:
        state = "en_riesgo"

    return BreakEvenOut(
        event_id=ev["id"],
        capacity=int(ev["capacity"]),
        live_tickets=int(sales["live_tickets"]),
        paid_tickets=paid_tickets,
        avg_ticket_cents=avg_ticket,
        avg_ticket_basis=avg_basis,
        gross_revenue_cents=gross,
        refunded_cents=int(refunded),
        collected_cents=collected,
        estimated_cents=estimated,
        committed_cents=committed,
        paid_cents=paid,
        target_cents=target,
        target_basis=basis,
        remaining_cents=remaining,
        covered_pct=covered,
        tickets_remaining=tickets_remaining,
        capacity_left=capacity_left,
        projected_revenue_cents=projected,
        projected_result_cents=projected - target,
        status=state,
        costs=[EventCostOut.model_validate(row) for row in costs],
    )


@router.get(
    "/events/{event_id}/costs",
    response_model=list[EventCostOut],
)
async def list_costs(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        return await _costs(cur, event_id)


@router.post(
    "/events/{event_id}/costs",
    response_model=EventCostOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_cost(
    venue_id: int,
    event_id: int,
    body: EventCostCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        await cur.execute(
            f"""
            INSERT INTO event_costs
                (event_id, venue_id, description, category, amount_cents,
                 status, notes, created_by_user_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {_COST_COLUMNS}
            """,
            (
                event_id,
                venue_id,
                body.description.strip(),
                (body.category or "otro").strip() or "otro",
                body.amount_cents,
                body.status,
                (body.notes or "").strip() or None,
                user["id"],
            ),
        )
        row = await cur.fetchone()
        await write_audit(
            cur,
            venue_id,
            user["id"],
            "event_cost_created",
            "event_cost",
            row["id"],
            {
                "event_id": event_id,
                "amount_cents": body.amount_cents,
                "status": body.status,
            },
        )
        await db.commit()
    return row


@router.patch(
    "/events/{event_id}/costs/{cost_id}",
    response_model=EventCostOut,
)
async def update_cost(
    venue_id: int,
    event_id: int,
    cost_id: int,
    body: EventCostUpdate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    data = body.model_dump(exclude_unset=True)
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        if not data:
            await cur.execute(
                f"SELECT {_COST_COLUMNS} FROM event_costs "
                "WHERE id=%s AND event_id=%s AND venue_id=%s",
                (cost_id, event_id, venue_id),
            )
            row = await cur.fetchone()
            if not row:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Costo no encontrado")
            return row

        if "description" in data:
            data["description"] = data["description"].strip()
        if "category" in data:
            data["category"] = (data["category"] or "").strip() or "otro"
        if "notes" in data:
            data["notes"] = (data["notes"] or "").strip() or None

        sets = [f"{key}=%s" for key in data]
        params = list(data.values())
        sets.append("updated_at=now()")
        params.extend([cost_id, event_id, venue_id])
        await cur.execute(
            f"UPDATE event_costs SET {', '.join(sets)} "
            "WHERE id=%s AND event_id=%s AND venue_id=%s "
            f"RETURNING {_COST_COLUMNS}",
            params,
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Costo no encontrado")
        await write_audit(
            cur,
            venue_id,
            user["id"],
            "event_cost_updated",
            "event_cost",
            cost_id,
            {"event_id": event_id, "fields": sorted(data)},
        )
        await db.commit()
    return row


@router.delete(
    "/events/{event_id}/costs/{cost_id}",
    response_model=MessageOut,
)
async def delete_cost(
    venue_id: int,
    event_id: int,
    cost_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        await cur.execute(
            "DELETE FROM event_costs "
            "WHERE id=%s AND event_id=%s AND venue_id=%s",
            (cost_id, event_id, venue_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Costo no encontrado")
        await write_audit(
            cur,
            venue_id,
            user["id"],
            "event_cost_deleted",
            "event_cost",
            cost_id,
            {"event_id": event_id},
        )
        await db.commit()
    return MessageOut(detail="Costo eliminado")
