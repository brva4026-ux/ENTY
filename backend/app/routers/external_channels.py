"""Canal invitado: boletas vendidas fuera de Enty, operadas en la puerta.

El piloto no depende de una API de terceros. El organizador importa las
boletas del proveedor y Enty las valida con el mismo escáner, conservando el
origen y una conciliación por canal. El token crudo nunca se guarda.
"""
import hashlib
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from psycopg.types.json import Jsonb

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    ExternalChannelCreate,
    ExternalChannelOut,
    ExternalChannelTicketOut,
    ExternalChannelUpdate,
    ExternalReconciliationOut,
    ExternalTicketImportError,
    ExternalTicketImportIn,
    ExternalTicketImportOut,
)

router = APIRouter(prefix="/venues/{venue_id}", tags=["canal invitado"])

_CHANNEL_SELECT = """
    SELECT c.id, c.event_id, c.name, c.provider_name, c.ticket_type_id,
           tt.name AS ticket_type_name, tt.zone_id,
           z.name AS zone_name, c.confirmation_owner, c.status,
           c.created_at, c.updated_at,
           count(t.id)::int AS total,
           count(t.id) FILTER (WHERE t.status = 'issued')::int AS valid,
           count(t.id) FILTER (WHERE t.status = 'redeemed')::int AS redeemed,
           count(t.id) FILTER (WHERE t.status IN ('voided', 'refunded'))::int
               AS voided,
           (SELECT max(i.created_at) FROM external_ticket_imports i
             WHERE i.channel_id = c.id) AS last_import_at
      FROM event_external_channels c
      JOIN ticket_types tt ON tt.id = c.ticket_type_id
      LEFT JOIN event_zones z ON z.id = tt.zone_id
      LEFT JOIN tickets t ON t.external_channel_id = c.id
     WHERE c.venue_id = %s AND c.event_id = %s
"""


async def _event(cur, venue_id: int, event_id: int) -> dict:
    await cur.execute(
        "SELECT id, name, capacity, status FROM events"
        " WHERE id=%s AND venue_id=%s",
        (event_id, venue_id),
    )
    row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Evento no encontrado")
    return row


async def _channel(
    cur, venue_id: int, event_id: int, channel_id: int, *, for_update: bool = False
) -> dict:
    if for_update:
        await cur.execute(
            "SELECT id FROM event_external_channels"
            " WHERE id=%s AND venue_id=%s AND event_id=%s FOR UPDATE",
            (channel_id, venue_id, event_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Canal invitado no encontrado")
    await cur.execute(
        _CHANNEL_SELECT + " AND c.id=%s GROUP BY c.id, tt.name, tt.zone_id, z.name",
        (venue_id, event_id, channel_id),
    )
    row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Canal invitado no encontrado")
    return row


async def _assert_zone(cur, event_id: int, zone_id: int | None) -> None:
    if zone_id is None:
        return
    await cur.execute(
        "SELECT 1 FROM event_zones WHERE id=%s AND event_id=%s",
        (zone_id, event_id),
    )
    if not await cur.fetchone():
        raise HTTPException(404, "La zona no pertenece a este evento")


@router.get(
    "/events/{event_id}/external-channels",
    response_model=list[ExternalChannelOut],
)
async def list_external_channels(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await cur.execute(
            _CHANNEL_SELECT
            + " GROUP BY c.id, tt.name, tt.zone_id, z.name"
            + " ORDER BY c.created_at DESC, c.id DESC",
            (venue_id, event_id),
        )
        return await cur.fetchall()


@router.post(
    "/events/{event_id}/external-channels",
    response_model=ExternalChannelOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_external_channel(
    venue_id: int,
    event_id: int,
    body: ExternalChannelCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await _assert_zone(cur, event_id, body.zone_id)
        try:
            # Localidad técnica oculta: ocupa aforo, no inventario público.
            await cur.execute(
                """
                INSERT INTO ticket_types
                    (event_id, name, price_cents, quantity, is_courtesy,
                     is_active, is_external, zone_id)
                VALUES (%s, %s, 0, 1, true, true, true, %s)
                RETURNING id
                """,
                (event_id, f"Invitado · {body.name}"[:60], body.zone_id),
            )
            type_id = (await cur.fetchone())["id"]
            await cur.execute(
                """
                INSERT INTO event_external_channels
                    (venue_id, event_id, ticket_type_id, name, provider_name,
                     confirmation_owner, created_by_user_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    venue_id,
                    event_id,
                    type_id,
                    body.name.strip(),
                    body.provider_name.strip(),
                    body.confirmation_owner,
                    user["id"],
                ),
            )
            channel_id = (await cur.fetchone())["id"]
            await db.commit()
        except psycopg.errors.UniqueViolation:
            await db.rollback()
            raise HTTPException(409, "Ya existe un canal con ese nombre en el evento")
        except psycopg.errors.Error:
            await db.rollback()
            raise
    async with db.cursor() as cur_out:
        return await _channel(cur_out, venue_id, event_id, channel_id)


@router.patch(
    "/events/{event_id}/external-channels/{channel_id}",
    response_model=ExternalChannelOut,
)
async def update_external_channel(
    venue_id: int,
    event_id: int,
    channel_id: int,
    body: ExternalChannelUpdate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        current = await _channel(cur, venue_id, event_id, channel_id)
        data = body.model_dump(exclude_unset=True)
        if "zone_id" in data:
            await _assert_zone(cur, event_id, data["zone_id"])
        try:
            await cur.execute(
                """
                UPDATE event_external_channels
                   SET name = COALESCE(%s, name),
                       provider_name = COALESCE(%s, provider_name),
                       confirmation_owner = COALESCE(%s, confirmation_owner),
                       status = COALESCE(%s, status),
                       updated_at = now()
                 WHERE id=%s
                """,
                (
                    data.get("name"),
                    data.get("provider_name"),
                    data.get("confirmation_owner"),
                    data.get("status"),
                    channel_id,
                ),
            )
            if "name" in data or "zone_id" in data:
                await cur.execute(
                    """
                    UPDATE ticket_types
                       SET name = COALESCE(%s, name),
                           zone_id = COALESCE(%s, zone_id)
                     WHERE id=%s
                    """,
                    (
                        f"Invitado · {data['name']}"[:60] if "name" in data else None,
                        data.get("zone_id"),
                        current["ticket_type_id"],
                    ),
                )
            await db.commit()
        except psycopg.errors.UniqueViolation:
            await db.rollback()
            raise HTTPException(409, "Ya existe un canal con ese nombre en el evento")
    async with db.cursor() as cur_out:
        return await _channel(cur_out, venue_id, event_id, channel_id)


@router.post(
    "/events/{event_id}/external-channels/{channel_id}/import",
    response_model=ExternalTicketImportOut,
)
async def import_external_tickets(
    venue_id: int,
    event_id: int,
    channel_id: int,
    body: ExternalTicketImportIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Importa o actualiza boletas del canal.

    La validación es por lote: primero se detectan duplicados y colisiones de
    token, y solo las filas limpias llegan al UPSERT. Así una fila mala no
    revierte las buenas ni deja la importación a medias.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    errors: list[ExternalTicketImportError] = []
    clean: list[dict] = []
    seen_ext: set[str] = set()
    seen_token: set[str] = set()

    for index, row in enumerate(body.rows, start=1):
        ext = row.external_ticket_id.strip()
        token = row.token.strip()
        name = row.holder_name.strip()
        if not ext or not token or not name:
            errors.append(
                ExternalTicketImportError(
                    row=index,
                    external_ticket_id=ext or None,
                    message="Falta id externo, token o nombre",
                )
            )
            continue
        digest = hashlib.sha256(token.encode()).hexdigest()
        if ext in seen_ext:
            errors.append(
                ExternalTicketImportError(
                    row=index,
                    external_ticket_id=ext,
                    message="Id externo repetido en el archivo",
                )
            )
            continue
        if digest in seen_token:
            errors.append(
                ExternalTicketImportError(
                    row=index,
                    external_ticket_id=ext,
                    message="Token repetido en el archivo",
                )
            )
            continue
        seen_ext.add(ext)
        seen_token.add(digest)
        clean.append(
            {
                "row": index,
                "external_ticket_id": ext,
                "token_hash": digest,
                "holder_name": name,
                "holder_phone": row.holder_phone.strip() if row.holder_phone else None,
                "holder_email": row.holder_email.strip() if row.holder_email else None,
                "status": row.status,
            }
        )

    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        channel = await _channel(
            cur, venue_id, event_id, channel_id, for_update=True
        )

        ext_ids = [r["external_ticket_id"] for r in clean]
        existing_by_ext: dict[str, dict] = {}
        if ext_ids:
            await cur.execute(
                """
                SELECT id, external_ticket_id, token_hash, origin
                  FROM tickets
                 WHERE external_channel_id=%s
                   AND external_ticket_id = ANY(%s)
                """,
                (channel_id, ext_ids),
            )
            existing_by_ext = {
                r["external_ticket_id"]: r for r in await cur.fetchall()
            }

        token_owner: dict[str, dict] = {}
        if clean:
            await cur.execute(
                """
                SELECT id, token_hash, external_channel_id, external_ticket_id
                  FROM tickets
                 WHERE token_hash = ANY(%s)
                """,
                ([r["token_hash"] for r in clean],),
            )
            token_owner = {r["token_hash"]: r for r in await cur.fetchall()}

        imported = updated = 0
        for row in clean:
            existing = existing_by_ext.get(row["external_ticket_id"])
            owner = token_owner.get(row["token_hash"])
            if owner and (not existing or owner["id"] != existing["id"]):
                errors.append(
                    ExternalTicketImportError(
                        row=row["row"],
                        external_ticket_id=row["external_ticket_id"],
                        message="Ese token ya pertenece a otra boleta",
                    )
                )
                continue
            if existing and existing["origin"] != "external":
                errors.append(
                    ExternalTicketImportError(
                        row=row["row"],
                        external_ticket_id=row["external_ticket_id"],
                        message="El id externo choca con una boleta de Enty",
                    )
                )
                continue

            db_status = {
                "valid": "issued",
                "void": "voided",
                "used": "redeemed",
            }[row["status"]]
            await cur.execute(
                """
                INSERT INTO tickets (
                    event_id, ticket_type_id, allocation_id, sold_by_user_id,
                    customer_name, customer_phone, customer_email,
                    customer_birth_date, token_hash, status,
                    price_cents_snapshot, payment_method, origin,
                    external_channel_id, external_ticket_id,
                    issued_at, voided_at, redeemed_at
                ) VALUES (
                    %s, %s, NULL, NULL, %s, %s, %s, NULL, %s,
                    %s::ticket_status, 0, 'cortesia', 'external', %s, %s,
                    now(),
                    CASE WHEN %s = 'voided' THEN now() ELSE NULL END,
                    CASE WHEN %s = 'redeemed' THEN now() ELSE NULL END
                )
                ON CONFLICT (external_channel_id, external_ticket_id)
                DO UPDATE SET
                    customer_name = EXCLUDED.customer_name,
                    customer_phone = EXCLUDED.customer_phone,
                    customer_email = EXCLUDED.customer_email,
                    token_hash = EXCLUDED.token_hash,
                    status = CASE
                        WHEN EXCLUDED.status = 'voided' THEN 'voided'::ticket_status
                        WHEN tickets.status = 'redeemed' THEN 'redeemed'::ticket_status
                        WHEN EXCLUDED.status = 'redeemed' THEN 'redeemed'::ticket_status
                        ELSE 'issued'::ticket_status
                    END,
                    voided_at = CASE
                        WHEN EXCLUDED.status = 'voided' THEN now()
                        ELSE NULL
                    END,
                    redeemed_at = CASE
                        WHEN EXCLUDED.status = 'voided' THEN NULL
                        WHEN tickets.status = 'redeemed' THEN tickets.redeemed_at
                        WHEN EXCLUDED.status = 'redeemed' THEN now()
                        ELSE NULL
                    END,
                    updated_at = now()
                """,
                (
                    event_id,
                    channel["ticket_type_id"],
                    row["holder_name"],
                    row["holder_phone"],
                    row["holder_email"],
                    row["token_hash"],
                    db_status,
                    channel_id,
                    row["external_ticket_id"],
                    db_status,
                    db_status,
                ),
            )
            if existing:
                updated += 1
            else:
                imported += 1

        await cur.execute(
            """
            INSERT INTO external_ticket_imports
                (channel_id, imported_by_user_id, filename, rows_total,
                 rows_imported, rows_updated, rows_skipped, errors)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                channel_id,
                user["id"],
                body.filename,
                len(body.rows),
                imported,
                updated,
                len(errors),
                Jsonb([e.model_dump() for e in errors]),
            ),
        )
        await db.commit()

    return ExternalTicketImportOut(
        total=len(body.rows),
        imported=imported,
        updated=updated,
        skipped=len(errors),
        errors=errors,
    )


@router.get(
    "/events/{event_id}/external-channels/{channel_id}/tickets",
    response_model=list[ExternalChannelTicketOut],
)
async def list_external_tickets(
    venue_id: int,
    event_id: int,
    channel_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    ticket_status: Annotated[str | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        await _event(cur, venue_id, event_id)
        await _channel(cur, venue_id, event_id, channel_id)
        params: list = [channel_id]
        where = "t.external_channel_id=%s"
        if ticket_status:
            where += " AND t.status=%s"
            params.append(ticket_status)
        params.append(limit)
        await cur.execute(
            f"""
            SELECT t.id, t.external_ticket_id, t.customer_name,
                   t.customer_phone, t.customer_email, t.status::text AS status,
                   t.redeemed_at, t.updated_at
              FROM tickets t
             WHERE {where}
             ORDER BY t.external_ticket_id, t.id
             LIMIT %s
            """,
            params,
        )
        return await cur.fetchall()


@router.get(
    "/events/{event_id}/external-channels/{channel_id}/reconciliation",
    response_model=ExternalReconciliationOut,
)
async def external_reconciliation(
    venue_id: int,
    event_id: int,
    channel_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    async with db.cursor() as cur:
        event = await _event(cur, venue_id, event_id)
        channel = await _channel(cur, venue_id, event_id, channel_id)
        await cur.execute(
            """
            SELECT min(r.scanned_at) AS first_scan_at,
                   max(r.scanned_at) AS last_scan_at
              FROM redemptions r
              JOIN tickets t ON t.id=r.ticket_id
             WHERE t.external_channel_id=%s
               AND r.outcome IN ('granted', 'granted_forced')
            """,
            (channel_id,),
        )
        scans = await cur.fetchone()
        await cur.execute(
            """
            SELECT COALESCE(r.door_id, 'sin puerta') AS door_id,
                   count(*)::int AS count
              FROM redemptions r
              JOIN tickets t ON t.id=r.ticket_id
             WHERE t.external_channel_id=%s
               AND r.outcome IN ('granted', 'granted_forced')
             GROUP BY 1
             ORDER BY count DESC, door_id
            """,
            (channel_id,),
        )
        by_door = await cur.fetchall()
        await cur.execute(
            """
            SELECT count(*) FILTER (WHERE status IN ('issued', 'redeemed'))::int
                       AS active_total,
                   count(*) FILTER (WHERE status IN ('issued', 'redeemed')
                                      AND origin='external')::int AS external_total
              FROM tickets WHERE event_id=%s
            """,
            (event_id,),
        )
        totals = await cur.fetchone()

    return ExternalReconciliationOut(
        channel=channel,
        total=channel["total"],
        valid=channel["valid"],
        redeemed=channel["redeemed"],
        voided=channel["voided"],
        first_scan_at=scans["first_scan_at"],
        last_scan_at=scans["last_scan_at"],
        by_door=by_door,
        capacity=event["capacity"],
        active_total=totals["active_total"],
        external_total=totals["external_total"],
        capacity_warning=totals["active_total"] > event["capacity"],
    )
