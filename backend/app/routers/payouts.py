"""Liquidaciones de promotores (mig 010).

Transplante del modelo payment_issues de unicall-blue adaptado al negocio
de V-Pass: el promotor trabaja a comisión sobre lo que emite, el admin
cierra liquidaciones por periodo y el promotor puede disputarlas.

Reglas de oro:
- La liquidación nace de los datos (tickets emitidos por el promotor en el
  periodo), nunca de un monto escrito a mano.
- Inmutabilidad: pending/disputed admiten acción; paid/rejected son historia
  (los ajustes son otra liquidación con otro rango).
- El rango es la identidad: no se generan rangos que se pisen.
"""
from datetime import date, timedelta
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    PayoutDisputeRequest,
    PayoutGenerateRequest,
    PayoutOut,
    PayoutReviewRequest,
)

router = APIRouter(prefix="/venues/{venue_id}", tags=["liquidaciones"])

_SELECT_OUT = """
    SELECT p.id, p.promoter_id, u.full_name AS promoter_name,
           p.period_start, p.period_end, p.tickets_count, p.revenue_cents,
           p.commission_pct, p.commission_cents, p.status,
           p.paid_cents, p.paid_at, p.disputed_reason,
           p.review_note, p.reviewed_at, p.created_at
    FROM promoter_payouts p
    JOIN users u ON u.id = p.promoter_id
"""


async def _get_payout(cur, venue_id: int, payout_id: int) -> dict:
    await cur.execute(
        _SELECT_OUT + " WHERE p.id = %s AND p.venue_id = %s",
        (payout_id, venue_id),
    )
    row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Liquidación no encontrada")
    return row


@router.post("/payouts/generate", response_model=PayoutOut, status_code=status.HTTP_201_CREATED)
async def generate_payout(
    venue_id: int,
    body: PayoutGenerateRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Cierra una liquidación para un promotor en el rango dado.

    El recaudo sale de los tickets que él emitió (boletas vivas: issued +
    redeemed; anuladas no cuentan). La comisión se congela con el valor de
    la venue AL MOMENTO del cierre — cambiarla después no reescribe historia.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    if body.period_end < body.period_start:
        raise HTTPException(422, "El fin del periodo no puede ser anterior al inicio")
    if (body.period_end - body.period_start).days > 366:
        raise HTTPException(422, "El periodo no puede superar un año")

    async with db.cursor() as cur:
        # El promotor debe pertenecer a esta venue con ese rol.
        await cur.execute(
            """
            SELECT 1 FROM venue_user_roles
            WHERE venue_id=%s AND user_id=%s AND role='promotor'
            """,
            (venue_id, body.promoter_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Promotor no encontrado en esta venue")

        # Rangos secuenciales: el nuevo periodo debe empezar después del fin
        # del último cierre de ese promotor (evita dobles pagos por solape).
        await cur.execute(
            """
            SELECT max(period_end) AS last_end
            FROM promoter_payouts
            WHERE venue_id=%s AND promoter_id=%s
            """,
            (venue_id, body.promoter_id),
        )
        last_end = (await cur.fetchone())["last_end"]
        if last_end and body.period_start <= last_end:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"El rango se solapa: el último cierre termina el {last_end.isoformat()}",
            )

        # Comisión vigente de la venue (se congela en la liquidación).
        await cur.execute(
            "SELECT commission_pct FROM venues WHERE id=%s", (venue_id,)
        )
        venue = await cur.fetchone()
        if not venue:
            raise HTTPException(404, "Venue no encontrada")
        pct = float(venue["commission_pct"] or 0)

        # Agregado real de ventas del periodo (boletas vivas).
        await cur.execute(
            """
            SELECT count(*)::int AS n,
                   coalesce(sum(price_cents_snapshot), 0)::bigint AS revenue
            FROM tickets t
            JOIN events e ON e.id = t.event_id
            WHERE e.venue_id = %s
              AND t.sold_by_user_id = %s
              AND t.status IN ('issued','redeemed')
              AND t.issued_at >= %s::date
              AND t.issued_at < (%s::date + INTERVAL '1 day')
            """,
            (venue_id, body.promoter_id, body.period_start, body.period_end),
        )
        agg = await cur.fetchone()
        tickets_count = agg["n"]
        revenue = agg["revenue"]
        commission = round(revenue * pct / 100)

        await cur.execute(
            """
            INSERT INTO promoter_payouts
                (venue_id, promoter_id, period_start, period_end,
                 tickets_count, revenue_cents, commission_pct, commission_cents)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                venue_id, body.promoter_id, body.period_start, body.period_end,
                tickets_count, revenue, pct, commission,
            ),
        )
        payout_id = (await cur.fetchone())["id"]

        row = await _get_payout(cur, venue_id, payout_id)
        await db.commit()
    return row


@router.get("/payouts", response_model=list[PayoutOut])
async def list_payouts(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Todas las liquidaciones de la venue (admin)."""
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute(
            _SELECT_OUT + " WHERE p.venue_id = %s ORDER BY p.created_at DESC",
            (venue_id,),
        )
        rows = await cur.fetchall()
    return rows


@router.get("/payouts/mine", response_model=list[PayoutOut])
async def my_payouts(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Liquidaciones del propio promotor."""
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await cur.execute(
            _SELECT_OUT
            + " WHERE p.venue_id = %s AND p.promoter_id = %s ORDER BY p.created_at DESC",
            (venue_id, user["id"]),
        )
        rows = await cur.fetchall()
    return rows


@router.post("/payouts/{payout_id}/dispute", response_model=PayoutOut)
async def dispute_payout(
    venue_id: int,
    payout_id: int,
    body: PayoutDisputeRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """El promotor disputa SU liquidación pendiente (por qué no cuadra)."""
    ensure_roles(user, venue_id, "promotor")
    async with db.cursor() as cur:
        row = await _get_payout(cur, venue_id, payout_id)
        if row["promoter_id"] != user["id"]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "No es tu liquidación")
        if row["status"] != "pending":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Solo se pueden disputar liquidaciones pendientes",
            )
        await cur.execute(
            """
            UPDATE promoter_payouts
            SET status='disputed', disputed_reason=%s
            WHERE id=%s
            """,
            (body.reason.strip(), payout_id),
        )
        row = await _get_payout(cur, venue_id, payout_id)
        await db.commit()
    return row


@router.post("/payouts/{payout_id}/review", response_model=PayoutOut)
async def review_payout(
    venue_id: int,
    payout_id: int,
    body: PayoutReviewRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Resolución del admin: pagar (monto opcional ajustado) o rechazar."""
    ensure_roles(user, venue_id, "super_admin", "admin")
    if body.action == "reject" and not (body.note and body.note.strip()):
        raise HTTPException(422, "Rechazar exige una nota: el promotor verá el motivo")

    async with db.cursor() as cur:
        row = await _get_payout(cur, venue_id, payout_id)
        if row["status"] in ("paid", "rejected"):
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Esta liquidación ya está cerrada"
            )

        if body.action == "pay":
            paid = body.paid_cents if body.paid_cents is not None else row["commission_cents"]
            await cur.execute(
                """
                UPDATE promoter_payouts
                SET status='paid', paid_cents=%s, paid_at=now(),
                    reviewed_by=%s, reviewed_at=now(), review_note=%s
                WHERE id=%s
                """,
                (paid, user["id"], body.note, payout_id),
            )
        else:
            await cur.execute(
                """
                UPDATE promoter_payouts
                SET status='rejected', reviewed_by=%s, reviewed_at=now(), review_note=%s
                WHERE id=%s
                """,
                (user["id"], body.note.strip(), payout_id),
            )
        row = await _get_payout(cur, venue_id, payout_id)
        await db.commit()
    return row
