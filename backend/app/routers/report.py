"""Reporte en vivo del evento.

Dos vistas sobre los mismos datos:

- `EventReport` (`/report`): forma original. Solo admin/super_admin ven la
  caja completa y las ventas de cada promotor; el promotor recibe una
  vista recortada (ocupacion del evento + sus propios numeros, sin dinero
  global ni ventas de colegas). El bouncer no tiene acceso.
- `ReportSummary` (`/summary`): solo admin/super_admin. Agrega ingresos y
  la integridad de la puerta (que escaneos no cuadraron). Acepta
  `?since`/`?until` (ISO 8601) para cerrar la caja de un periodo —el mismo
  rango que ya tenia el registro de puerta— y `GET .../summary.csv` baja el
  mismo cierre como archivo, para el contador.
"""
import csv
import io
from datetime import datetime, timedelta
from typing import Annotated
from zoneinfo import ZoneInfo

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Response

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.core.audit import write_audit
from app.schemas import (
    EventReport,
    EventPulse,
    ReportByPromoter,
    ReportSummary,
    VenueDoor,
    VenueDoorEvent,
    VenueDoorScan,
    VenueDoorSlot,
    VenueOverview,
    VenuePromoter,
    VenuePromoters,
)

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
    LEFT JOIN tickets t ON t.ticket_type_id = tt.id AND t.event_id = %(ev)s
      AND (%(since)s::timestamptz IS NULL OR t.issued_at >= %(since)s::timestamptz)
      AND (%(until)s::timestamptz IS NULL OR t.issued_at <  %(until)s::timestamptz)
    WHERE tt.event_id = %(ev)s
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
      AND (%(since)s::timestamptz IS NULL OR t.issued_at >= %(since)s::timestamptz)
      AND (%(until)s::timestamptz IS NULL OR t.issued_at <  %(until)s::timestamptz)
    WHERE a.event_id = %(ev)s
    GROUP BY u.id, u.full_name, a.capacity
    ORDER BY u.full_name
"""


async def _event_or_404(cur, event_id: int, venue_id: int) -> dict:
    await cur.execute(
        "SELECT id, name, capacity, starts_at, event_timezone "
        "FROM events WHERE id=%s AND venue_id=%s",
        (event_id, venue_id),
    )
    ev = await cur.fetchone()
    if not ev:
        raise HTTPException(404, "Evento no encontrado")
    return ev


async def _by_status(
    cur, event_id: int, since: datetime | None = None, until: datetime | None = None
) -> dict[str, int]:
    await cur.execute(
        """
        SELECT status, count(*)::int AS n FROM tickets WHERE event_id=%(ev)s
          AND (%(since)s::timestamptz IS NULL OR issued_at >= %(since)s::timestamptz)
          AND (%(until)s::timestamptz IS NULL OR issued_at <  %(until)s::timestamptz)
        GROUP BY status
        """,
        {"ev": event_id, "since": since, "until": until},
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


# Ancho de la franja del ritmo de puerta. 10 min es la granularidad con la que
# un jefe de puerta decide: una franja vacia es "se atasco"; dos seguidas al
# tope es "abri el segundo lector".
PULSE_BUCKET_MINUTES = 10


async def _door_pulse(cur, event_id: int, starts_at, tz_name: str | None) -> list[dict]:
    """Ritmo de ingresos por franjas, en la hora LOCAL del evento.

    Solo cuentan los ingresos (granted): el ritmo es flujo de gente, no de
    intentos. Se recorta a 24 h desde el inicio para que una reconciliacion
    offline tardia (door_sync) no estire el eje de horas. Los huecos se
    rellenan con 0: la franja vacia ES el dato (la puerta se atoro).
    """
    if starts_at is None:
        return []
    tz = ZoneInfo(tz_name or "America/Bogota")
    await cur.execute(
        """
        SELECT floor(extract(epoch FROM (scanned_at - %s)) / 600)::int AS bucket,
               count(*)::int AS count
        FROM redemptions
        WHERE event_id = %s
          AND outcome IN ('granted', 'granted_forced')
          AND scanned_at >= %s
          AND scanned_at < %s + interval '24 hours'
        GROUP BY bucket ORDER BY bucket
        """,
        (starts_at, event_id, starts_at, starts_at),
    )
    rows = await cur.fetchall()
    if not rows:
        return []
    by_bucket = {r["bucket"]: r["count"] for r in rows}
    lo, hi = min(by_bucket), max(by_bucket)

    def _label(bucket: int) -> str:
        local = (starts_at + timedelta(minutes=bucket * PULSE_BUCKET_MINUTES)).astimezone(tz)
        return local.strftime("%H:%M")

    return [
        {"bucket": b, "label": _label(b), "count": by_bucket.get(b, 0)}
        for b in range(lo, hi + 1)
    ]


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

        await cur.execute(_BY_TYPE_SQL, {"ev": event_id, "since": None, "until": None})
        by_type = await cur.fetchall()

        await cur.execute(_BY_PROMOTER_SQL, {"ev": event_id, "since": None, "until": None})
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

        # Salud de puerta: qué pasó al escanear (redemptions), sin dinero.
        # `duplicates` = boletas que ya habían entrado (síntoma de QR
        # reenviado/clonado); `rejected` = todo lo demás que la puerta negó.
        await cur.execute(
            """
            SELECT count(*) FILTER (WHERE outcome='already_redeemed')::int AS duplicates,
                   count(*) FILTER (WHERE outcome NOT IN ('granted','granted_forced','already_redeemed'))::int AS rejected
            FROM redemptions WHERE event_id=%s
            """,
            (event_id,),
        )
        rd = await cur.fetchone()

        door_pulse = await _door_pulse(
            cur, event_id, ev["starts_at"], ev["event_timezone"]
        )

    return EventReport(
        event_id=ev["id"],
        event_name=ev["name"],
        capacity=ev["capacity"],
        **_totals(by_status, ev["capacity"]),
        revenue_cents=revenue,
        by_type=by_type,
        by_promoter=by_promoter,
        door_duplicates=rd["duplicates"],
        door_rejected=rd["rejected"],
        door_pulse=door_pulse,
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
    since: Annotated[datetime | None, Query()] = None,
    until: Annotated[datetime | None, Query()] = None,
):
    """Caja + integridad de puerta. Solo admin: expone los ingresos.

    `?since`/`?until` (ISO 8601) cierran la caja de un PERIODO, no solo de
    "ahora": mismo rango semiabierto que el registro de puerta. Sin rango,
    la caja es la de siempre (todo el evento).
    """
    ensure_roles(user, venue_id, "super_admin", "admin")

    async with db.cursor() as cur:
        ev = await _event_or_404(cur, event_id, venue_id)
        w = _caja_window(since, until, ev["event_timezone"])
        t_params = {"since": w["since"], "until": w["until"]}
        by_type_params = {**t_params, "ev": event_id}
        by_promoter_params = {**t_params, "ev": event_id}
        by_status = await _by_status(cur, event_id, w["since"], w["until"])

        await cur.execute(
            """
            SELECT coalesce(sum(price_cents_snapshot)
                            FILTER (WHERE status IN ('issued','redeemed')), 0)::bigint
                     AS revenue_cents,
                   count(*) FILTER (WHERE status IN ('issued','redeemed')
                                      AND price_cents_snapshot > 0)::int AS paid_tickets,
                   count(*) FILTER (WHERE status IN ('issued','redeemed')
                                      AND price_cents_snapshot = 0)::int AS courtesy_tickets
            FROM tickets WHERE event_id=%(ev)s
              AND (%(since)s::timestamptz IS NULL OR issued_at >= %(since)s::timestamptz)
              AND (%(until)s::timestamptz IS NULL OR issued_at <  %(until)s::timestamptz)
            """,
            t_params | {"ev": event_id},
        )
        money = await cur.fetchone()

        await cur.execute(_BY_TYPE_SQL, by_type_params)
        by_type = await cur.fetchall()

        await cur.execute(_BY_PROMOTER_SQL, by_promoter_params)
        by_promoter = await cur.fetchall()

        await cur.execute(
            """
            SELECT count(*) FILTER (WHERE outcome IN ('granted','granted_forced'))::int AS granted,
                   count(*) FILTER (WHERE outcome='already_redeemed')::int AS already_redeemed,
                   count(*) FILTER (WHERE outcome='not_found')::int        AS not_found,
                   count(*)::int                                           AS total,
                   max(scanned_at)                                         AS last_scan_at,
                   max(scanned_at) FILTER (WHERE outcome IN ('granted','granted_forced')) AS last_granted_at
            FROM redemptions WHERE event_id=%(ev)s
              AND (%(since)s::timestamptz IS NULL OR scanned_at >= %(since)s::timestamptz)
              AND (%(until)s::timestamptz IS NULL OR scanned_at <  %(until)s::timestamptz)
            """,
            t_params | {"ev": event_id},
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
            WHERE r.event_id=%(ev)s
              AND (%(since)s::timestamptz IS NULL OR r.scanned_at >= %(since)s::timestamptz)
              AND (%(until)s::timestamptz IS NULL OR r.scanned_at <  %(until)s::timestamptz)
            GROUP BY u.full_name ORDER BY total DESC
            """,
            t_params | {"ev": event_id},
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
        since=w["since"],
        until=w["until"],
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


@router.get("/events/{event_id}/summary.csv")
async def event_summary_csv(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    since: Annotated[datetime | None, Query()] = None,
    until: Annotated[datetime | None, Query()] = None,
):
    """Cierre de caja del evento en CSV, con el mismo rango que `/summary`.

    Es la version "papel" del resumen: la pantalla se pierde con el refresh,
    el contador abre el archivo. Mismos criterios contables (boletas vivas
    facturan) y misma integridad de puerta del JSON.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")

    async with db.cursor() as cur:
        ev = await _event_or_404(cur, event_id, venue_id)
        w = _caja_window(since, until, ev["event_timezone"])
        params = {"ev": event_id, "since": w["since"], "until": w["until"]}
        by_status = await _by_status(cur, event_id, w["since"], w["until"])
        await cur.execute(
            """
            SELECT coalesce(sum(price_cents_snapshot)
                            FILTER (WHERE status IN ('issued','redeemed')), 0)::bigint AS revenue_cents,
                   count(*) FILTER (WHERE status IN ('issued','redeemed')
                                      AND price_cents_snapshot > 0)::int AS paid,
                   count(*) FILTER (WHERE status IN ('issued','redeemed')
                                      AND price_cents_snapshot = 0)::int AS courtesy
            FROM tickets WHERE event_id=%(ev)s
              AND (%(since)s::timestamptz IS NULL OR issued_at >= %(since)s::timestamptz)
              AND (%(until)s::timestamptz IS NULL OR issued_at <  %(until)s::timestamptz)
            """,
            params,
        )
        money = await cur.fetchone()
        await cur.execute(_BY_TYPE_SQL, params)
        by_type = await cur.fetchall()
        await cur.execute(_BY_PROMOTER_SQL, params)
        by_promoter = await cur.fetchall()
        await cur.execute(
            """
            SELECT count(*) FILTER (WHERE outcome IN ('granted','granted_forced'))::int AS granted,
                   count(*) FILTER (WHERE outcome='already_redeemed')::int AS already_redeemed,
                   count(*) FILTER (WHERE outcome='not_found')::int        AS not_found,
                   count(*)::int                                           AS total
            FROM redemptions WHERE event_id=%(ev)s
              AND (%(since)s::timestamptz IS NULL OR scanned_at >= %(since)s::timestamptz)
              AND (%(until)s::timestamptz IS NULL OR scanned_at <  %(until)s::timestamptz)
            """,
            params,
        )
        door = await cur.fetchone()
        # Auditoria (mig 019): el cierre de caja es dato financiero; queda
        # registrado quien lo exporto y con que rango.
        await write_audit(
            cur, venue_id, user["id"], "export", "summary_csv", event_id,
            {
                "evento": ev["name"],
                "desde": w["since"].isoformat() if w["since"] else None,
                "hasta": w["until"].isoformat() if w["until"] else None,
            },
        )
        await db.commit()

    tz = ZoneInfo(ev["event_timezone"] or "America/Bogota")

    def _local(dt: datetime | None) -> str:
        return dt.astimezone(tz).strftime("%d/%m/%Y %H:%M") if dt else ""

    def money_cop(cents: int) -> float:
        return round((cents or 0) / 100, 2)

    live = by_status.get("issued", 0) + by_status.get("redeemed", 0)
    paid = money["paid"]
    revenue = money["revenue_cents"]

    buf = io.StringIO()
    wtr = csv.writer(buf)
    wtr.writerow([f"Cierre de caja - {ev['name']}"])
    if w["since"] or w["until"]:
        wtr.writerow(["Periodo", _local(w["since"]) or "(inicio)", _local(w["until"]) or "(ahora)"])
    wtr.writerow([])
    wtr.writerow(["Caja", ""])
    wtr.writerow(["Recaudo (COP)", money_cop(revenue)])
    wtr.writerow(["Boletas vivas", live])
    wtr.writerow(["Ingresaron", by_status.get("redeemed", 0)])
    wtr.writerow(["Pendientes", live - by_status.get("redeemed", 0)])
    wtr.writerow(["Boletas pagas", paid])
    wtr.writerow(["Cortesias", money["courtesy"]])
    wtr.writerow(["Anuladas", by_status.get("voided", 0)])
    wtr.writerow(["Promedio por boleta paga (COP)", money_cop(round(revenue / paid)) if paid else 0])
    wtr.writerow([])
    wtr.writerow(["Puerta", "Entras", "Rechazadas", "Total escaneos"])
    granted = door["granted"]
    wtr.writerow(["(todas)", granted, door["total"] - granted, door["total"]])
    wtr.writerow(["  Duplicadas", "", door["already_redeemed"], ""])
    wtr.writerow(["  No encontradas", "", door["not_found"], ""])
    wtr.writerow([])
    wtr.writerow(["Por tipo", "Vendidas", "Ingresaron", "Recaudo (COP)"])
    for t in by_type:
        wtr.writerow([t["name"], t["issued"], t["redeemed"], money_cop(t["revenue_cents"])])
    wtr.writerow([])
    wtr.writerow(["Por promotor", "Cupo", "Vendidas", "Ingresaron", "Anuladas"])
    for p in by_promoter:
        wtr.writerow([p["full_name"], p["capacity"], p["issued"], p["redeemed"], p["voided"]])

    content = "\ufeff" + buf.getvalue()  # BOM: Excel/Sheets lo abren bien
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="caja-evento-{event_id}.csv"',
            "Cache-Control": "no-store",
        },
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
                    FILTER (WHERE t.status IN ('issued','redeemed')), 0)::bigint AS revenue_cents,
           -- En el MVP el promotor solo mueve cortesías (emit_ticket prohíbe
           -- atar una boleta de pago a un cupo), así que la UI rankea por
           -- boletas y este flag le dice si además hubo dinero que mostrar.
           bool_or(t.price_cents_snapshot = 0) FILTER (
               WHERE t.status IN ('issued','redeemed')) AS has_courtesy
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

# Comisiones del mes: liquidaciones de promotores generadas en el mes.
# La comisión del promotor sale de su venta (boletas vivas), que en el MVP
# solo puede ser cortesía — emit_ticket rechaza atar una boleta de pago a un
# cupo. Por eso puede venir NULL: no hay liquidaciones, no "comisión cero".
# Sin coalesce a propósito: sum() sobre cero filas es NULL y sobre filas que
# suman 0 es 0; esa diferencia es la que la UI necesita.
_COMMISSIONS_SQL = """
    SELECT sum(commission_cents)::bigint AS commissions_cents
    FROM promoter_payouts
    WHERE venue_id = %(venue)s
      AND date_trunc('month', created_at AT TIME ZONE %(tz)s)
            = date_trunc('month', %(month_start)s::timestamptz AT TIME ZONE %(tz)s)
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

# Curva de venta del mes: cuánto tiempo ANTES de la noche se vendió cada
# boleta viva. Es la métrica que ninguna otra vista responde: el total dice
# CUÁNTO se vendió; esto dice CUÁNDO. Una boleta emitida después del inicio
# (venta de puerta) cae en '0-1': la resta da negativo y el ELSE la recoge.
# La escala es en días de anticipación, del más lejano al más cercano.
_SALES_CURVE_SQL = """
    WITH month_events AS (
        SELECT id, starts_at FROM events
        WHERE venue_id = %(venue)s
          AND date_trunc('month', starts_at AT TIME ZONE %(tz)s)
                = date_trunc('month', %(month_start)s::timestamptz AT TIME ZONE %(tz)s)
    )
    SELECT CASE
             WHEN extract(epoch FROM (e.starts_at - t.issued_at)) >= 30*86400 THEN '30+'
             WHEN extract(epoch FROM (e.starts_at - t.issued_at)) >= 15*86400 THEN '15-29'
             WHEN extract(epoch FROM (e.starts_at - t.issued_at)) >= 8*86400  THEN '8-14'
             WHEN extract(epoch FROM (e.starts_at - t.issued_at)) >= 2*86400  THEN '2-7'
             ELSE '0-1' END AS bucket,
           count(*)::int AS tickets,
           coalesce(sum(t.price_cents_snapshot), 0)::bigint AS revenue_cents
    FROM month_events e
    JOIN tickets t ON t.event_id = e.id
    WHERE t.status IN ('issued','redeemed')
    GROUP BY bucket
"""

# Retención: de los compradores del mes (identificados por teléfono, el único
# dato que se captura siempre), cuántos ya le habían comprado a ESTE venue
# antes. El teléfono se normaliza a sus últimos 10 dígitos para que
# '3001234567' y '573001234567' sean el mismo cliente (los dos formatos
# conviven en la tabla). Los compradores sin teléfono quedan fuera del
# denominador: no se puede saber si repiten, y contarlos como nuevos
# inflaría la cifra de "nuevos" con datos que no existen.
_RETENTION_SQL = r"""
    WITH month_buyers AS (
        SELECT right(regexp_replace(t.customer_phone, '\D', '', 'g'), 10) AS phone,
               min(t.issued_at) AS first_at
        FROM tickets t
        JOIN events e ON e.id = t.event_id
        WHERE e.venue_id = %(venue)s
          AND t.status IN ('issued','redeemed')
          AND t.customer_phone IS NOT NULL
          AND btrim(t.customer_phone) <> ''
          AND date_trunc('month', e.starts_at AT TIME ZONE %(tz)s)
                = date_trunc('month', %(month_start)s::timestamptz AT TIME ZONE %(tz)s)
        GROUP BY phone
    )
    SELECT count(*)::int AS buyers,
           count(*) FILTER (WHERE EXISTS (
               SELECT 1
               FROM tickets t2
               JOIN events e2 ON e2.id = t2.event_id
               WHERE e2.venue_id = %(venue)s
                 AND t2.status IN ('issued','redeemed')
                 AND right(regexp_replace(t2.customer_phone, '\D', '', 'g'), 10)
                     = month_buyers.phone
                 AND t2.issued_at < month_buyers.first_at
           ))::int AS returning_buyers
    FROM month_buyers
"""

# Orden de presentación de la curva: del más anticipado al más tardío. El
# backend devuelve SIEMPRE los 5 tramos (rellenando con 0) para que la UI no
# tenga que inventar el eje ni reordenar filas.
_SALES_CURVE_ORDER = ["30+", "15-29", "8-14", "2-7", "0-1"]


def _caja_window(
    since: datetime | None, until: datetime | None, tz_name: str | None
) -> dict:
    """Ventana de caja: `{since, until}` para el `WHERE` (None = sin limite).

    Mismo contrato que el registro de puerta (`/redemptions`): un rango
    semiabierto [since, until) sobre `issued_at`/`scanned_at`. Un datetime
    SIN zona se interpreta en la zona del negocio, no en UTC (la misma
    leccion de `_resolve_month`: "2026-10-01" es medianoche en Bogota, no
    en Greenwich). Sin parametros la caja es la de SIEMPRE (todo el evento).
    """
    tz = ZoneInfo(tz_name or "America/Bogota")

    def _fix(dt: datetime | None) -> datetime | None:
        if dt is None:
            return None
        return dt.replace(tzinfo=tz) if dt.tzinfo is None else dt

    since, until = _fix(since), _fix(until)
    if since is not None and until is not None and until < since:
        raise HTTPException(422, "El fin del periodo no puede ser anterior al inicio")
    return {"since": since, "until": until}


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
        await cur.execute(_COMMISSIONS_SQL, params)
        commissions = await cur.fetchone()
        await cur.execute(_SALES_CURVE_SQL, params)
        curve_rows = await cur.fetchall()
        await cur.execute(_RETENTION_SQL, params)
        retention = await cur.fetchone()

    # La curva viaja con sus 5 tramos SIEMPRE, rellenos con 0 donde no hubo
    # venta: el tramo vacío es el dato (nadie compró con 30 días de
    # anticipación), no una fila que la UI deba inventar.
    curve_by_bucket = {r["bucket"]: r for r in curve_rows}
    sales_curve = [
        {
            "bucket": b,
            "tickets": curve_by_bucket.get(b, {}).get("tickets", 0),
            "revenue_cents": curve_by_bucket.get(b, {}).get("revenue_cents", 0),
        }
        for b in _SALES_CURVE_ORDER
    ]

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
        # Si no hay liquidaciones, el agregado devuelve 0 filas-sumadas; se
        # expone como null para que la UI no invente un neto.
        commissions_cents=(
            commissions["commissions_cents"]
            if commissions and commissions["commissions_cents"] is not None
            else None
        ),
        sales_curve=sales_curve,
        retention_buyers=retention["buyers"] if retention else 0,
        retention_returning=retention["returning_buyers"] if retention else 0,
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
        await cur.execute(_SALES_CURVE_SQL, params)
        curve_rows = await cur.fetchall()
        # Auditoria (mig 019): el resumen mensual es lo que se lleva el
        # contador — queda registrado quien lo exporto.
        await write_audit(
            cur, venue_id, user["id"], "export", "overview_csv", None,
            {"mes": month, "eventos": len(events)},
        )
        await db.commit()

    curve_by_bucket = {r["bucket"]: r for r in curve_rows}

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
    # Ritmo de venta: cuándo se vendió, no cuánto. Una sección aparte porque
    # es una serie, no un escalar; el contador la lee fila a fila.
    w.writerow(["Ritmo de venta (días antes del evento)"])
    w.writerow(["Anticipacion", "Boletas", "Recaudo (COP)"])
    for b in _SALES_CURVE_ORDER:
        row = curve_by_bucket.get(b, {})
        w.writerow([b, row.get("tickets", 0), money(row.get("revenue_cents", 0))])
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


# Noches con puerta abierta o por abrir: las 'live' primero (son las que
# estan pasando), despues las publicadas por cercania. El LIMIT evita que un
# venue con cientos de eventos historicos devuelva una lista inmanejable.
_DOOR_EVENTS_SQL = """
    SELECT e.id AS event_id, e.name, e.starts_at, e.status, e.capacity,
           count(t.id) FILTER (WHERE t.status IN ('issued','redeemed'))::int AS issued,
           count(t.id) FILTER (WHERE t.status = 'redeemed')::int AS redeemed
    FROM events e
    LEFT JOIN tickets t ON t.event_id = e.id
    WHERE e.venue_id = %(venue)s
      AND e.status IN ('live', 'published')
    GROUP BY e.id
    ORDER BY (e.status = 'live') DESC, e.starts_at DESC
    LIMIT 20
"""

# Ritmo de entrada: escaneos GRANTED por franja de 30 min en las ultimas 6 h
# de cada noche en vivo. Solo granted: un rechazo no es alguien que entro, y
# mezclarlos convertiria el pulso en una mentira. Los huecos vuelven como
# cero (generate_series) para que la barra dibuje el silencio, no lo salte.
_DOOR_RHYTHM_SQL = """
    WITH live AS (
        SELECT id, starts_at FROM events
        WHERE venue_id = %(venue)s AND status = 'live'
    ),
    bounds AS (
        SELECT greatest(coalesce(max(r.scanned_at), now()),
                        coalesce(max(l.starts_at), now())) AS t_end
        FROM live l
        LEFT JOIN redemptions r ON r.event_id = l.id
    ),
    slots AS (
        SELECT generate_series(
                 date_trunc('hour', b.t_end - interval '5 hours 30 minutes'),
                 date_trunc('hour', b.t_end) + interval '30 minutes',
                 interval '30 minutes'
               ) AS slot
        FROM bounds b
    ),
    hits AS (
        SELECT date_trunc('hour', r.scanned_at)
                 + floor(extract(minute FROM r.scanned_at) / 30) * interval '30 minutes' AS slot,
               count(*)::int AS n
        FROM redemptions r
        JOIN live l ON l.id = r.event_id
        WHERE r.outcome IN ('granted', 'granted_forced')
          AND r.scanned_at >= now() - interval '6 hours'
        GROUP BY 1
    )
    SELECT s.slot AS at, coalesce(h.n, 0)::int AS n
    FROM slots s
    LEFT JOIN hits h ON h.slot = s.slot
    ORDER BY s.slot
"""

# Los ultimos escaneos de las noches en vivo, para la cola de puerta. El
# nombre se expone igual que en /redemptions (el admin ya lo ve); el hash de
# la boleta NO sale de aqui.
_DOOR_RECENT_SQL = """
    SELECT r.scanned_at,
           r.outcome,
           t.customer_name,
           tt.name AS type_name,
           u.full_name AS scanned_by
    FROM redemptions r
    JOIN events e ON e.id = r.event_id AND e.status = 'live'
    LEFT JOIN tickets t ON t.id = r.ticket_id
    LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
    LEFT JOIN users u ON u.id = r.scanned_by_user_id
    WHERE e.venue_id = %(venue)s
    ORDER BY r.scanned_at DESC, r.id DESC
    LIMIT 12
"""

# Agregados SOLO de las noches en vivo. Van en subconsultas sobre un CTE en
# vez de un JOIN: sumar capacity sobre un join con tickets multiplicaria el
# aforo por el numero de boletas (error clasico de fan-out).
_DOOR_LIVE_SQL = """
    WITH live AS (
        SELECT id, capacity FROM events
        WHERE venue_id = %(venue)s AND status = 'live'
    )
    SELECT (SELECT count(*) FROM live)::int AS live_events,
           (SELECT coalesce(sum(capacity), 0) FROM live)::int AS live_capacity,
           (SELECT count(*) FROM tickets t JOIN live l ON l.id = t.event_id
             WHERE t.status IN ('issued','redeemed'))::int AS live_issued,
           (SELECT count(*) FROM tickets t JOIN live l ON l.id = t.event_id
             WHERE t.status = 'redeemed')::int AS live_redeemed,
           (SELECT count(*) FROM redemptions r JOIN live l ON l.id = r.event_id
             WHERE r.outcome = 'already_redeemed')::int AS duplicates,
           (SELECT count(*) FROM redemptions r JOIN live l ON l.id = r.event_id
             WHERE r.outcome NOT IN ('granted','granted_forced','already_redeemed'))::int
             AS rejected,
           (SELECT max(r.scanned_at) FROM redemptions r JOIN live l ON l.id = r.event_id)
             AS last_scan_at
"""

# Promotores del mes con cupo, avance y comision. Mismo criterio de "boleta
# viva" que el resto del reporte. El cupo sale de promoter_allocations (la
# tabla que define CUANTO puede colocar cada promotor), que es justo lo que
# _TOP_PROMOTERS_SQL no miraba: daba el ranking en boletas pero no contra
# cuanto cupo, asi que no se podia ver quien iba cumpliendo.
_PROMOTERS_SQL = """
    WITH month_events AS (
        SELECT id FROM events
        WHERE venue_id = %(venue)s
          AND date_trunc('month', starts_at AT TIME ZONE %(tz)s)
              = date_trunc('month', %(month_start)s::timestamptz AT TIME ZONE %(tz)s)
    ),
    caps AS (
        SELECT a.promoter_id, coalesce(sum(a.capacity), 0)::int AS capacity
        FROM promoter_allocations a
        JOIN month_events me ON me.id = a.event_id
        WHERE a.is_active
        GROUP BY a.promoter_id
    ),
    sold AS (
        SELECT t.sold_by_user_id AS promoter_id,
               count(t.id) FILTER (WHERE t.status IN ('issued','redeemed'))::int AS issued,
               count(t.id) FILTER (WHERE t.status = 'redeemed')::int AS redeemed,
               coalesce(sum(t.price_cents_snapshot)
                        FILTER (WHERE t.status IN ('issued','redeemed')), 0)::bigint
                 AS revenue_cents,
               bool_or(t.price_cents_snapshot = 0)
                        FILTER (WHERE t.status IN ('issued','redeemed')) AS has_courtesy
        FROM tickets t
        JOIN month_events me ON me.id = t.event_id
        WHERE t.allocation_id IS NOT NULL
        GROUP BY t.sold_by_user_id
    ),
    comm AS (
        SELECT promoter_id, coalesce(sum(commission_cents), 0)::bigint AS commission_cents
        FROM promoter_payouts
        WHERE venue_id = %(venue)s
          AND date_trunc('month', created_at AT TIME ZONE %(tz)s)
              = date_trunc('month', %(month_start)s::timestamptz AT TIME ZONE %(tz)s)
        GROUP BY promoter_id
    )
    SELECT u.id AS promoter_id, u.full_name AS name,
           coalesce(c.capacity, 0)::int AS capacity,
           coalesce(s.issued, 0)::int AS issued,
           coalesce(s.redeemed, 0)::int AS redeemed,
           coalesce(s.revenue_cents, 0)::bigint AS revenue_cents,
           coalesce(cm.commission_cents, 0)::bigint AS commission_cents,
           coalesce(s.has_courtesy, false) AS has_courtesy
    FROM users u
    LEFT JOIN caps c ON c.promoter_id = u.id
    LEFT JOIN sold s ON s.promoter_id = u.id
    LEFT JOIN comm cm ON cm.promoter_id = u.id
    WHERE c.promoter_id IS NOT NULL OR s.promoter_id IS NOT NULL
    ORDER BY coalesce(s.issued, 0) DESC, coalesce(s.revenue_cents, 0) DESC
    LIMIT 50
"""


@router.get("/door", response_model=VenueDoor)
async def venue_door(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """La puerta del venue ENTERO, sin abrir una noche.

    El detalle por evento ya existia (`/pulse`, `/report`, `/redemptions`),
    pero obliga a elegir un evento. El admin que llega al panel quiere saber
    primero QUE esta pasando: cuantas noches estan en vivo, cuanta gente
    entro y si la puerta esta rechazando. Sin dinero: es operacion, no caja.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")

    params = {"venue": venue_id}
    async with db.cursor() as cur:
        await cur.execute(_DOOR_LIVE_SQL, params)
        live = await cur.fetchone()
        await cur.execute(_DOOR_EVENTS_SQL, params)
        events = await cur.fetchall()
        # Ritmo y cola: solo tienen sentido con una noche en vivo. Sin ella se
        # evitan dos consultas que devolverian series vacias o basura vieja.
        rhythm = []
        recent = []
        if live["live_events"]:
            await cur.execute(_DOOR_RHYTHM_SQL, params)
            rhythm = await cur.fetchall()
            await cur.execute(_DOOR_RECENT_SQL, params)
            recent = await cur.fetchall()

    return VenueDoor(
        live_events=live["live_events"],
        live_capacity=live["live_capacity"],
        live_issued=live["live_issued"],
        live_redeemed=live["live_redeemed"],
        duplicates=live["duplicates"],
        rejected=live["rejected"],
        last_scan_at=live["last_scan_at"],
        rhythm=[VenueDoorSlot(**r) for r in rhythm],
        recent_scans=[VenueDoorScan(**r) for r in recent],
        events=[VenueDoorEvent(**e) for e in events],
    )


@router.get("/promoters", response_model=VenuePromoters)
async def venue_promoters(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    month: str | None = None,
):
    """El equipo de promotores del mes: cupo, avance y comision.

    `top_promoters` del overview da el ranking en boletas, pero sin el cupo
    asignado no se puede saber quien va CUMPLIENDO. Aqui el cupo viene de
    `promoter_allocations` y el avance se calcula contra el.

    `advance_pct` es 0 cuando no hay cupo asignado (no 100 ni null): un
    promotor sin cupo no tiene avance que medir, y la UI lo muestra sin
    barra en vez de con una barra llena que mentiria.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")

    tz = "America/Bogota"
    month, month_start = _resolve_month(month, tz)
    params = {"venue": venue_id, "tz": tz, "month_start": month_start.isoformat()}

    async with db.cursor() as cur:
        await cur.execute(_PROMOTERS_SQL, params)
        rows = await cur.fetchall()

    promoters = [
        VenuePromoter(
            **{
                **r,
                "advance_pct": (
                    round(r["issued"] / r["capacity"] * 100, 1)
                    if r["capacity"] > 0
                    else 0.0
                ),
            }
        )
        for r in rows
    ]

    return VenuePromoters(
        month=month,
        promoters=promoters,
        capacity_total=sum(p.capacity for p in promoters),
        commission_cents=sum(p.commission_cents for p in promoters),
    )
