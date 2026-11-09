"""CRUD de eventos, tipos de boleta y asignacion de cupos a promotores."""
from datetime import datetime, timezone
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.db import get_db
from app.core.db_errors import translate_db_error
from app.core.lifecycle import auto_close_expired
from app.deps import ensure_roles, get_current_user
from app.core.audit import write_audit
from app.core.observability import capture_exception
from app.schemas import (
    AllocationBulkCreate,
    AllocationBulkOut,
    AllocationCreate,
    AllocationOut,
    AllocationUpdate,
    DeleteOut,
    EventCreate,
    EventOut,
    EventUpdate,
    MessageOut,
    MyEventOut,
    TicketTypeCreate,
    TicketTypeOut,
    TicketTypeUpdate,
)

# La recurrencia semanal es el patron del negocio ("Viernes Electronico"):
# el duplicado nace con apertura a +7 dias para que sea verdad por defecto.
DUPLICATE_SHIFT_DAYS = 7

router = APIRouter(prefix="/venues/{venue_id}", tags=["eventos"])

# `issued` = boletas vivas contra el cupo (mismo criterio que emit_ticket:
# anuladas y reembolsadas no consumen). Se calcula aca y no se almacena para
# no tener un contador que se desincronice del estado real de las boletas.
_ALLOC_COLUMNS = """
    a.id, a.event_id, a.ticket_type_id, a.promoter_id, a.capacity, a.is_active,
    (SELECT count(*)::int FROM tickets t
      WHERE t.allocation_id = a.id
        AND t.status NOT IN ('voided', 'refunded')) AS issued
"""


def _event_ctx(venue_id: int, user: dict):
    if venue_id not in user["venue_ids"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No perteneces a esta venue")


# ---------------------------------------------------------------------------
# Eventos: columnas que expone EventOut, en UN solo lugar.
#
# Listar, crear y transicionar (lifecycle.py, que importa fetch_event de aqui)
# tienen que devolver el mismo shape: el frontend reemplaza el evento de su
# estado con la respuesta de la transicion, asi que una consulta recortada
# borraria la descripcion y el flyer de la vista.
# ---------------------------------------------------------------------------
EVENT_COLUMNS = (
    "id, venue_id, name, description, flyer_url, location, starts_at, ends_at, "
    "event_timezone, capacity, qr_unlock_minutes, status"
)


async def fetch_event(cur, event_id: int, venue_id: int | None = None) -> dict | None:
    # Interpolacion f-string de una constante propia (nunca de input del usuario).
    sql = f"SELECT {EVENT_COLUMNS} FROM events WHERE id=%s"
    params: list = [event_id]
    if venue_id is not None:
        sql += " AND venue_id=%s"
        params.append(venue_id)
    await cur.execute(sql, tuple(params))
    return await cur.fetchone()


# ---------------------------------------------------------------------------
# Consultas compartidas (mismo shape para listar, leer y devolver tras editar)
# ---------------------------------------------------------------------------
_TYPE_SELECT = """
    SELECT tt.id, tt.event_id, tt.name, tt.price_cents, tt.quantity,
           tt.is_courtesy, tt.is_active
    FROM ticket_types tt
    JOIN events e ON e.id = tt.event_id
"""

_ALLOCATION_SELECT = """
    SELECT a.id, a.event_id, a.ticket_type_id, a.promoter_id, a.capacity,
           a.is_active,
           COALESCE((
               SELECT count(*) FROM tickets t
                WHERE t.allocation_id = a.id
                  AND t.status NOT IN ('voided', 'refunded')
           ), 0)::int AS issued
    FROM promoter_allocations a
    JOIN events e ON e.id = a.event_id
"""


def _edit_error(e: psycopg.errors.Error) -> None:
    """Traduce los errores de negocio de editar/eliminar (migracion 004).

    Delega en el mapa único `db_errors` (el nombre de tipo duplicado lo cubre
    por constraint); si el código no está en el mapa, re-lanza el original.
    """
    http = translate_db_error(e)
    if http is not None:
        raise http
    raise e


async def _fetch_type(cur, venue_id: int, event_id: int, type_id: int) -> dict | None:
    await cur.execute(
        _TYPE_SELECT + " WHERE tt.id=%s AND tt.event_id=%s AND e.venue_id=%s",
        (type_id, event_id, venue_id),
    )
    return await cur.fetchone()


async def _fetch_allocation(
    cur, venue_id: int, event_id: int, allocation_id: int
) -> dict | None:
    await cur.execute(
        _ALLOCATION_SELECT + " WHERE a.id=%s AND a.event_id=%s AND e.venue_id=%s",
        (allocation_id, event_id, venue_id),
    )
    return await cur.fetchone()


# --------------------------------------------------------------------------
# Eventos
# --------------------------------------------------------------------------
@router.get("/events/ticket-counts")
async def list_event_ticket_counts(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Pulso agregado por evento de la venue, en UNA consulta.

    Alimenta la franja "Todos los eventos" del admin: cada tarjeta es un
    mini-reporte (boletas vivas · dentro · recaudo) sin abrir el evento y sin
    N requests (un GET por franja, no por evento). "Vivas" = issued + redeemed
    (igual que el reporte de puerta); "dentro" = redeemed; el recaudo suma el
    precio de TODAS las vivas (lo que la noche cierra, no lo ya cobrado).

    `duplicates`/`rejected` (salud de puerta, de redemptions): un pico de
    duplicados es el sintoma de un QR reenviado/clonado, y la franja tiene que
    delatarlo sin abrir el evento. Va en una consulta APARTE, agrupada por
    evento: unirlas en el mismo FROM multiplicaria las filas de tickets por las
    de redemptions (fan-out) y corromperia los conteos.

    Ruta literal ANTES de /events/{event_id} para que no se la coma el router.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    _event_ctx(venue_id, user)

    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT e.id,
                   count(t.id) FILTER
                     (WHERE t.status IN ('issued','redeemed'))::int AS active,
                   count(t.id) FILTER (WHERE t.status = 'redeemed')::int AS redeemed,
                   coalesce(sum(t.price_cents_snapshot)
                            FILTER (WHERE t.status IN ('issued','redeemed')), 0)::bigint
                       AS revenue_cents
            FROM events e
            LEFT JOIN tickets t ON t.event_id = e.id
            WHERE e.venue_id = %s
            GROUP BY e.id
            """,
            (venue_id,),
        )
        rows = await cur.fetchall()

        await cur.execute(
            """
            SELECT r.event_id,
                   count(*) FILTER (WHERE r.outcome='already_redeemed')::int AS duplicates,
                   count(*) FILTER
                     (WHERE r.outcome NOT IN ('granted','granted_forced','already_redeemed'))::int
                       AS rejected
            FROM redemptions r
            JOIN events e ON e.id = r.event_id
            WHERE e.venue_id = %s
            GROUP BY r.event_id
            """,
            (venue_id,),
        )
        door = {r["event_id"]: r for r in await cur.fetchall()}

    return {
        str(r["id"]): {
            "active": r["active"],
            "redeemed": r["redeemed"],
            "revenue_cents": int(r["revenue_cents"]),
            "duplicates": (door.get(r["id"]) or {}).get("duplicates", 0),
            "rejected": (door.get(r["id"]) or {}).get("rejected", 0),
        }
        for r in rows
    }


@router.get("/events", response_model=list[EventOut])
async def list_events(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
):
    _event_ctx(venue_id, user)
    # Watchdog de cierre (mig 020): antes de listar, cierra los vencidos.
    # Es la llamada barata que sustituye al cron (serverless no lo tiene):
    # idempotente, con índice parcial, y si no hay vencidos no hace nada.
    # Cualquier usuario autenticado de la venue la dispara al abrir su
    # panel — y el live-refresh la re-dispara cada 20s. Compartido con
    # /events/mine, /overview y /door-snapshot (app/core/lifecycle.py): el
    # cierre no depende de que el ADMIN sea quien pase por su panel.
    await auto_close_expired(db, context="list_events")
    async with db.cursor() as cur:
        await cur.execute(
            f"SELECT {EVENT_COLUMNS} FROM events "
            "WHERE venue_id=%s ORDER BY starts_at DESC LIMIT %s",
            (venue_id, limit),
        )
        rows = await cur.fetchall()

        # Validacion fila por fila: UNA fila con datos imposibles (un evento
        # de prueba con starts_at/capacity NULL, creada a mano o por un test
        # contra esta DB) no puede tumbar el LISTADO COMPLETO con un 500 de
        # pydantic. La fila invalida se omite, se reporta, y el panel sigue
        # mostrando los demas eventos.
        out: list[EventOut] = []
        for row in rows:
            try:
                out.append(EventOut.model_validate(row))
            except Exception as e:
                capture_exception(
                    e,
                    context={
                        "kind": "event_row_invalid",
                        "venue_id": venue_id,
                        "row_id": row.get("id") if isinstance(row, dict) else None,
                    },
                )
        return out


# -----------------------------------------------------------------------
# MIS NOCHES (tanda 3): los eventos donde ESTE promotor trabaja. Con el
# equipo aislado por evento (mig 025), la lista de la venue entera es
# ruido: el promotor de la noche del 14 no necesita ver las otras 30.
# Devuelve el evento + su cupo agregado, para pintar la tarjeta y el
# medidor sin N requests.
# -----------------------------------------------------------------------
@router.get("/events/mine", response_model=list[MyEventOut])
async def list_my_events(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    _event_ctx(venue_id, user)
    # El promotor también cierra lo vencido: su panel es una puerta de entrada
    # más a la app (app/core/lifecycle.py).
    await auto_close_expired(db, context="list_my_events")
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT e.id, e.name, e.starts_at, e.status, e.flyer_url,
                   e.capacity,
                   coalesce(sum(a.capacity), 0)::int AS my_capacity,
                   (SELECT count(*)::int FROM tickets t
                     WHERE t.event_id = e.id AND t.sold_by_user_id = %s
                       AND t.status IN ('issued','redeemed')) AS my_issued,
                   (SELECT count(*)::int FROM tickets t
                     WHERE t.event_id = e.id AND t.sold_by_user_id = %s
                       AND t.status = 'redeemed') AS my_redeemed
            FROM events e
            JOIN event_staff s ON s.event_id = e.id AND s.user_id = %s
            LEFT JOIN promoter_allocations a
                   ON a.event_id = e.id AND a.promoter_id = %s AND a.is_active
            WHERE e.venue_id = %s
            GROUP BY e.id
            ORDER BY e.starts_at DESC
            """,
            (user["id"], user["id"], user["id"], user["id"], venue_id),
        )
        rows = await cur.fetchall()
    return [MyEventOut(**r) for r in rows]


@router.post("/events", response_model=EventOut, status_code=status.HTTP_201_CREATED)
async def create_event(
    venue_id: int,
    body: EventCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    # En creación no existe el guardia de la DB que sí protege la edición
    # (`update_event` lanza `starts_at_in_past`). Sin esto se podía crear y
    # PUBLICAR un evento con fecha pasada: nacía visible al público ya caducado.
    # El chequeo va DESPUÉS de ensure_roles para que un rol sin permiso siga
    # viendo 403 y no un 400 por los datos.
    starts = body.starts_at
    if starts.tzinfo is None:
        starts = starts.replace(tzinfo=timezone.utc)
    if starts < datetime.now(timezone.utc):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "La apertura del evento no puede estar en el pasado",
        )
    async with db.cursor() as cur:
        await cur.execute(
            f"""
            INSERT INTO events (venue_id, name, description, flyer_url,
                                location, starts_at, ends_at, event_timezone,
                                capacity, qr_unlock_minutes, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'draft')
            RETURNING {EVENT_COLUMNS}
            """,
            (
                venue_id,
                body.name,
                body.description,
                # HttpUrl -> texto plano para la columna flyer_url
                str(body.flyer_url) if body.flyer_url else None,
                (body.location or None) if body.location is not None else None,
                body.starts_at,
                body.ends_at,
                body.event_timezone,
                body.capacity,
                body.qr_unlock_minutes,
            ),
        )
        created = await cur.fetchone()
        await db.commit()
    return created


@router.post(
    "/events/{event_id}/duplicate", response_model=EventOut,
    status_code=status.HTTP_201_CREATED,
)
async def duplicate_event(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    days: Annotated[int, Query(ge=1, le=365)] = DUPLICATE_SHIFT_DAYS,
    name: str | None = Query(None, max_length=120),
):
    """Copia un evento como borrador: la recurrencia semanal en un clic.

    Duplica datos del evento, tipos de boleta ACTIVOS y cupos ACTIVOS por
    promotor (emparejados por nombre del tipo dentro de la misma query).
    NO duplica boletas (serian entradas gratis sin fin) ni el estado: nace
    draft y hay que publicarlo. La apertura queda a +7 dias por defecto
    (patron semanal del negocio); `?days=` la mueve al intervalo real de la
    venue (quincenal, mensual...) y `?name=` le da el nombre nuevo en vez del
    "(copia)" autogenerado — el admin decide, no se adivina (Ley de Tesler).

    Todo el copiado vive en UN statement: o se copia completo o nada.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute(
            f"SELECT {EVENT_COLUMNS} FROM events WHERE id=%s AND venue_id=%s",
            (event_id, venue_id),
        )
        src = await cur.fetchone()
        if not src:
            raise HTTPException(404, "Evento no encontrado")

        new_name = (name or "").strip() or f"{src['name']} (copia)"
        await cur.execute(
            """
            WITH new_ev AS (
                INSERT INTO events (venue_id, name, description, flyer_url,
                                    location, starts_at, ends_at,
                                    event_timezone, capacity,
                                    qr_unlock_minutes, status)
                VALUES (%s, %s, %s, %s, %s,
                        (SELECT starts_at FROM events WHERE id = %s)
                          + (%s * interval '1 day'),
                        NULL, %s, %s, %s, 'draft')
                RETURNING id
            ), new_types AS (
                INSERT INTO ticket_types (event_id, name, price_cents,
                                          currency, quantity, is_courtesy,
                                          is_active)
                SELECT new_ev.id, tt.name, tt.price_cents, tt.currency,
                       tt.quantity, tt.is_courtesy, TRUE
                FROM ticket_types tt, new_ev
                WHERE tt.event_id = %s AND tt.is_active
                RETURNING id, name
            )
            INSERT INTO promoter_allocations
                   (event_id, ticket_type_id, promoter_id, capacity, is_active)
            SELECT new_ev.id, nt.id, pa.promoter_id, pa.capacity, TRUE
            FROM promoter_allocations pa
            JOIN ticket_types tt ON tt.id = pa.ticket_type_id
            JOIN new_types nt ON nt.name = tt.name
            CROSS JOIN new_ev
            WHERE pa.event_id = %s AND pa.is_active
            RETURNING (SELECT id FROM new_ev)
            """,
            (
                venue_id,
                new_name,
                src["description"],
                str(src["flyer_url"]) if src["flyer_url"] else None,
                src["location"],
                event_id,
                days,
                src["event_timezone"],
                src["capacity"],
                src["qr_unlock_minutes"],
                event_id,
                event_id,
            ),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(500, "No se pudo duplicar el evento")
        created = await fetch_event(cur, row["id"], venue_id)
        await db.commit()
    return created


@router.patch("/events/{event_id}", response_model=EventOut)
async def update_event(
    venue_id: int,
    event_id: int,
    body: EventUpdate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Edición parcial del evento (nombre, fechas, aforo, flyer, descripción).

    Solo draft y published son editables: en live la puerta ya está corriendo y
    en ended/cancelled el evento es histórico. La validación que importa (aforo
    >= boletas activas, ventana coherente, fechas no en el pasado) vive en la
    DB, dentro de `update_event` (migración 005).
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        current = await fetch_event(cur, event_id, venue_id)
        if not current:
            raise HTTPException(404, "Evento no encontrado")
        if current["status"] not in ("draft", "published"):
            raise HTTPException(
                409,
                "Solo se pueden editar eventos en borrador o publicados "
                "(no en puerta, terminados ni cancelados)",
            )

        # Sin los None: los campos NOT NULL nunca se envían vacíos a la DB.
        changes = {
            k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None
        }
        merged = {**current, **changes}
        # Normalize a str for the DB (pydantic gave us an HttpUrl object).
        if merged.get("flyer_url") is not None:
            merged["flyer_url"] = str(merged["flyer_url"])

        # La ventana de activación del QR no pasa por update_event (su firma
        # es estable): UPDATE directo con el mismo guard de estado.
        if "qr_unlock_minutes" in body.model_dump(exclude_unset=True):
            await cur.execute(
                "UPDATE events SET qr_unlock_minutes=%s WHERE id=%s",
                (body.qr_unlock_minutes, event_id),
            )
        # Igual que qr_unlock_minutes: location no está en la firma de la
        # función SQL, se aplica directo (location="" limpia -> NULL).
        if "location" in body.model_dump(exclude_unset=True):
            await cur.execute(
                "UPDATE events SET location=%s WHERE id=%s",
                ((body.location or "").strip() or None, event_id),
            )

        try:
            await cur.execute(
                """
                SELECT update_event(%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    event_id,
                    merged["name"],
                    merged["description"],
                    merged["flyer_url"],
                    merged["starts_at"],
                    merged["ends_at"],
                    merged["event_timezone"],
                    merged["capacity"],
                ),
            )
        except psycopg.errors.Error as e:
            _edit_error(e)

        updated = await fetch_event(cur, event_id, venue_id)
        await db.commit()
    return updated


# --------------------------------------------------------------------------
# Tipos de boleta
# --------------------------------------------------------------------------
@router.get("/events/{event_id}/types", response_model=list[TicketTypeOut])
async def list_types(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    _event_ctx(venue_id, user)
    async with db.cursor() as cur:
        await cur.execute(
            _TYPE_SELECT + " WHERE tt.event_id=%s AND e.venue_id=%s ORDER BY tt.id",
            (event_id, venue_id),
        )
        return await cur.fetchall()


@router.post(
    "/events/{event_id}/types", response_model=TicketTypeOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_type(
    venue_id: int,
    event_id: int,
    body: TicketTypeCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")
        await cur.execute(
            """
            INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (event_id, name) DO NOTHING
            RETURNING id, event_id, name, price_cents, quantity, is_courtesy, is_active
            """,
            (event_id, body.name, body.price_cents, body.quantity, body.is_courtesy),
        )
        created = await cur.fetchone()
        if not created:
            raise HTTPException(
                409,
                "Ya existe un tipo con ese nombre en este evento"
                " (si estaba archivado, reactívalo en vez de crearlo)",
            )
        await db.commit()
    return created


# --------------------------------------------------------------------------
# Cupos de promotor
# --------------------------------------------------------------------------
@router.get("/events/{event_id}/allocations", response_model=list[AllocationOut])
async def list_allocations(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    _event_ctx(venue_id, user)
    async with db.cursor() as cur:
        await cur.execute(
            _ALLOCATION_SELECT
            + " WHERE a.event_id=%s AND e.venue_id=%s ORDER BY a.promoter_id",
            (event_id, venue_id),
        )
        return await cur.fetchall()


@router.post(
    "/events/{event_id}/allocations", response_model=AllocationOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_allocation(
    venue_id: int,
    event_id: int,
    body: AllocationCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        # verifica que el tipo de boleta pertenezca al evento
        await cur.execute(
            "SELECT id FROM ticket_types WHERE id=%s AND event_id=%s",
            (body.ticket_type_id, event_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Tipo de boleta no pertenece a este evento")
        await cur.execute(
            f"""
            INSERT INTO promoter_allocations AS a (event_id, ticket_type_id, promoter_id, capacity)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (event_id, ticket_type_id, promoter_id) DO UPDATE SET capacity=EXCLUDED.capacity
            """,
            (event_id, body.ticket_type_id, body.promoter_id, body.capacity),
        )
        # Re-leer el cupo (en vez de RETURNING) para incluir las boletas ya
        # emitidas: en un upsert de capacidad el conteo no viene en la fila.
        await cur.execute(
            _ALLOCATION_SELECT
            + " WHERE a.event_id=%s AND a.ticket_type_id=%s AND a.promoter_id=%s",
            (event_id, body.ticket_type_id, body.promoter_id),
        )
        created = await cur.fetchone()
        await db.commit()
    return created


@router.post(
    "/events/{event_id}/allocations/bulk",
    response_model=AllocationBulkOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_allocations_bulk(
    venue_id: int,
    event_id: int,
    body: AllocationBulkCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Reparte el aforo de un tipo entre varios promotores de una sola vez.

    Con P promotores, asignar de uno en uno son P formularios idénticos; aquí
    el admin elige a quiénes y el total, y el sistema hace la división. Todo
    el reparto vive en UN statement: o se crean todos los cupos o ninguno.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    promoters = list(dict.fromkeys(body.promoter_ids))  # sin duplicados
    n = len(promoters)
    per, remainder = divmod(body.total_capacity, n)
    # El resto de la división va a los primeros: la suma es EXACTA, nunca
    # "4.33 boletas". Determinista (mismo input → mismo reparto) para que el
    # admin pueda predecirlo.
    capacities = [per + (1 if i < remainder else 0) for i in range(n)]

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id FROM ticket_types WHERE id=%s AND event_id=%s",
            (body.ticket_type_id, event_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Tipo de boleta no pertenece a este evento")

        # Todos los promotores deben ser de la venue: asignar a un ajeno deja
        # un cupo que nadie puede usar.
        await cur.execute(
            """
            SELECT u.id FROM users u
            JOIN venue_user_roles r ON r.user_id = u.id
            WHERE r.venue_id = %s AND u.id = ANY(%s) AND u.is_active
            """,
            (venue_id, promoters),
        )
        valid = {row["id"] for row in await cur.fetchall()}
        missing = [p for p in promoters if p not in valid]
        if missing:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Hay personas que no son de tu equipo: " + ", ".join(map(str, missing)),
            )

        await cur.execute(
            """
            INSERT INTO promoter_allocations AS a
                   (event_id, ticket_type_id, promoter_id, capacity)
            SELECT %s, %s, pid, cap
            FROM unnest(%s::int[], %s::int[]) AS t(pid, cap)
            ON CONFLICT (event_id, ticket_type_id, promoter_id)
                DO UPDATE SET capacity = EXCLUDED.capacity
            """,
            (event_id, body.ticket_type_id, promoters, capacities),
        )
        await cur.execute(
            _ALLOCATION_SELECT
            + " WHERE a.event_id=%s AND a.ticket_type_id=%s AND a.promoter_id = ANY(%s)"
            " ORDER BY a.promoter_id",
            (event_id, body.ticket_type_id, promoters),
        )
        allocations = await cur.fetchall()
        await db.commit()
    return {
        "allocations": allocations,
        "per_promoter": per,
        "remainder": remainder,
    }


# --------------------------------------------------------------------------
# Editar / eliminar tipos de boleta
# --------------------------------------------------------------------------
@router.patch("/events/{event_id}/types/{type_id}", response_model=TicketTypeOut)
async def update_type(
    venue_id: int,
    event_id: int,
    type_id: int,
    body: TicketTypeUpdate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Edición parcial: solo se aplican los campos enviados.

    La validación que importa (no bajar `quantity` de lo ya emitido) vive en la
    DB, dentro de `update_ticket_type`, con lock sobre la fila del tipo.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        current = await _fetch_type(cur, venue_id, event_id, type_id)
        if not current:
            raise HTTPException(404, "Tipo de boleta no encontrado")

        # Sin los None: los campos NOT NULL nunca se envían vacíos a la DB.
        changes = {
            k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None
        }
        merged = {**current, **changes}

        try:
            await cur.execute(
                "SELECT update_ticket_type(%s, %s, %s, %s, %s, %s)",
                (
                    type_id,
                    merged["name"],
                    merged["price_cents"],
                    merged["quantity"],
                    merged["is_courtesy"],
                    merged["is_active"],
                ),
            )
        except psycopg.errors.Error as e:
            _edit_error(e)

        updated = await _fetch_type(cur, venue_id, event_id, type_id)
        # Auditoria (mig 019): precio y cupo son dinero — queda quien, cuando
        # y el antes/despues de lo que cambio realmente.
        money_fields = ("price_cents", "quantity", "is_courtesy", "is_active")
        diff = {
            f: {"antes": current[f], "despues": updated[f]}
            for f in money_fields
            if current.get(f) != updated.get(f)
        }
        if diff:
            await write_audit(
                cur, venue_id, user["id"], "ticket_type_change",
                "ticket_type", type_id, {"event_id": event_id, "cambios": diff},
            )
        await db.commit()
    return updated


@router.delete("/events/{event_id}/types/{type_id}", response_model=DeleteOut)
async def delete_type(
    venue_id: int,
    event_id: int,
    type_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Elimina el tipo si no tiene boletas; si las tiene, lo archiva.

    Borrar un tipo con historial rompería la trazabilidad de esas boletas (y el
    FK RESTRICT lo impediría de todos modos).
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        if not await _fetch_type(cur, venue_id, event_id, type_id):
            raise HTTPException(404, "Tipo de boleta no encontrado")
        try:
            await cur.execute("SELECT delete_ticket_type(%s)", (type_id,))
            row = await cur.fetchone()
        except psycopg.errors.Error as e:
            _edit_error(e)
        archived = bool(row["delete_ticket_type"])
        await db.commit()
    return DeleteOut(
        id=type_id,
        archived=archived,
        detail=(
            "Tipo archivado: conserva las boletas ya emitidas y deja de venderse."
            if archived
            else "Tipo eliminado."
        ),
    )


# --------------------------------------------------------------------------
# Editar / eliminar cupos de promotor
# --------------------------------------------------------------------------
@router.patch(
    "/events/{event_id}/allocations/{allocation_id}", response_model=AllocationOut
)
async def update_allocation(
    venue_id: int,
    event_id: int,
    allocation_id: int,
    body: AllocationUpdate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Edición parcial del cupo (capacidad y vigencia).

    Mover el cupo a otro promotor o a otro tipo no se admite aquí: se archiva y
    se crea el correcto, así el historial de ventas no cambia de dueño.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        current = await _fetch_allocation(cur, venue_id, event_id, allocation_id)
        if not current:
            raise HTTPException(404, "Cupo no encontrado")

        changes = {
            k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None
        }
        merged = {**current, **changes}

        try:
            await cur.execute(
                "SELECT update_promoter_allocation(%s, %s, %s)",
                (allocation_id, merged["capacity"], merged["is_active"]),
            )
        except psycopg.errors.Error as e:
            _edit_error(e)

        updated = await _fetch_allocation(cur, venue_id, event_id, allocation_id)
        # Auditoria (mig 019): el cupo define cuantas boletas puede vender
        # cada promotor — queda el antes/despues.
        if current.get("capacity") != updated.get("capacity") or current.get("is_active") != updated.get("is_active"):
            await write_audit(
                cur, venue_id, user["id"], "allocation_change",
                "allocation", allocation_id,
                {
                    "event_id": event_id,
                    "capacity": {"antes": current.get("capacity"), "despues": updated.get("capacity")},
                    "is_active": {"antes": current.get("is_active"), "despues": updated.get("is_active")},
                },
            )
        await db.commit()
    return updated


@router.delete(
    "/events/{event_id}/allocations/{allocation_id}", response_model=DeleteOut
)
async def delete_allocation(
    venue_id: int,
    event_id: int,
    allocation_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Elimina el cupo si no tiene boletas; si las tiene, lo archiva."""
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        if not await _fetch_allocation(cur, venue_id, event_id, allocation_id):
            raise HTTPException(404, "Cupo no encontrado")
        try:
            await cur.execute("SELECT delete_promoter_allocation(%s)", (allocation_id,))
            row = await cur.fetchone()
        except psycopg.errors.Error as e:
            _edit_error(e)
        archived = bool(row["delete_promoter_allocation"])
        await db.commit()
    return DeleteOut(
        id=allocation_id,
        archived=archived,
        detail=(
            "Cupo archivado: conserva las boletas ya emitidas y deja de usarse."
            if archived
            else "Cupo eliminado."
        ),
    )