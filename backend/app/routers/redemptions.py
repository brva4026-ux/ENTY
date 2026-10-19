"""Registro de la puerta, escaneo por escaneo.

La tabla `redemptions` guarda TODO intento de escaneo (exitoso o no) desde el
Sprint 2, y `/summary` ya agregaba conteos. Lo que faltaba era el detalle:
reconstruir que a las 23:14 el QR del invitado X se leyo dos veces, o que un
token desconocido aparecio 9 veces seguidas en la puerta 2. Ese registro es
la evidencia cuando hay una discusion con un promotor o un portero.

Privilegios (patron de admin-gaps 2.3): `/summary` expone conteos y este
router expone el detalle fila por fila, asi que el acceso es el mismo que
para la caja: solo `super_admin`/`admin` de la venue. El promotor no ve el
log de escaneos de otros; el bouncer registra y no audita ajenos.

Filtros: `outcome`, `q` (nombre/telefono de la boleta o nombre del portero)
y `since`/`until` (ISO 8601, para el cierre de caja del dia). Respuestas:
`?format=csv` baja el archivo (patron del export de invitados); sin formato,
JSON paginado `{ total, items }`.
"""

import csv
import io
from datetime import datetime
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Response

from app.core.audit import write_audit
from app.core.db import get_db
from app.deps import ensure_roles, get_current_user

router = APIRouter(prefix="/venues/{venue_id}", tags=["puerta"])

# Auditoria de la mig 019: leer el registro de puerta es leer datos
# personales (quien entro, quien escaneo), mismo tratamiento que el export
# de invitados.
_EVENT_KIND = "redemptions_export"

_REDEMPTIONS_WHERE = """
    FROM redemptions r
    LEFT JOIN tickets t ON t.id = r.ticket_id
    LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
    LEFT JOIN users u ON u.id = r.scanned_by_user_id
    WHERE r.event_id = %(ev)s
      AND (%(outcome)s::text IS NULL OR r.outcome = %(outcome)s::text)
      AND (%(q)s::text IS NULL OR
          t.customer_name ILIKE %(like)s OR
          t.customer_phone ILIKE %(like)s OR
          u.full_name ILIKE %(like)s)
      AND (%(since)s::timestamptz IS NULL OR r.scanned_at >= %(since)s::timestamptz)
      AND (%(until)s::timestamptz IS NULL OR r.scanned_at <  %(until)s::timestamptz)
"""


def _filters(
    outcome: str | None,
    q: str | None,
    since: datetime | None,
    until: datetime | None,
) -> dict:
    if outcome is not None and outcome not in (
        "granted", "granted_forced", "already_redeemed", "not_found",
        "invalid_event", "event_not_live", "not_active", "wrong_type",
        "not_valid",
    ):
        raise HTTPException(422, "outcome invalido")
    like = f"%{q}%" if q else None
    return {"outcome": outcome, "q": q, "like": like, "since": since, "until": until}


async def _event_or_404(cur, event_id: int, venue_id: int) -> dict:
    await cur.execute(
        "SELECT id, name FROM events WHERE id = %s AND venue_id = %s",
        (event_id, venue_id),
    )
    ev = await cur.fetchone()
    if not ev:
        raise HTTPException(404, "Evento no encontrado")
    return ev


@router.get("/events/{event_id}/redemptions")
async def list_redemptions(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    outcome: Annotated[str | None, Query()] = None,
    q: Annotated[str | None, Query()] = None,
    since: Annotated[datetime | None, Query()] = None,
    until: Annotated[datetime | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """Detalle de la puerta: un item por intento de escaneo, mas reciente primero.

    Nunca expone tokens: el hash identifica la boleta y el nombre/telefono
    del invitado ya son visibles para el admin en el listado de boletas.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    f = _filters(outcome, q, since, until)
    async with db.cursor() as cur:
        ev = await _event_or_404(cur, event_id, venue_id)
        await cur.execute(
            f"SELECT count(*)::int AS n {_REDEMPTIONS_WHERE}", {**f, "ev": event_id}
        )
        total = (await cur.fetchone())["n"]
        await cur.execute(
            f"""
            SELECT r.id,
                   r.scanned_at,
                   r.outcome,
                   r.ticket_id,
                   t.customer_name,
                   t.customer_phone,
                   t.status AS ticket_status,
                   tt.name AS type_name,
                   u.full_name AS scanned_by
            {_REDEMPTIONS_WHERE}
            ORDER BY r.scanned_at DESC, r.id DESC
            LIMIT %(limit)s OFFSET %(offset)s
            """,
            {
                **f,
                "ev": event_id,
                "limit": limit,
                "offset": offset,
            },
        )
        rows = await cur.fetchall()
        await db.commit()
    return {
        "event_id": ev["id"],
        "event_name": ev["name"],
        "total": total,
        "items": [
            {
                "id": r["id"],
                "scanned_at": r["scanned_at"],
                "outcome": r["outcome"],
                "ticket_id": r["ticket_id"],
                "customer_name": r["customer_name"],
                "customer_phone": r["customer_phone"],
                "ticket_status": r["ticket_status"],
                "type_name": r["type_name"],
                "scanned_by": r["scanned_by"],
            }
            for r in rows
        ],
    }


@router.get("/events/{event_id}/redemptions.csv")
async def export_redemptions_csv(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    outcome: Annotated[str | None, Query()] = None,
    q: Annotated[str | None, Query()] = None,
    since: Annotated[datetime | None, Query()] = None,
    until: Annotated[datetime | None, Query()] = None,
):
    """Cierre de caja de la puerta: el registro completo (con filtro) en CSV.

    Devuelve TODO lo que matchea el filtro, no una pagina: el cierre es un
    archivo, no un scroll. Se audita como el resto de exportaciones (mig 019).
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    f = _filters(outcome, q, since, until)
    async with db.cursor() as cur:
        ev = await _event_or_404(cur, event_id, venue_id)
        await cur.execute(
            f"""
            SELECT r.id,
                   r.scanned_at,
                   r.outcome,
                   t.id AS ticket_num,
                   t.customer_name,
                   t.customer_phone,
                   t.status AS ticket_status,
                   tt.name AS type_name,
                   u.full_name AS scanned_by
            {_REDEMPTIONS_WHERE}
            ORDER BY r.scanned_at ASC, r.id ASC
            """,
            {**f, "ev": event_id},
        )
        rows = await cur.fetchall()
        # await OBLIGATORIO: write_audit es async; sin await la corrutina no
        # se ejecuta nunca y la descarga quedaria sin auditoria (silenciosa).
        await write_audit(
            cur, venue_id, user["id"], _EVENT_KIND, "event", event_id,
            {"formato": "csv", "filas": len(rows), "outcome": outcome,
             "q": q, "since": since.isoformat() if since else None,
             "until": until.isoformat() if until else None},
        )
        await db.commit()

    OUTCOME_ES = {
        "granted": "ENTRADA",
        "granted_forced": "ENTRADA (forzada por staff)",
        "already_redeemed": "DUPLICADO (ya usada)",
        "not_found": "QR DESCONOCIDO",
        "invalid_event": "BOLETA DE OTRO EVENTO",
        "event_not_live": "EVENTO NO ABIERTO",
        "not_active": "QR AUN NO ACTIVO",
        "wrong_type": "TIPO EQUIVOCADO",
        "not_valid": "ANULADA / REEMBOLSADA",
    }
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["fecha", "hora", "resultado", "boleta", "invitado", "telefono",
                "estado_boleta", "tipo", "escaneo_por"])
    data = [
        [
            r["scanned_at"].strftime("%Y-%m-%d"),
            r["scanned_at"].strftime("%H:%M:%S"),
            OUTCOME_ES.get(r["outcome"], r["outcome"]),
            r["ticket_num"] or "",
            r["customer_name"] or "",
            r["customer_phone"] or "",
            r["ticket_status"] or "",
            r["type_name"] or "",
            r["scanned_by"] or "",
        ]
        for r in rows
    ]
    w.writerows(data)
    content = "\ufeff" + buf.getvalue()
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="puerta-evento-{event_id}.csv"',
            "Cache-Control": "no-store",
        },
    )
