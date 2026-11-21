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
from app.schemas import ExitIn, ExitOut, OccupancyOut, ScannerStats

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


@router.get("/events/{event_id}/occupancy", response_model=OccupancyOut)
async def event_occupancy(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Cuánta gente hay ADENTRO ahora mismo, y cuánto lugar queda.

    Es la cifra que manda para el aforo, y la que el tablero refresca. Se
    separa de `/pulse` (que cuenta ingresos acumulados) porque significan
    cosas distintas: `pulse` responde "cómo va la noche", esto responde
    "puedo dejar entrar a alguien más".
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await cur.execute(
            # to_jsonb: la columna nace en la 052. Si produccion va por detras
            # del codigo, leerla directo da 500 y deja al bouncer sin pantalla
            # en plena puerta. Faltante -> false, no error.
            """SELECT id,
                      coalesce(
                        (to_jsonb(events) ->> 'allow_reentry')::boolean, false
                      ) AS allow_reentry
                 FROM events WHERE id=%s AND venue_id=%s""",
            (event_id, venue_id),
        )
        ev = await cur.fetchone()
        if not ev:
            raise HTTPException(404, "Evento no encontrado")

        await cur.execute("SELECT * FROM event_occupancy(%s)", (event_id,))
        row = await cur.fetchone()

    return OccupancyOut(
        event_id=event_id,
        allow_reentry=ev["allow_reentry"],
        free_seats=max(row["capacity"] - row["inside"], 0),
        **row,
    )


@router.post("/events/{event_id}/exit", response_model=ExitOut)
async def register_exit(
    venue_id: int,
    event_id: int,
    body: ExitIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Registra que una persona SALE del recinto.

    Sin egreso no hay aforo que valga: si nadie puede salir, `inside` solo
    crece y el tope bloquea el recinto para siempre. También es lo que
    habilita el reingreso en los eventos que lo permiten.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id FROM events WHERE id=%s AND venue_id=%s",
            (event_id, venue_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")

        try:
            await cur.execute(
                "SELECT register_exit(%s, %s, %s, NULL, %s)",
                (event_id, body.raw_token, user["id"], body.door_id),
            )
            row = await cur.fetchone()
            code = row["register_exit"] if isinstance(row, dict) else row[0]
            await db.commit()
        except psycopg.errors.Error:
            await db.rollback()
            raise HTTPException(400, "No se pudo registrar la salida")

    out = ExitOut(code=code, exited=(code == "EXITED"))
    if code in ("EXITED", "ALREADY_OUTSIDE"):
        # El nombre es lo que el operador reconoce en la puerta.
        async with db.cursor() as cur:
            await cur.execute(
                """
                SELECT id, customer_name FROM tickets
                 WHERE token_hash = encode(digest(%s, 'sha256'), 'hex')
                """,
                (body.raw_token,),
            )
            t = await cur.fetchone()
        if t:
            out.ticket_id = t["id"]
            out.customer_name = t["customer_name"]
    return out
