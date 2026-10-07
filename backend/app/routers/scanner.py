"""Lo que hizo ESTE escáner en la noche (contador del turno en puerta).

Por qué existe como endpoint propio y no dentro de `/pulse`:

- `/pulse` es el pulso del EVENTO (cuántos entraron en total, cuánto aforo
  queda) y lo consume también el promotor para su nudge de cupo. Meterle un
  campo por-usuario le cambiaría el significado a una respuesta compartida.
- El bouncer necesita, además, saber si la noche la está trabajando él: en un
  evento con dos puertas, "ingresaron 80" no dice si su escáner movió 3 o 77.
  Ese dato sale de `redemptions.scanned_by_user_id` (con índice propio,
  `idx_redemptions_scanner`), que ya guarda quién escaneó cada boleta.

No expone dinero ni datos de otros escáneres: solo los números del propio
usuario en ese evento.
"""
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import ScannerStats

router = APIRouter(prefix="/venues/{venue_id}", tags=["puerta"])


@router.get("/events/{event_id}/scanner-stats", response_model=ScannerStats)
async def event_scanner_stats(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Cuántos ingresos hizo ESTE escáner en esta noche.

    Un solo statement: los tres contadores salen del mismo log de la puerta,
    con los mismos criterios que el reporte (`granted` + `granted_forced`
    cuentan como ingreso; el resto es rechazo, separando el reuso).
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        # El evento tiene que ser DE ESTA venue: el contador no se filtra por
        # evento ajeno (mismo guard que el resto de los endpoints del evento).
        await cur.execute(
            "SELECT id FROM events WHERE id=%s AND venue_id=%s",
            (event_id, venue_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")

        await cur.execute(
            """
            SELECT count(*) FILTER
                       (WHERE outcome IN ('granted','granted_forced'))::int AS granted,
                   count(*) FILTER
                       (WHERE outcome = 'already_redeemed')::int AS already_redeemed,
                   count(*) FILTER
                       (WHERE outcome NOT IN
                           ('granted','granted_forced','already_redeemed'))::int
                       AS rejected
            FROM redemptions
            WHERE event_id = %s AND scanned_by_user_id = %s
            """,
            (event_id, user["id"]),
        )
        row = await cur.fetchone()

    return ScannerStats(event_id=event_id, **row)
