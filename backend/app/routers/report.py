"""Reporte en vivo del evento.

Dos vistas sobre los mismos datos:

- `EventReport` (`/report`): forma original, sin dinero. La consumen el
  promotor y el bouncer (no deben ver la caja del bar).
- `ReportSummary` (`/summary`): solo admin/super_admin. Agrega ingresos y
  la integridad de la puerta (que escaneos no cuadraron).
"""
from datetime import datetime
from typing import Annotated
from zoneinfo import ZoneInfo

import psycopg
from fastapi import APIRouter, Depends, HTTPException

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import EventReport, ReportSummary, VenueOverview

router = APIRouter(prefix="/venues/{venue_id}", tags=["reporte"])

_BY_TYPE_SQL = """
    SELECT tt.id AS ticket_type_id, tt.name, tt.price_cents, tt.is_courtesy,
           tt.is_active, tt.quantity,
           count(t.id) FILTER (WHERE t.status IN ('issued','redeemed'))::int AS issued,
           count(t.id) FILTER (WHERE t.status = 'redeemed')::int AS redeemed,
           coalesce(sum(t.price_cents_snapshot)
                    FILTER (WHERE t.status IN ('issued','redeemed')), 0)::bigint
             AS revenue_cents
    FROM ticket_types tt
    LEFT JOIN tickets t ON t.ticket_type_id = tt.id AND t.event_id = %s
    WHERE tt.event_id = %s
    GROUP BY tt.id
    ORDER BY tt.id
"""

# Misma consulta sin la columna de dinero: `/report` la ve el promotor y el
# bouncer, y no deben leer la caja del bar. Sin este corte, agregar
# `revenue_cents` al desglose se filtra por el endpoint de menor privilegio.
_BY_TYPE_NO_MONEY_SQL = """
    SELECT tt.id AS ticket_type_id, tt.name, tt.price_cents, tt.is_courtesy,
           tt.is_active, tt.quantity,
           count(t.id) FILTER (WHERE t.status IN ('issued','redeemed'))::int AS issued,
           count(t.id) FILTER (WHERE t.status = 'redeemed')::int AS redeemed
    FROM ticket_types tt
    LEFT JOIN tickets t ON t.ticket_type_id = tt.id AND t.event_id = %s
    WHERE tt.event_id = %s
    GROUP BY tt.id
    ORDER BY tt.id
"""

_BY_PROMOTER_SQL = """
    SELECT u.full_name, u.id AS promoter_id, a.capacity,
           count(t.id) FILTER (WHERE t.status IN ('issued','redeemed'))::int AS issued,
           count(t.id) FILTER (WHERE t.status = 'redeemed')::int AS redeemed,
           count(t.id) FILTER (WHERE t.status = 'voided')::int AS voided
    FROM promoter_allocations a
    JOIN users u ON u.id = a.promoter_id
    LEFT JOIN tickets t ON t.allocation_id = a.id
    WHERE a.event_id = %s
    GROUP BY u.id, u.full_name, a.capacity
    ORDER BY u.full_name
"""


async def _event_or_404(cur, event_id: int, venue_id: int) -> dict:
    await cur.execute(
        "SELECT id, name, capacity FROM events WHERE id=%s AND venue_id=%s",
        (event_id, venue_id),
    )
    ev = await cur.fetchone()
    if not ev:
        raise HTTPException(404, "Evento no encontrado")
    return ev


async def _by_status(cur, event_id: int) -> dict[str, int]:
    await cur.execute(
        "SELECT status, count(*)::int AS n FROM tickets WHERE event_id=%s GROUP BY status",
        (event_id,),
    )
    return {r["status"]: r["n"] for r in await cur.fetchall()}


def _totals(by_status: dict[str, int], capacity: int) -> dict:
    """Boletas vivas (issued + redeemed) contra el aforo."""
    redeemed = by_status.get("redeemed", 0)
    live = by_status.get("issued", 0) + redeemed
    return {
        "issued": live,
        "redeemed": redeemed,
        "pending": live - redeemed,
        "voided": by_status.get("voided", 0),
        "occupancy_pct": round(live / capacity * 100, 1) if capacity else 0.0,
    }


@router.get("/events/{event_id}/report", response_model=EventReport)
async def event_report(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")

    async with db.cursor() as cur:
        ev = await _event_or_404(cur, event_id, venue_id)
        by_status = await _by_status(cur, event_id)

        await cur.execute(_BY_TYPE_SQL, (event_id, event_id))
        by_type = await cur.fetchall()

        await cur.execute(_BY_PROMOTER_SQL, (event_id,))
        by_promoter = await cur.fetchall()

        # Recaudo vivo: suma de snapshots de boletas activas (criterio local,
        # validado por tests: anular lo baja, emitir lo sube).
        await cur.execute(
            "SELECT coalesce(sum(price_cents_snapshot) "
            "FILTER (WHERE status IN ('issued','redeemed')), 0)::bigint AS revenue "
            "FROM tickets WHERE event_id=%s",
            (event_id,),
        )
        revenue = (await cur.fetchone())["revenue"]

    return EventReport(
        event_id=ev["id"],
        event_name=ev["name"],
        capacity=ev["capacity"],
        **_totals(by_status, ev["capacity"]),
        revenue_cents=revenue,
        by_type=by_type,
        by_promoter=by_promoter,
    )


@router.get("/events/{event_id}/summary", response_model=ReportSummary)
async def event_summary(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Caja + integridad de puerta. Solo admin: expone los ingresos."""
    ensure_roles(user, venue_id, "super_admin", "admin")

    async with db.cursor() as cur:
        ev = await _event_or_404(cur, event_id, venue_id)
        by_status = await _by_status(cur, event_id)

        await cur.execute(
            """
            SELECT coalesce(sum(price_cents_snapshot)
                            FILTER (WHERE status IN ('issued','redeemed')), 0)::bigint
                     AS revenue_cents,
                   count(*) FILTER (WHERE status IN ('issued','redeemed')
                                      AND price_cents_snapshot > 0)::int AS paid_tickets,
                   count(*) FILTER (WHERE status IN ('issued','redeemed')
                                      AND price_cents_snapshot = 0)::int AS courtesy_tickets
            FROM tickets WHERE event_id=%s
            """,
            (event_id,),
        )
        money = await cur.fetchone()

        await cur.execute(_BY_TYPE_SQL, (event_id, event_id))
        by_type = await cur.fetchall()

        await cur.execute(_BY_PROMOTER_SQL, (event_id,))
        by_promoter = await cur.fetchall()

        await cur.execute(
            """
            SELECT count(*) FILTER (WHERE outcome IN ('granted','granted_forced'))::int AS granted,
                   count(*) FILTER (WHERE outcome='already_redeemed')::int AS already_redeemed,
                   count(*) FILTER (WHERE outcome='not_found')::int        AS not_found,
                   count(*)::int                                           AS total,
                   max(scanned_at)                                         AS last_scan_at,
                   max(scanned_at) FILTER (WHERE outcome IN ('granted','granted_forced')) AS last_granted_at
            FROM redemptions WHERE event_id=%s
            """,
            (event_id,),
        )
        door = await cur.fetchone()

        await cur.execute(
            """
            SELECT coalesce(u.full_name, 'Sin identificar') AS full_name,
                   count(*) FILTER (WHERE r.outcome IN ('granted','granted_forced'))::int  AS granted,
                   count(*) FILTER (WHERE r.outcome<>'granted')::int AS failed,
                   count(*)::int                                    AS total
            FROM redemptions r
            LEFT JOIN users u ON u.id = r.scanned_by_user_id
            WHERE r.event_id=%s
            GROUP BY u.full_name ORDER BY total DESC
            """,
            (event_id,),
        )
        scanned_by = await cur.fetchall()

    granted = door["granted"]
    failed = door["total"] - granted
    paid = money["paid_tickets"]
    revenue = money["revenue_cents"]

    return ReportSummary(
        event_id=ev["id"],
        event_name=ev["name"],
        capacity=ev["capacity"],
        **_totals(by_status, ev["capacity"]),
        revenue_cents=revenue,
        # Solo cortesias => 0 pagas: el promedio queda en 0, no divide por cero.
        avg_ticket_cents=round(revenue / paid) if paid else 0,
        paid_tickets=paid,
        courtesy_tickets=money["courtesy_tickets"],
        door={
            "granted": granted,
            "already_redeemed": door["already_redeemed"],
            "not_found": door["not_found"],
            # Resto de motivos (invalid_event, event_not_live, not_valid).
            "other_failed": failed - door["already_redeemed"] - door["not_found"],
            "failed": failed,
            "total": door["total"],
            "last_scan_at": door["last_scan_at"],
            "last_granted_at": door["last_granted_at"],
            "scanned_by": scanned_by,
        },
        by_type=by_type,
        by_promoter=by_promoter,
    )


# ---------------------------------------------------------------------------
# Vista agregada del negocio ENTRE eventos: "este mes vendi X, asistieron Y,
# mi mejor promotor fue Z". Mismo criterio contable que el reporte por
# evento: boletas vivas (issued + redeemed) facturan; anuladas/reembolsadas
# no cuentan ni en dinero ni en rankings.
# ---------------------------------------------------------------------------
_OVERVIEW_SQL = """
    WITH month_events AS (
        SELECT id, name, capacity, status, starts_at
        FROM events
        WHERE venue_id = %(venue)s
          AND date_trunc('month', starts_at AT TIME ZONE %(tz)s)
                = date_trunc('month', %(month_start)s::timestamptz AT TIME ZONE %(tz)s)
    )
    SELECT
        (SELECT count(*) FROM month_events)::int AS events_count,
        count(t.id) FILTER (WHERE t.status IN ('issued','redeemed'))::int AS tickets_issued,
        count(t.id) FILTER (WHERE t.status = 'redeemed')::int AS tickets_redeemed,
        count(t.id) FILTER (WHERE t.status IN ('issued','redeemed')
                             AND t.price_cents_snapshot = 0)::int AS courtesy_tickets,
        coalesce(sum(t.price_cents_snapshot)
                 FILTER (WHERE t.status IN ('issued','redeemed')), 0)::bigint AS revenue_cents
    FROM month_events e
    LEFT JOIN tickets t ON t.event_id = e.id
"""

# Ranking de promotores del mes: por boletas vivas vendidas con SU cupo.
_TOP_PROMOTERS_SQL = """
    SELECT u.full_name AS name,
           count(t.id) FILTER (WHERE t.status IN ('issued','redeemed'))::int AS tickets,
           coalesce(sum(t.price_cents_snapshot)
                    FILTER (WHERE t.status IN ('issued','redeemed')), 0)::bigint AS revenue_cents
    FROM tickets t
    JOIN users u ON u.id = t.sold_by_user_id
    JOIN events e ON e.id = t.event_id
    WHERE e.venue_id = %(venue)s
      AND t.allocation_id IS NOT NULL
      AND date_trunc('month', e.starts_at AT TIME ZONE %(tz)s)
            = date_trunc('month', %(month_start)s::timestamptz AT TIME ZONE %(tz)s)
    GROUP BY u.id, u.full_name
    ORDER BY tickets DESC, revenue_cents DESC
    LIMIT 5
"""

# Top eventos del mes (para la mini-tabla con su aporte al mes).
_TOP_EVENTS_SQL = """
    SELECT e.id, e.name, e.starts_at, e.status,
           count(t.id) FILTER (WHERE t.status IN ('issued','redeemed'))::int AS tickets,
           coalesce(sum(t.price_cents_snapshot)
                    FILTER (WHERE t.status IN ('issued','redeemed')), 0)::bigint AS revenue_cents
    FROM events e
    LEFT JOIN tickets t ON t.event_id = e.id
    WHERE e.venue_id = %(venue)s
      AND date_trunc('month', e.starts_at AT TIME ZONE %(tz)s)
            = date_trunc('month', %(month_start)s::timestamptz AT TIME ZONE %(tz)s)
    GROUP BY e.id
    ORDER BY revenue_cents DESC, tickets DESC
    LIMIT 8
"""

# El mes anterior con LA MISMA métrica (tendencia real, no impresiones).
_PREV_SQL = """
    SELECT count(DISTINCT e.id)::int AS events_count,
           count(t.id) FILTER (WHERE t.status IN ('issued','redeemed'))::int AS tickets_issued,
           coalesce(sum(t.price_cents_snapshot)
                    FILTER (WHERE t.status IN ('issued','redeemed')), 0)::bigint AS revenue_cents
    FROM events e
    LEFT JOIN tickets t ON t.event_id = e.id
    WHERE e.venue_id = %(venue)s
      AND date_trunc('month', e.starts_at AT TIME ZONE %(tz)s)
            = date_trunc('month', (%(month_start)s::timestamptz - INTERVAL '1 month')
                         AT TIME ZONE %(tz)s)
"""


@router.get("/overview", response_model=VenueOverview)
async def venue_overview(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    month: str | None = None,
):
    """KPIs del negocio entre eventos, con tendencia y rankings.

    `?month=YYYY-MM` navega al histórico (default: el mes en curso). Solo
    staff: es la caja del negocio entero, no de un evento.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")

    tz = "America/Bogota"  # zona del negocio; los eventos la traen igual
    if month:
        try:
            year, mon = (int(x) for x in month.split("-"))
            if not 1 <= mon <= 12:
                raise ValueError
        except ValueError:
            raise HTTPException(400, "month debe ser YYYY-MM")
        month_start = datetime(year, mon, 1)
    else:
        now = datetime.now(ZoneInfo(tz))
        month_start = datetime(now.year, now.month, 1)
        month = f"{now.year:04d}-{now.month:02d}"

    params = {"venue": venue_id, "tz": tz, "month_start": month_start.isoformat()}

    async with db.cursor() as cur:
        await cur.execute(_OVERVIEW_SQL, params)
        agg = await cur.fetchone()
        await cur.execute(_PREV_SQL, params)
        prev = await cur.fetchone()
        await cur.execute(_TOP_PROMOTERS_SQL, params)
        top_promoters = await cur.fetchall()
        await cur.execute(_TOP_EVENTS_SQL, params)
        top_events = await cur.fetchall()

    revenue = agg["revenue_cents"]
    paid = agg["tickets_issued"] - agg["courtesy_tickets"]
    return VenueOverview(
        month=month,
        events_count=agg["events_count"],
        tickets_issued=agg["tickets_issued"],
        tickets_redeemed=agg["tickets_redeemed"],
        revenue_cents=revenue,
        courtesy_tickets=agg["courtesy_tickets"],
        # Promedio por boleta PAGA: las cortesías no deben diluir el promedio.
        avg_ticket_cents=round(revenue / paid) if paid > 0 else 0,
        prev_revenue_cents=prev["revenue_cents"],
        prev_tickets_issued=prev["tickets_issued"],
        prev_events_count=prev["events_count"],
        top_promoters=top_promoters,
        top_events=top_events,
    )
