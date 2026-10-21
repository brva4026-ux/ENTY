"""Analitica de producto: ingesta del embudo y su lectura.

Por que existe (y por que no un SaaS): la app se comparte por WhatsApp y el
CSP es `script-src 'self'`. Un script de terceros obligaria a abrir el CSP y a
un banner de cookies para medir cuatro pasos. Estos eventos viajan al propio
backend y viven en la misma DB (mig 031), sin cookies ni identificadores
personales.

Que se mide:
    view_home       -> alguien vio la vitrina
    view_event      -> abrio un evento
    checkout_start  -> apreto comprar
    (pago aprobado) -> NO se duplica aqui: sale de ticket_payments

El embudo se calcula por VENUE y por SESION: solo cuentan las sesiones que
tocaron un evento de esa venue, asi un admin no ve trafico ni ventas de otra.
"""
import json
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user

router = APIRouter(tags=["analitica"])

_ALLOWED_NAMES = ("view_home", "view_event", "checkout_start")
_MAX_BATCH = 20
_MAX_PROPS_CHARS = 2_000

# Cubo propio de rate limit: la ingesta no debe competir con el de las rutas
# publicas de boleta (public.py) ni inflarlo. 60/min por IP alcanza para una
# pestana (el cliente agrupa) y frena a un script que intente inflar el embudo.
_LIMIT = 60
_WINDOW = 60.0
_bucket: dict[str, list[float]] = {}


class _EventIn(BaseModel):
    name: str
    path: str | None = Field(default=None, max_length=200)
    event_id: int | None = None
    props: dict[str, Any] | None = None


class _BatchIn(BaseModel):
    session_id: str = Field(min_length=8, max_length=64)
    events: list[_EventIn] = Field(min_length=1, max_length=_MAX_BATCH)


def _client_key(request: Request) -> str:
    """IP del cliente real detras del edge (mismo criterio que public.py)."""
    fwd = request.headers.get("x-forwarded-for", "")
    return (
        request.headers.get("x-real-ip")
        or (fwd.split(",")[0].strip() if fwd else "")
        or (request.client.host if request.client else "unknown")
    )


def _rate_limit(request: Request) -> None:
    import time

    key = _client_key(request)
    now = time.monotonic()
    bucket = [t for t in _bucket.get(key, []) if now - t < _WINDOW]
    if len(bucket) >= _LIMIT:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Demasiadas peticiones")
    bucket.append(now)
    _bucket[key] = bucket


@router.post(
    "/public/analytics/events",
    status_code=status.HTTP_204_NO_CONTENT,
    include_in_schema=False,
)
async def ingest_events(
    payload: _BatchIn,
    request: Annotated[None, Depends(_rate_limit)],
    db=Depends(get_db),
):
    """Ingesta anonima por lotes desde la app del fan.

    Nunca falla por datos sueltos: un evento desconocido o un `event_id` que ya
    no existe se descarta en vez de romper el lote entero (el fan no debe ver
    un error porque su pestana quedo abierta desde ayer).
    """
    rows: list[tuple] = []
    wanted_ids = {e.event_id for e in payload.events if e.event_id}
    valid_ids: set[int] = set()

    async with db.cursor() as cur:
        if wanted_ids:
            await cur.execute("SELECT id FROM events WHERE id = ANY(%s)", (list(wanted_ids),))
            valid_ids = {r["id"] for r in await cur.fetchall()}

        for e in payload.events:
            if e.name not in _ALLOWED_NAMES:
                continue
            props = json.dumps(e.props or {}, ensure_ascii=False)
            if len(props) > _MAX_PROPS_CHARS:
                continue
            rows.append(
                (
                    e.name,
                    payload.session_id,
                    e.path,
                    e.event_id if e.event_id in valid_ids else None,
                    props,
                )
            )

        if rows:
            await cur.executemany(
                "INSERT INTO analytics_events (name, session_id, path, event_id, props) "
                "VALUES (%s, %s, %s, %s, %s::jsonb)",
                rows,
            )
            await db.commit()

    return None


@router.get("/venues/{venue_id}/funnel")
async def venue_funnel(
    venue_id: int,
    user=Depends(get_current_user),
    db=Depends(get_db),
    days: int = Query(7, ge=1, le=90),
):
    """Embudo vitrina -> evento -> checkout -> pago, para una venue.

    El paso de vitrina cuenta SESIONES (no visitas): alguien que recarga diez
    veces no infla el numeros. Los pagos cuentan TRANSACCIONES aprobadas en
    ticket_payments, que es la unica fuente de verdad del dinero; por eso el
    embudo no cierra exacto y la respuesta lo declara (`units`).
    """
    ensure_roles(user, venue_id, "admin", "super_admin")
    since = datetime.now(timezone.utc) - timedelta(days=days)

    async with db.cursor() as cur:
        await cur.execute(
            """
            WITH touched AS (
                SELECT DISTINCT a.session_id
                FROM analytics_events a
                JOIN events e ON e.id = a.event_id
                WHERE e.venue_id = %(venue)s AND a.created_at >= %(since)s
            ),
            sessions AS (
                SELECT t.session_id,
                       bool_or(a.name = 'view_home') AS saw_home,
                       bool_or(a.name = 'view_event') AS saw_event,
                       bool_or(a.name = 'checkout_start') AS started
                FROM touched t
                JOIN analytics_events a
                  ON a.session_id = t.session_id AND a.created_at >= %(since)s
                GROUP BY t.session_id
            )
            SELECT count(*) FILTER (WHERE saw_home)::int  AS saw_home,
                   count(*) FILTER (WHERE saw_event)::int AS saw_event,
                   count(*) FILTER (WHERE started)::int   AS started
            FROM sessions
            """,
            {"venue": venue_id, "since": since},
        )
        sessions = await cur.fetchone()

        await cur.execute(
            """
            SELECT count(*)::int AS paid,
                   coalesce(sum(amount_in_cents), 0)::bigint AS revenue_cents
            FROM ticket_payments
            WHERE venue_id = %s AND status = 'approved' AND approved_at >= %s
            """,
            (venue_id, since),
        )
        money = await cur.fetchone()

    home = sessions["saw_home"] or 0
    paid = money["paid"] or 0
    conversion = round(paid / home * 100, 1) if home else 0.0

    return {
        "days": days,
        "since": since.isoformat(),
        "steps": [
            {"key": "view_home", "label": "Vieron la vitrina", "count": home, "unit": "sesiones"},
            {
                "key": "view_event",
                "label": "Abrieron un evento",
                "count": sessions["saw_event"] or 0,
                "unit": "sesiones",
            },
            {
                "key": "checkout_start",
                "label": "Iniciaron la compra",
                "count": sessions["started"] or 0,
                "unit": "sesiones",
            },
            {"key": "paid", "label": "Pagaron", "count": paid, "unit": "transacciones"},
        ],
        "revenue_cents": int(money["revenue_cents"] or 0),
        "conversion_pct": conversion,
    }
