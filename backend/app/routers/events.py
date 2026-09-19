"""CRUD de eventos, tipos de boleta y asignacion de cupos a promotores."""
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    AllocationCreate,
    AllocationOut,
    AllocationUpdate,
    DeleteOut,
    EventCreate,
    EventOut,
    EventUpdate,
    MessageOut,
    TicketTypeCreate,
    TicketTypeOut,
    TicketTypeUpdate,
)

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
    "id, venue_id, name, description, flyer_url, starts_at, ends_at, "
    "event_timezone, capacity, status"
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
    """Traduce los errores de negocio de editar/eliminar (migracion 004)."""
    diag = getattr(e, "diag", None)
    primary = getattr(diag, "message_primary", "") or str(e)
    constraint = getattr(diag, "constraint_name", "") or ""

    if "ticket_type_not_found" in primary:
        raise HTTPException(404, "Tipo de boleta no encontrado")
    if "allocation_not_found" in primary:
        raise HTTPException(404, "Cupo no encontrado")
    if "quantity_below_issued" in primary:
        raise HTTPException(
            409, "No puedes dejar la cantidad por debajo de las boletas ya emitidas"
        )
    if "capacity_below_used" in primary:
        raise HTTPException(
            409, "No puedes dejar la capacidad por debajo de las boletas ya emitidas"
        )
    if "capacity_cannot_be_below_issued" in primary:
        # Aforo del evento (update_event y trigger events_check_capacity).
        raise HTTPException(
            409, "No puedes bajar el aforo por debajo de las boletas ya emitidas"
        )
    if "invalid_quantity" in primary:
        raise HTTPException(400, "La cantidad debe ser mayor que cero")
    if "invalid_capacity" in primary:
        raise HTTPException(400, "La capacidad no puede ser negativa")
    if "invalid_window" in primary or "starts_at_in_past" in primary:
        raise HTTPException(
            400,
            "La ventana del evento no es válida: el cierre debe ser posterior a "
            "la apertura y la apertura no puede estar en el pasado",
        )
    if "ticket_types_event_id_name_key" in primary or constraint == "ticket_types_event_id_name_key":
        raise HTTPException(
            409, "Ya existe un tipo con ese nombre en este evento"
            " (si estaba archivado, reactívalo en vez de crearlo)"
        )
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
@router.get("/events", response_model=list[EventOut])
async def list_events(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    _event_ctx(venue_id, user)
    async with db.cursor() as cur:
        await cur.execute(
            f"SELECT {EVENT_COLUMNS} FROM events "
            "WHERE venue_id=%s ORDER BY starts_at DESC",
            (venue_id,),
        )
        return await cur.fetchall()


@router.post("/events", response_model=EventOut, status_code=status.HTTP_201_CREATED)
async def create_event(
    venue_id: int,
    body: EventCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute(
            f"""
            INSERT INTO events (venue_id, name, description, flyer_url,
                                starts_at, ends_at, event_timezone, capacity, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'draft')
            RETURNING {EVENT_COLUMNS}
            """,
            (
                venue_id,
                body.name,
                body.description,
                # HttpUrl -> texto plano para la columna flyer_url
                str(body.flyer_url) if body.flyer_url else None,
                body.starts_at,
                body.ends_at,
                body.event_timezone,
                body.capacity,
            ),
        )
        created = await cur.fetchone()
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