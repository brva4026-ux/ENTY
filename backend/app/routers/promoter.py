"""Espacio de promotor: asignaciones, ventas, links y comisiones.

Todo lo que devuelve este router está acotado al promotor autenticado:
* solo ve eventos donde tiene asignación, cupo o boletas propias;
* solo ve boletas que él emitió o que se atribuyeron a su link;
* las comisiones se leen de sus propias liquidaciones.

La seguridad real vive aquí, no en la UI. El frontend puede ocultar una
acción, pero cada endpoint vuelve a comprobar rol y pertenencia.
"""
import re
import secrets
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.config import get_settings
from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    PayoutOut,
    PromoterCommissionPayoutOut,
    PromoterCommissionsOut,
    PromoterEventDetailOut,
    PromoterEventOut,
    PromoterIssueCreate,
    PromoterIssueOut,
    PromoterLinkOut,
    PromoterPayoutDetailOut,
    PromoterPayoutItemOut,
    PromoterSaleDetailOut,
    PromoterSaleOut,
    PromoterSalesOut,
    PromoterTypeOut,
)

router = APIRouter(prefix="/venues/{venue_id}", tags=["promotor"])

LIVE_STATUSES = ("issued", "redeemed")
SELLABLE_STATUSES = ("published", "live")


def _digits(value: str | None) -> str:
    return re.sub(r"\D", "", value or "")


def _sell_reason(status_: str, assignment_active: bool, types: list[dict]) -> str | None:
    if not assignment_active:
        return "assignment_removed"
    if status_ == "draft":
        return "not_open"
    if status_ == "ended":
        return "ended"
    if status_ == "cancelled":
        return "cancelled"
    if status_ not in SELLABLE_STATUSES:
        return "not_open"
    if not types:
        return "no_types"
    if not any(t["modes"] for t in types):
        return "sold_out"
    return None


def _type_row(row: dict, event_status: str, assignment_active: bool) -> PromoterTypeOut:
    global_issued = int(row["global_issued"] or 0)
    pending = int(row["pending_reserved"] or 0)
    my_capacity = int(row["my_capacity"] or 0)
    my_issued = int(row["my_issued"] or 0)
    available = max(int(row["quantity"] or 0) - global_issued - pending, 0)
    my_remaining = max(my_capacity - my_issued, 0)
    modes: list[str] = []
    if assignment_active and event_status in SELLABLE_STATUSES and available > 0:
        if row["price_cents"] > 0:
            # Las boletas pagadas no se atan a un cupo de cortesía: son venta
            # directa atribuida al promotor.
            modes = ["venue"]
        elif my_capacity > 0:
            if my_remaining > 0:
                modes = ["quota"]
        else:
            # Sin cupo asignado el servidor permite emitir a nombre de la
            # organización. Se muestra como modo explícito, no como error.
            modes = ["venue"]
    return PromoterTypeOut(
        id=row["id"],
        name=row["name"],
        price_cents=int(row["price_cents"] or 0),
        quantity=int(row["quantity"] or 0),
        is_courtesy=bool(row["is_courtesy"]),
        is_active=bool(row["is_active"]),
        global_issued=global_issued,
        pending_reserved=pending,
        available=available,
        my_capacity=my_capacity,
        my_issued=my_issued,
        my_remaining=my_remaining,
        modes=modes,
    )


async def _events(cur, venue_id: int, promoter_id: int, event_id: int | None = None):
    extra = " AND e.id = %s" if event_id is not None else ""
    params: list = [promoter_id, promoter_id, venue_id]
    if event_id is not None:
        params.append(event_id)
    await cur.execute(
        f"""
        SELECT e.id, e.venue_id, e.name, e.category, e.flyer_url, e.starts_at,
               e.ends_at, e.location, e.status, e.capacity, e.description,
               e.doors_open_at, e.dress_code, e.min_age, e.location_url,
               e.contact_name, e.contact_phone,
               v.name AS venue_name, v.currency,
               (s.user_id IS NOT NULL) AS assignment_active,
               coalesce(a.capacity, 0)::int AS my_capacity,
               (SELECT count(*)::int FROM tickets t
                 WHERE t.event_id = e.id AND t.sold_by_user_id = %s
                   AND t.status IN ('issued','redeemed')) AS my_issued,
               (SELECT count(*)::int FROM tickets t
                 WHERE t.event_id = e.id AND t.sold_by_user_id = %s
                   AND t.status = 'redeemed') AS my_redeemed,
               (SELECT count(*)::int FROM tickets t
                 WHERE t.event_id = e.id AND t.sold_by_user_id = %s
                   AND t.status IN ('issued','redeemed')
                   AND t.sale_channel = 'promoter_link') AS link_sold,
               (SELECT count(*)::int FROM tickets t
                 WHERE t.event_id = e.id AND t.sold_by_user_id = %s
                   AND t.status IN ('issued','redeemed')
                   AND t.sale_channel IN ('promoter_direct','promoter_quota')) AS direct_sold
          FROM events e
          JOIN venues v ON v.id = e.venue_id
          LEFT JOIN event_staff s
                 ON s.event_id = e.id AND s.user_id = %s AND s.role = 'promotor'
          LEFT JOIN LATERAL (
              SELECT sum(pa.capacity)::int AS capacity
                FROM promoter_allocations pa
               WHERE pa.event_id = e.id AND pa.promoter_id = %s AND pa.is_active
          ) a ON true
         WHERE e.venue_id = %s
           AND (s.user_id IS NOT NULL
                OR EXISTS (SELECT 1 FROM promoter_allocations pa
                            WHERE pa.event_id = e.id AND pa.promoter_id = %s)
                OR EXISTS (SELECT 1 FROM tickets t
                            WHERE t.event_id = e.id AND t.sold_by_user_id = %s))
           {extra}
         ORDER BY CASE e.status WHEN 'live' THEN 0 WHEN 'published' THEN 1
                                WHEN 'draft' THEN 2 ELSE 3 END,
                  e.starts_at ASC
        """,
        (
            promoter_id,
            promoter_id,
            promoter_id,
            promoter_id,
            promoter_id,
            promoter_id,
            venue_id,
            promoter_id,
            promoter_id,
            *([event_id] if event_id is not None else []),
        ),
    )
    return await cur.fetchall()


async def _build_events(cur, rows, promoter_id: int) -> list[PromoterEventOut]:
    if not rows:
        return []
    event_ids = [r["id"] for r in rows]
    await cur.execute(
        """
        SELECT tt.id, tt.event_id, tt.name, tt.price_cents, tt.quantity,
               tt.is_courtesy, tt.is_active,
               (SELECT count(*)::int FROM tickets t
                 WHERE t.ticket_type_id = tt.id
                   AND t.status NOT IN ('voided','refunded')) AS global_issued,
               (SELECT count(*)::int FROM ticket_payments p
                 WHERE p.ticket_type_id = tt.id AND p.status = 'pending'
                   AND p.reservation_expires_at > now()) AS pending_reserved,
               coalesce(a.capacity, 0)::int AS my_capacity,
               (SELECT count(*)::int FROM tickets t
                 WHERE t.ticket_type_id = tt.id AND t.sold_by_user_id = %s
                   AND t.status IN ('issued','redeemed')) AS my_issued
          FROM ticket_types tt
          LEFT JOIN promoter_allocations a
                 ON a.ticket_type_id = tt.id AND a.promoter_id = %s
                AND a.is_active
         WHERE tt.event_id = ANY(%s)
         ORDER BY tt.price_cents, tt.id
        """,
        (promoter_id, promoter_id, event_ids),
    )
    type_rows = await cur.fetchall()
    by_event: dict[int, list[PromoterTypeOut]] = {eid: [] for eid in event_ids}
    for r in type_rows:
        parent = next(e for e in rows if e["id"] == r["event_id"])
        by_event[r["event_id"]].append(
            _type_row(r, parent["status"], parent["assignment_active"])
        )

    out: list[PromoterEventOut] = []
    for r in rows:
        types = by_event.get(r["id"], [])
        reason = _sell_reason(r["status"], r["assignment_active"], [t.model_dump() for t in types])
        out.append(
            PromoterEventOut(
                id=r["id"],
                venue_id=r["venue_id"],
                venue_name=r["venue_name"],
                name=r["name"],
                category=r["category"],
                flyer_url=r["flyer_url"],
                starts_at=r["starts_at"],
                ends_at=r["ends_at"],
                location=r["location"],
                status=r["status"],
                capacity=r["capacity"],
                assignment_active=bool(r["assignment_active"]),
                my_capacity=r["my_capacity"] or 0,
                my_issued=r["my_issued"] or 0,
                my_redeemed=r["my_redeemed"] or 0,
                link_sold=r["link_sold"] or 0,
                direct_sold=r["direct_sold"] or 0,
                available_total=sum(t.available for t in types),
                can_sell=reason is None,
                sell_reason=reason,
                ticket_types=types,
            )
        )
    return out


@router.get("/promoter/events", response_model=list[PromoterEventOut])
async def promoter_events(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Todas las asignaciones autorizadas, incluidas las que ya no pueden vender.

    Un evento con asignación retirada sigue apareciendo si el promotor tiene
    boletas emitidas: su historial no desaparece con el roster.
    """
    ensure_roles(user, venue_id, "promotor")
    async with db.cursor() as cur:
        rows = await _events(cur, venue_id, user["id"])
        return await _build_events(cur, rows, user["id"])


@router.get("/promoter/events/{event_id}", response_model=PromoterEventDetailOut)
async def promoter_event_detail(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "promotor")
    async with db.cursor() as cur:
        rows = await _events(cur, venue_id, user["id"], event_id=event_id)
        if not rows:
            raise HTTPException(404, "Evento no encontrado o sin acceso")
        [event] = await _build_events(cur, rows, user["id"])
        r = rows[0]
        await cur.execute(
            """
            SELECT a.id, a.event_id, a.ticket_type_id, a.promoter_id,
                   a.capacity, a.is_active,
                   (SELECT count(*)::int FROM tickets t
                     WHERE t.allocation_id = a.id
                       AND t.status NOT IN ('voided','refunded')) AS issued
              FROM promoter_allocations a
             WHERE a.event_id = %s AND a.promoter_id = %s
             ORDER BY a.id
            """,
            (event_id, user["id"]),
        )
        allocations = await cur.fetchall()
    return PromoterEventDetailOut(
        **event.model_dump(),
        description=r["description"],
        doors_open_at=r["doors_open_at"],
        dress_code=r["dress_code"],
        min_age=r["min_age"],
        location_url=r["location_url"],
        contact_name=r["contact_name"],
        contact_phone=r["contact_phone"],
        currency=r["currency"],
        public_path=f"/evento/{event_id}",
        allocations=allocations,
    )


def _sale_payment_state(row: dict) -> str:
    if row["status"] in ("voided", "refunded"):
        return row["status"]
    if row["price_cents"] == 0:
        return "not_required"
    if row["payment_status"] == "approved":
        return "confirmed"
    if row["payment_status"] == "paid_unfulfilled":
        return "review"
    if row["payment_method"] in ("efectivo", "transferencia"):
        return "reported"
    return "reported"


def _sale_out(row: dict) -> PromoterSaleOut:
    return PromoterSaleOut(
        ticket_id=row["ticket_id"],
        event_id=row["event_id"],
        event_name=row["event_name"],
        event_starts_at=row["event_starts_at"],
        customer_name=row["customer_name"],
        customer_phone=row["customer_phone"],
        customer_email=row["customer_email"],
        ticket_type=row["ticket_type"],
        price_cents=int(row["price_cents"] or 0),
        payment_method=row["payment_method"],
        sale_channel=row["sale_channel"] or "promoter_direct",
        status=row["status"],
        payment_state=_sale_payment_state(row),
        admission_state=(
            "validated" if row["status"] == "redeemed"
            else "invalid" if row["status"] in ("voided", "refunded")
            else "pending"
        ),
        issued_at=row["issued_at"],
        redeemed_at=row["redeemed_at"],
        attention=bool(row["issue_id"]) or row["payment_status"] == "paid_unfulfilled",
        issue_id=row["issue_id"],
        issue_status=row["issue_status"],
        can_reissue=row["status"] == "issued",
        has_phone=len(_digits(row["customer_phone"])) >= 10,
        has_email=bool(row["customer_email"]),
    )


_SALES_SELECT = """
    SELECT t.id AS ticket_id, t.event_id, e.name AS event_name,
           e.starts_at AS event_starts_at, e.status AS event_status,
           t.customer_name, t.customer_phone, t.customer_email,
           tt.name AS ticket_type, t.price_cents_snapshot AS price_cents,
           t.payment_method, t.sale_channel, t.status::text AS status,
           t.issued_at, t.redeemed_at,
           v.name AS venue_name,
           p.reference AS payment_reference, p.status AS payment_status,
           p.provider AS payment_provider,
           i.id AS issue_id, i.status AS issue_status
      FROM tickets t
      JOIN events e ON e.id = t.event_id
      JOIN venues v ON v.id = e.venue_id
      JOIN ticket_types tt ON tt.id = t.ticket_type_id
      LEFT JOIN LATERAL (
          SELECT reference, status, provider
            FROM ticket_payments
           WHERE ticket_id = t.id
           ORDER BY id DESC LIMIT 1
      ) p ON true
      LEFT JOIN LATERAL (
          SELECT id, status
            FROM promoter_sale_issues
           WHERE ticket_id = t.id AND promoter_id = %s AND status = 'open'
           ORDER BY id DESC LIMIT 1
      ) i ON true
     WHERE e.venue_id = %s AND t.sold_by_user_id = %s
"""


@router.get("/promoter/sales", response_model=PromoterSalesOut)
async def promoter_sales(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    q: str | None = None,
    event_id: int | None = None,
    type_id: int | None = None,
    channel: str | None = None,
    status_: str | None = Query(default=None, alias="status"),
    attention: bool = False,
    limit: int = 30,
    offset: int = 0,
):
    ensure_roles(user, venue_id, "promotor")
    limit = max(1, min(limit, 100))
    offset = max(0, offset)

    where = ""
    params: list = [user["id"], venue_id, user["id"]]
    if event_id is not None:
        where += " AND t.event_id = %s"
        params.append(event_id)
    if type_id is not None:
        where += " AND t.ticket_type_id = %s"
        params.append(type_id)
    if status_:
        where += " AND t.status::text = %s"
        params.append(status_)
    if channel == "link":
        where += " AND t.sale_channel = 'promoter_link'"
    elif channel == "direct":
        where += " AND t.sale_channel IN ('promoter_direct','promoter_quota')"
    elif channel == "quota":
        where += " AND t.sale_channel = 'promoter_quota'"
    if q:
        needle = f"%{q.strip()}%"
        where += (
            " AND (t.customer_name ILIKE %s OR t.customer_phone ILIKE %s"
            " OR t.customer_email ILIKE %s OR t.id::text = %s)"
        )
        params.extend([needle, needle, needle, q.strip()])
    if attention:
        where += (
            " AND (i.id IS NOT NULL OR p.status = 'paid_unfulfilled')"
        )

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT count(*)::int AS n FROM ("
            + _SALES_SELECT
            + where
            + ") s",
            params,
        )
        total = (await cur.fetchone())["n"]
        await cur.execute(
            _SALES_SELECT
            + where
            + " ORDER BY t.issued_at DESC, t.id DESC LIMIT %s OFFSET %s",
            [*params, limit, offset],
        )
        rows = await cur.fetchall()
    return PromoterSalesOut(total=total, items=[_sale_out(r) for r in rows])


async def _get_sale(cur, venue_id: int, promoter_id: int, ticket_id: int):
    await cur.execute(
        _SALES_SELECT + " AND t.id = %s",
        (promoter_id, venue_id, promoter_id, ticket_id),
    )
    row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Venta no encontrada o sin acceso")
    return row


@router.get("/promoter/sales/{ticket_id}", response_model=PromoterSaleDetailOut)
async def promoter_sale_detail(
    venue_id: int,
    ticket_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "promotor")
    async with db.cursor() as cur:
        row = await _get_sale(cur, venue_id, user["id"], ticket_id)
        await cur.execute(
            """
            SELECT id, ticket_id, kind, note, status, resolution_note,
                   created_at, resolved_at
              FROM promoter_sale_issues
             WHERE ticket_id = %s AND promoter_id = %s
             ORDER BY id DESC
            """,
            (ticket_id, user["id"]),
        )
        issues = await cur.fetchall()
    base = _sale_out(row)
    reason = None
    if row["status"] != "issued":
        reason = (
            "La boleta ya fue usada: reemitirla invalidaría el QR que ya entró."
            if row["status"] == "redeemed"
            else "La boleta está anulada o reembolsada; no hay enlace que rotar."
        )
    return PromoterSaleDetailOut(
        **base.model_dump(),
        venue_name=row["venue_name"],
        event_status=row["event_status"],
        payment_reference=row["payment_reference"],
        payment_status=row["payment_status"],
        payment_provider=row["payment_provider"],
        reissue_blocked_reason=reason,
        issues=issues,
    )


@router.post(
    "/promoter/sales/{ticket_id}/issue",
    response_model=PromoterIssueOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_sale_issue(
    venue_id: int,
    ticket_id: int,
    body: PromoterIssueCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "promotor")
    async with db.transaction(), db.cursor() as cur:
        row = await _get_sale(cur, venue_id, user["id"], ticket_id)
        await cur.execute(
            """
            INSERT INTO promoter_sale_issues
                (venue_id, event_id, ticket_id, promoter_id, kind, note)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id, ticket_id, kind, note, status, resolution_note,
                      created_at, resolved_at
            """,
            (venue_id, row["event_id"], ticket_id, user["id"], body.kind, body.note.strip()),
        )
        return await cur.fetchone()


@router.post(
    "/promoter/sales/{ticket_id}/issue/{issue_id}/resolve",
    response_model=PromoterIssueOut,
)
async def resolve_sale_issue(
    venue_id: int,
    ticket_id: int,
    issue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "promotor")
    async with db.transaction(), db.cursor() as cur:
        await _get_sale(cur, venue_id, user["id"], ticket_id)
        await cur.execute(
            """
            UPDATE promoter_sale_issues
               SET status='resolved', resolved_at=now()
             WHERE id=%s AND ticket_id=%s AND promoter_id=%s
            RETURNING id, ticket_id, kind, note, status, resolution_note,
                      created_at, resolved_at
            """,
            (issue_id, ticket_id, user["id"]),
        )
        row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Incidencia no encontrada")
    return row


async def _link_metrics(cur, link_id: int, event_id: int, promoter_id: int, pct: float):
    await cur.execute(
        """
        SELECT
          count(*) FILTER (WHERE kind='view')::int AS visits,
          count(*) FILTER (WHERE kind='checkout_started')::int AS checkouts,
          count(*) FILTER (WHERE kind='purchase_approved')::int AS purchases
        FROM promoter_link_events WHERE link_id=%s
        """,
        (link_id,),
    )
    counts = await cur.fetchone()
    await cur.execute(
        """
        SELECT coalesce(sum(price_cents_snapshot),0)::bigint AS revenue
          FROM tickets
         WHERE event_id=%s AND sold_by_user_id=%s
           AND sale_channel='promoter_link'
           AND status IN ('issued','redeemed')
        """,
        (event_id, promoter_id),
    )
    revenue = int((await cur.fetchone())["revenue"] or 0)
    return {
        "visits": counts["visits"] or 0,
        "checkouts": counts["checkouts"] or 0,
        "purchases": counts["purchases"] or 0,
        "attributed_revenue_cents": revenue,
        "attributed_commission_cents": round(revenue * pct / 100),
    }


@router.get(
    "/promoter/events/{event_id}/link",
    response_model=PromoterLinkOut,
)
async def promoter_link(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Devuelve (o crea) el link público del promotor para este evento."""
    ensure_roles(user, venue_id, "promotor")
    async with db.transaction(), db.cursor() as cur:
        rows = await _events(cur, venue_id, user["id"], event_id=event_id)
        if not rows:
            raise HTTPException(404, "Evento no encontrado o sin acceso")
        row = rows[0]
        if not row["assignment_active"]:
            raise HTTPException(409, "Tu asignación a este evento fue retirada")
        await cur.execute(
            """
            SELECT id, public_id, is_active FROM promoter_links
             WHERE event_id=%s AND promoter_id=%s
            """,
            (event_id, user["id"]),
        )
        link = await cur.fetchone()
        if not link:
            public_id = secrets.token_urlsafe(12)
            await cur.execute(
                """
                INSERT INTO promoter_links (venue_id, event_id, promoter_id, public_id)
                VALUES (%s, %s, %s, %s)
                RETURNING id, public_id, is_active
                """,
                (venue_id, event_id, user["id"], public_id),
            )
            link = await cur.fetchone()
        await cur.execute(
            "SELECT commission_pct FROM venues WHERE id=%s", (venue_id,)
        )
        pct = float((await cur.fetchone())["commission_pct"] or 0)
        metrics = await _link_metrics(cur, link["id"], event_id, user["id"], pct)
    base = get_settings().app_public_url.rstrip("/")
    return PromoterLinkOut(
        public_id=link["public_id"],
        url=f"{base}/evento/{event_id}?ref={link['public_id']}",
        is_active=bool(link["is_active"]),
        commission_pct=pct,
        **metrics,
    )


@router.get(
    "/promoter/commissions",
    response_model=PromoterCommissionsOut,
)
async def promoter_commissions(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "promotor")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT commission_pct, currency FROM venues WHERE id=%s", (venue_id,)
        )
        venue = await cur.fetchone()
        if not venue:
            raise HTTPException(404, "Organización no encontrada")
        pct = float(venue["commission_pct"] or 0)

        await cur.execute(
            """
            SELECT p.id, p.promoter_id, u.full_name AS promoter_name,
                   p.period_start, p.period_end, p.tickets_count, p.revenue_cents,
                   p.commission_pct, p.commission_cents, p.status,
                   p.paid_cents, p.paid_at, p.disputed_reason,
                   p.review_note, p.reviewed_at, p.created_at,
                   (SELECT count(*)::int FROM promoter_payout_items i
                     WHERE i.payout_id = p.id) AS items_count
              FROM promoter_payouts p
              JOIN users u ON u.id = p.promoter_id
             WHERE p.venue_id=%s AND p.promoter_id=%s
             ORDER BY p.period_end DESC, p.id DESC
            """,
            (venue_id, user["id"]),
        )
        payouts = await cur.fetchall()
        last_end = max((p["period_end"] for p in payouts), default=None)

        await cur.execute(
            """
            SELECT count(*)::int AS n,
                   coalesce(sum(price_cents_snapshot),0)::bigint AS revenue
              FROM tickets
             WHERE sold_by_user_id=%s
               AND status IN ('issued','redeemed')
               AND event_id IN (SELECT id FROM events WHERE venue_id=%s)
               AND (%s::date IS NULL OR issued_at >= (%s::date + INTERVAL '1 day'))
            """,
            (user["id"], venue_id, last_end, last_end),
        )
        unsettled = await cur.fetchone()
        unsettled_revenue = int(unsettled["revenue"] or 0)
        unsettled_cents = round(unsettled_revenue * pct / 100)

        await cur.execute(
            """
            SELECT count(*)::int AS n,
                   coalesce(sum(price_cents_snapshot),0)::bigint AS revenue
              FROM tickets
             WHERE sold_by_user_id=%s
               AND status IN ('issued','redeemed')
               AND price_cents_snapshot > 0
               AND event_id IN (SELECT id FROM events WHERE venue_id=%s)
            """,
            (user["id"], venue_id),
        )
        all_sales = await cur.fetchone()

    generated = sum(
        int(p["commission_cents"] or 0)
        for p in payouts
        if p["status"] in ("pending", "disputed", "paid")
    )
    paid = sum(int(p["paid_cents"] or 0) for p in payouts if p["status"] == "paid")
    generated_pending = sum(
        int(p["commission_cents"] or 0)
        for p in payouts
        if p["status"] in ("pending", "disputed")
    )
    return PromoterCommissionsOut(
        currency=venue["currency"] or "COP",
        commission_pct=pct,
        generated_cents=generated,
        pending_settlement_cents=generated_pending + unsettled_cents,
        paid_cents=paid,
        unsettled_cents=unsettled_cents,
        attributed_revenue_cents=int(all_sales["revenue"] or 0),
        eligible_sales_count=int(all_sales["n"] or 0),
        generated_includes_paid=True,
        definition=(
            "Comisión sobre el valor de las boletas pagadas emitidas a tu nombre "
            "o atribuidas a tu link, descontando anuladas y reembolsadas. "
            "«Generado» incluye lo ya pagado; «Pendiente de liquidar» es lo que "
            "aún no tiene pago registrado."
        ),
        payouts=[
            PromoterCommissionPayoutOut(
                **PayoutOut(
                    id=p["id"], promoter_id=p["promoter_id"],
                    promoter_name=p["promoter_name"], period_start=p["period_start"],
                    period_end=p["period_end"], tickets_count=p["tickets_count"],
                    revenue_cents=p["revenue_cents"], commission_pct=float(p["commission_pct"]),
                    commission_cents=p["commission_cents"], status=p["status"],
                    paid_cents=p["paid_cents"], paid_at=p["paid_at"],
                    disputed_reason=p["disputed_reason"], review_note=p["review_note"],
                    reviewed_at=p["reviewed_at"], created_at=p["created_at"],
                ).model_dump(),
                items_count=p["items_count"],
                can_dispute=p["status"] == "pending",
            )
            for p in payouts
        ],
    )


@router.get(
    "/promoter/commissions/{payout_id}",
    response_model=PromoterPayoutDetailOut,
)
async def promoter_commission_detail(
    venue_id: int,
    payout_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "promotor")
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT p.*, u.full_name AS promoter_name, v.currency
              FROM promoter_payouts p
              JOIN users u ON u.id = p.promoter_id
              JOIN venues v ON v.id = p.venue_id
             WHERE p.id=%s AND p.venue_id=%s AND p.promoter_id=%s
            """,
            (payout_id, venue_id, user["id"]),
        )
        payout = await cur.fetchone()
        if not payout:
            raise HTTPException(404, "Liquidación no encontrada")
        await cur.execute(
            """
            SELECT i.ticket_id, i.event_id, e.name AS event_name,
                   tt.name AS ticket_type, t.customer_name, i.issued_at,
                   i.price_cents, i.sale_channel, i.status_at_close
              FROM promoter_payout_items i
              JOIN events e ON e.id = i.event_id
              JOIN tickets t ON t.id = i.ticket_id
              JOIN ticket_types tt ON tt.id = i.ticket_type_id
             WHERE i.payout_id=%s
             ORDER BY i.issued_at DESC, i.ticket_id DESC
            """,
            (payout_id,),
        )
        items = await cur.fetchall()
        if not items:
            # Liquidaciones anteriores a la mig 063: se reconstruye el detalle
            # con la misma regla del cierre, sin escribir nada.
            await cur.execute(
                """
                SELECT t.id AS ticket_id, t.event_id, e.name AS event_name,
                       tt.name AS ticket_type, t.customer_name, t.issued_at,
                       t.price_cents_snapshot AS price_cents, t.sale_channel,
                       t.status::text AS status_at_close
                  FROM tickets t
                  JOIN events e ON e.id = t.event_id
                  JOIN ticket_types tt ON tt.id = t.ticket_type_id
                 WHERE t.sold_by_user_id=%s
                   AND e.venue_id=%s
                   AND t.status IN ('issued','redeemed')
                   AND t.issued_at >= %s::date
                   AND t.issued_at < (%s::date + INTERVAL '1 day')
                 ORDER BY t.issued_at DESC, t.id DESC
                """,
                (user["id"], venue_id, payout["period_start"], payout["period_end"]),
            )
            items = await cur.fetchall()
    adjustment = (
        int(payout["paid_cents"] or 0) - int(payout["commission_cents"] or 0)
        if payout["status"] == "paid" else 0
    )
    return PromoterPayoutDetailOut(
        id=payout["id"], promoter_id=payout["promoter_id"],
        promoter_name=payout["promoter_name"],
        period_start=payout["period_start"], period_end=payout["period_end"],
        tickets_count=payout["tickets_count"], revenue_cents=payout["revenue_cents"],
        commission_pct=float(payout["commission_pct"]),
        commission_cents=payout["commission_cents"], status=payout["status"],
        paid_cents=payout["paid_cents"], paid_at=payout["paid_at"],
        disputed_reason=payout["disputed_reason"], review_note=payout["review_note"],
        reviewed_at=payout["reviewed_at"], created_at=payout["created_at"],
        items=[PromoterPayoutItemOut(**i) for i in items],
        currency=payout["currency"] or "COP",
        base_cents=payout["revenue_cents"],
        adjustment_cents=adjustment,
        rule=(
            f"{float(payout['commission_pct']):g}% sobre el valor de las boletas "
            "vivas del periodo, con la tarifa congelada al cierre."
        ),
        can_dispute=payout["status"] == "pending",
    )
