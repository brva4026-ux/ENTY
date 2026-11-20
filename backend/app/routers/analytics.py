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
from app.core.rate_limit import enforce_rate_limit
from app.deps import ensure_roles, get_current_user

router = APIRouter(tags=["analitica"])

_ALLOWED_NAMES = ("view_home", "view_event", "checkout_start")
_MAX_BATCH = 20
_MAX_PROPS_CHARS = 2_000

# Cubo propio de rate limit: la ingesta no debe competir con el de las rutas
# publicas de boleta (public.py) ni inflarlo. 60/min por IP alcanza para una
# pestana (el cliente agrupa) y frena a un script que intente inflar el embudo.
# El contador vive en la DB (mig 041): un dict en memoria no frena nada en
# serverless y ademas no evictaba sus claves (fuga por instancia).
_RATE_SCOPE = "public:analytics"
_LIMIT = 60
_WINDOW = 60


class _EventIn(BaseModel):
    name: str
    path: str | None = Field(default=None, max_length=200)
    event_id: int | None = None
    props: dict[str, Any] | None = None


class _BatchIn(BaseModel):
    session_id: str = Field(min_length=8, max_length=64)
    events: list[_EventIn] = Field(min_length=1, max_length=_MAX_BATCH)


async def _rate_limit(
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
) -> None:
    await enforce_rate_limit(
        request,
        db,
        scope=_RATE_SCOPE,
        max_hits=_LIMIT,
        window_seconds=_WINDOW,
    )


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
            try:
                await cur.executemany(
                    "INSERT INTO analytics_events (name, session_id, path, event_id, props) "
                    "VALUES (%s, %s, %s, %s, %s::jsonb)",
                    rows,
                )
            except psycopg.errors.UndefinedTable as e:
                # Despliegue sin la migracion 031: mejor un 503 con el archivo
                # exacto que un 500 opaco en cada visita. La app ignora esta
                # respuesta (la analitica nunca bloquea la compra).
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                    "Analitica no disponible: falta aplicar "
                    "db/migrations/031_analytics_events.sql",
                ) from e
            await db.commit()

    return None


@router.get("/venues/{venue_id}/funnel")
async def venue_funnel(
    venue_id: int,
    user=Depends(get_current_user),
    db=Depends(get_db),
    days: int = Query(7, ge=1, le=90),
):
    """Embudo evento -> checkout -> pago, para una venue.

    Los pasos son SESIONES anidadas: quien inicia el checkout ya abrio el
    evento, asi que cada paso es subconjunto del anterior. Los pagos cuentan
    TRANSACCIONES aprobadas en ticket_payments, que es la unica fuente de
    verdad del dinero; por eso el ultimo paso no cierra exacto y la respuesta
    lo declara (`units`).

    La vitrina NO es un paso: `view_home` se emite en el catalogo global, sin
    `event_id`, asi que no se puede atribuir a una venue. Como paso quedaba
    como subconjunto del siguiente (sesiones que ademas abrieron un evento de
    esta venue) y el embudo crecia hacia abajo. Se devuelve aparte, como
    `home_sessions`, para leerlo como contexto y no como etapa.
    """
    ensure_roles(user, venue_id, "admin", "super_admin")
    since = datetime.now(timezone.utc) - timedelta(days=days)

    async with db.cursor() as cur:
        try:
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
                       bool_or(a.name = 'view_event') AS saw_event,
                       bool_or(a.name = 'checkout_start') AS started
                FROM touched t
                JOIN analytics_events a
                  ON a.session_id = t.session_id AND a.created_at >= %(since)s
                GROUP BY t.session_id
            )
            SELECT count(*) FILTER (WHERE saw_event)::int AS saw_event,
                   count(*) FILTER (WHERE started)::int   AS started
            FROM sessions
            """,
                {"venue": venue_id, "since": since},
            )
        except psycopg.errors.UndefinedTable as e:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Metricas no disponibles: falta aplicar "
                "db/migrations/031_analytics_events.sql",
            ) from e
        sessions = await cur.fetchone()

        # Vitrina global: se mide igual (sesiones, no visitas) pero fuera del
        # embudo, porque no se puede atribuir a una venue.
        await cur.execute(
            """
            SELECT count(DISTINCT session_id)::int AS home_sessions
            FROM analytics_events
            WHERE name = 'view_home' AND created_at >= %s
            """,
            (since,),
        )
        home = await cur.fetchone()

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

    saw_event = sessions["saw_event"] or 0
    paid = money["paid"] or 0
    # Sobre las sesiones que abrieron un evento de esta venue: es la base del
    # embudo y la unica que el organizador puede accionar.
    conversion = round(paid / saw_event * 100, 1) if saw_event else 0.0

    return {
        "days": days,
        "since": since.isoformat(),
        "steps": [
            {
                "key": "view_event",
                "label": "Abrieron un evento",
                "count": saw_event,
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
        "home_sessions": home["home_sessions"] or 0,
        "revenue_cents": int(money["revenue_cents"] or 0),
        "conversion_pct": conversion,
    }
