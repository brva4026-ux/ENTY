"""Reporte en vivo del evento.

Dos vistas sobre los mismos datos:

- `EventReport` (`/report`): forma original. Solo admin/super_admin ven la
  caja completa y las ventas de cada promotor; el promotor recibe una
  vista recortada (ocupacion del evento + sus propios numeros, sin dinero
  global ni ventas de colegas). El bouncer no tiene acceso.
- `ReportSummary` (`/summary`): solo admin/super_admin. Agrega ingresos y
  la integridad de la puerta (que escaneos no cuadraron).
"""
import csv
import io
from datetime import datetime
from typing import Annotated
from zoneinfo import ZoneInfo

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.core.audit import write_audit
from app.schemas import EventReport, EventPulse, ReportByPromoter, ReportSummary, VenueOverview

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
    """Pulso del evento para su backstage.

    Matriz RBAC (docs/arquitectura/08-rbac.md):
    - admin: TODO (dinero incluido) y las ventas de cada promotor.
    - promotor: ocupacion del evento y su propio trabajo. El dinero global
      (recaudo, ventas por promotor) se oculta: saber cuanto recauda la
      fiesta o cuanto vendio un colega no aporta a su trabajo y si es
      sensible (quien se va a la competencia se lleva la cartera).
    - bouncer: SIN ACCESO. En puerta ninguna pregunta la responde este
      endpoint: su app es el escaner y no ve ventas.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    is_admin = bool(set(user["roles"].get(venue_id, [])) & {"super_admin", "admin"})

    if not is_admin:
        # Vista del promotor: ocupacion del evento + SOLO sus numeros. Cero
        # recaudo global, cero ventas de colegas (ni siquiera el agregado).
        async with db.cursor() as cur:
            ev = await _event_or_404(cur, event_id, venue_id)
            await cur.execute(
                "SELECT count(*)::int AS redeemed FROM tickets "
                "WHERE event_id=%s AND status='redeemed'",
                (event_id,),
            )
            event_redeemed = (await cur.fetchone())["redeemed"]
            await cur.execute(
                "SELECT coalesce(sum(price_cents_snapshot) "
                "FILTER (WHERE t.status IN ('issued','redeemed')), 0)::bigint AS mine, "
                "count(t.id) FILTER (WHERE t.status IN ('issued','redeemed'))::int AS issued, "
                "count(t.id) FILTER (WHERE t.status = 'redeemed')::int AS redeemed "
                "FROM tickets t WHERE t.event_id=%s AND t.sold_by_user_id=%s",
                (event_id, user["id"]),
            )
            mine = await cur.fetchone()
            await cur.execute(
                "SELECT coalesce(sum(capacity), 0)::int AS cap FROM promoter_allocations "
                "WHERE event_id=%s AND promoter_id=%s",
                (event_id, user["id"]),
            )
            my_cap = (await cur.fetchone())["cap"]

        return EventReport(
            event_id=ev["id"],
            event_name=ev["name"],
            capacity=ev["capacity"],
            issued=event_redeemed,
            redeemed=event_redeemed,
            pending=0,
            voided=0,
            occupancy_pct=(
                round(event_redeemed / ev["capacity"] * 100, 1) if ev["capacity"] else 0.0
            ),
            revenue_cents=mine["mine"],
            by_type=[],
            by_promoter=[
                ReportByPromoter(
                    promoter_id=user["id"],
                    full_name=user["full_name"],
                    capacity=my_cap,
                    issued=mine["issued"],
                    redeemed=mine["redeemed"],
                )
            ],
        )

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


@router.get("/events/{event_id}/pulse", response_model=EventPulse)
async def event_pulse(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Pulso del evento SIN dinero: para el reloj de la puerta y el nudge distintivo
    del promotor. El bouncer no ve recaudo; el promotor no ve el recaudo de colegas.
    Mismo criterio que el reporte: issued+redeemed son vivas, anuladas no."""
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, name, status, capacity FROM events WHERE id=%s AND venue_id=%s",
            (event_id, venue_id),
        )
        ev = await cur.fetchone()
        if not ev:
            raise HTTPException(404, "Evento no encontrado")

        await cur.execute(
            """
            SELECT count(*) FILTER (WHERE status IN ('issued','redeemed'))::int AS issued,
                   count(*) FILTER (WHERE status='redeemed')::int AS redeemed
            FROM tickets WHERE event_id=%s
            """,
            (event_id,),
        )
        tk = await cur.fetchone()

        # El aforo del bouncer es el que tiene asignado (mig 025). Si no tiene
        # grupo, el aforo es el del evento entero.
        bouncer_id = user.get("id")
        if bouncer_id:
            await cur.execute(
                "SELECT e.capacity FROM event_staff s "
                "JOIN events e ON e.id = s.event_id "
                "WHERE s.event_id=%s AND s.user_id=%s AND s.role='bouncer'",
                (event_id, bouncer_id),
            )
            ev_cap = await cur.fetchone()
            capacity = ev["capacity"] if ev_cap else ev["capacity"]

    return EventPulse(
        event_id=event_id,
        event_name=ev["name"],
        status=ev["status"],
        capacity=capacity,
        issued=tk["issued"],
        redeemed=tk["redeemed"],
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


def _resolve_month(month: str | None, tz: str) -> tuple[str, datetime]:
    """Valida `?month=YYYY-MM` y devuelve (etiqueta, month_start con zona).

    month_start lleva la ZONA del negocio adjunta: si viaja naive, Postgres
    lo interpreta como UTC y la medianoche del dia 1 en Bogota retrocede al
    ultimo dia del mes anterior (bug real: month=2026-10 agregaba
    septiembre).
    """
    tzinfo = ZoneInfo(tz)
    if month:
        try:
            year, mon = (int(x) for x in month.split("-"))
            if not 1 <= mon <= 12:
                raise ValueError
        except ValueError:
            raise HTTPException(400, "month debe ser YYYY-MM")
        month_start = datetime(year, mon, 1)
    else:
        now = datetime.now(tzinfo)
        month_start = datetime(now.year, now.month, 1)
        month = f"{now.year:04d}-{now.month:02d}"
    return month, month_start.replace(tzinfo=tzinfo)


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
    month, month_start = _resolve_month(month, tz)

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


@router.get("/overview.csv")
async def venue_overview_csv(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    month: str | None = None,
):
    """Resumen mensual exportable: la hoja que el contador abre sin login.

    Mismos criterios contables del JSON (boletas vivas facturan), dos secciones:
    KPIs del mes + eventos con su aporte. La tendencia va en una columna
    propia para que Excel/Sheets la pinte como número, no como texto.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")

    tz = "America/Bogota"
    month, month_start = _resolve_month(month, tz)
    params = {"venue": venue_id, "tz": tz, "month_start": month_start.isoformat()}

    async with db.cursor() as cur:
        await cur.execute(_OVERVIEW_SQL, params)
        agg = await cur.fetchone()
        await cur.execute(_PREV_SQL, params)
        prev = await cur.fetchone()
        await cur.execute(_TOP_EVENTS_SQL, params)
        events = await cur.fetchall()
        # Auditoria (mig 019): el resumen mensual es lo que se lleva el
        # contador — queda registrado quien lo exporto.
        await write_audit(
            cur, venue_id, user["id"], "export", "overview_csv", None,
            {"mes": month, "eventos": len(events)},
        )
        await db.commit()

    def money(cents) -> float:
        return round((cents or 0) / 100, 2)

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([f"Resumen del negocio - {month}"])
    w.writerow([])
    w.writerow(["Metrica", "Valor"])
    w.writerow(["Eventos del mes", agg["events_count"]])
    w.writerow(["Boletas vendidas", agg["tickets_issued"]])
    w.writerow(["Ingresaron", agg["tickets_redeemed"]])
    w.writerow(["Cortesias", agg["courtesy_tickets"]])
    w.writerow(["Recaudo (COP)", money(agg["revenue_cents"])])
    paid = agg["tickets_issued"] - agg["courtesy_tickets"]
    w.writerow(["Promedio por boleta paga (COP)", money(round(agg["revenue_cents"] / paid)) if paid else 0])
    if (prev["revenue_cents"] or 0) > 0:
        trend = round((agg["revenue_cents"] - prev["revenue_cents"]) / prev["revenue_cents"] * 100)
        w.writerow(["Tendencia vs mes anterior (%)", trend])
    w.writerow([])
    w.writerow(["Eventos del mes"])
    w.writerow(["Evento", "Fecha", "Estado", "Boletas", "Recaudo (COP)"])
    for e in events:
        w.writerow([
            e["name"],
            e["starts_at"].astimezone(ZoneInfo(tz)).strftime("%d/%m/%Y %H:%M"),
            e["status"],
            e["tickets"],
            money(e["revenue_cents"]),
        ])

    content = "\ufeff" + buf.getvalue()  # BOM: Excel/Sheets lo abren bien
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="resumen-{month}.csv"',
            "Cache-Control": "no-store",
        },
    )
