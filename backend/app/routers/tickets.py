"""Emision y redencion de boletas.

La logica transaccional vive en la DB (emit_ticket/redeem_ticket). Aqui solo
expresamos los parametros y generamos el token crudo de alta entropia que va
en el QR (en la DB se guarda unicamente su SHA-256).
"""
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated
from zoneinfo import ZoneInfo

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.db import get_db
from app.core.db_errors import translate_db_error
from app.core.lifecycle import auto_close_expired
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    DoorSnapshotEntry,
    DoorSnapshotOut,
    DoorSyncItem,
    DoorSyncOut,
    DoorSyncResult,
    RedeemOut,
    TicketContactEditRequest,
    TicketContactEditOut,
    TicketContactEditResponse,
    TicketEmitRequest,
    TicketEmitResponse,
    TicketHistoryItem,
    TicketHistoryOut,
    TicketRedeemRequest,
    TicketReissueRequest,
    TicketReissueResponse,
    TicketReturnOut,
)

router = APIRouter(prefix="/venues/{venue_id}", tags=["tickets"])


# ---------------------------------------------------------------------------
# Modo offline de puerta (snapshot + sync)
#
# El canje normal es server-autoritativo y sigue siéndolo. Esto existe para
# el caso real de un roncino sin señal: el escáner descarga los HASHES de
# las boletas vivas ANTES de que se caiga la red, valida localmente y envía
# las redenciones cuando vuelve la conexión. La DB re-evalúa cada token con
# redeem_ticket al sincronizar, así que el árbitro final sigue siendo la DB.
# ---------------------------------------------------------------------------


def _handle(venue_id: int, e: psycopg.errors.Error) -> None:
    """Errores SQL de negocio a HTTP, con el mapa único de `db_errors`.

    Solo se sobreescriben los mensajes donde la puerta de emisión aporta algo
    que el texto canónico no dice (el escáner manda a elegir otro evento; el
    tipo se busca dentro del evento abierto). El resto sale del mapa único,
    para que el mismo error no suene distinto según por dónde entró.
    """
    http = translate_db_error(
        e,
        overrides={
            "ticket_type_not_found": (404, "Ese tipo de boleta no existe en este evento"),
            "event_not_found": (
                404,
                "El evento de este escaneo ya no existe: selecciona otro en el escaner",
            ),
            "return_window_closed": (
                409,
                "La ventana de devolucion cerro: el QR ya esta activo",
            ),
        },
    )
    if http is not None:
        raise http
    raise e


@router.post("/events/{event_id}/tickets", response_model=TicketEmitResponse, status_code=201)
async def emit_ticket(
    venue_id: int,
    event_id: int,
    body: TicketEmitRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    raw_token = secrets.token_urlsafe(24)  # ~32 bytes de entropia -> va al QR

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")

        try:
            await cur.execute(
                """
                SELECT emit_ticket(%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    event_id,
                    body.ticket_type_id,
                    body.allocation_id,
                    user["id"],
                    body.customer_name,
                    raw_token,
                    body.customer_phone,
                    body.customer_email,
                ),
            )
            row = await cur.fetchone()
            await db.commit()
        except psycopg.errors.Error as e:
            _handle(venue_id, e)

    ticket_id = row["emit_ticket"] if isinstance(row, dict) else row[0]
    return TicketEmitResponse(ticket_id=ticket_id, raw_token=raw_token, status="issued")


@router.get("/events/{event_id}/tickets/mine", response_model=TicketHistoryOut)
async def my_tickets(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Historial de boletas emitidas por el usuario actual en este evento.

    Visible para cualquier rol de la venue (el promotor ve lo suyo; el admin
    tambien puede llamarlo para auditar emisiones de un usuario puntual).
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")

        await cur.execute(
            """
            SELECT t.id, t.customer_name, t.customer_phone, t.status::text AS status,
                   t.issued_at, tt.name AS ticket_type, tt.is_courtesy
            FROM tickets t
            JOIN ticket_types tt ON tt.id = t.ticket_type_id
            WHERE t.event_id = %s AND t.sold_by_user_id = %s
            ORDER BY t.issued_at DESC, t.id DESC
            LIMIT 100
            """,
            (event_id, user["id"]),
        )
        rows = await cur.fetchall()

    return TicketHistoryOut(
        tickets=[
            TicketHistoryItem(
                ticket_id=r["id"],
                customer_name=r["customer_name"],
                customer_phone=r["customer_phone"],
                ticket_type=r["ticket_type"],
                is_courtesy=r["is_courtesy"] or False,
                status=r["status"],
                issued_at=r["issued_at"],
            )
            for r in rows
        ]
    )


@router.post("/events/{event_id}/redeem", response_model=RedeemOut)
async def redeem(
    venue_id: int,
    event_id: int,
    body: TicketRedeemRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "bouncer")

    # Rate limit de puerta (mig 019): cada redeem escribe en redemptions, así
    # que el límite se calcula con lo que ya hay. 40 escaneos / 10 s por
    # usuario (4/s) está muy por encima del ritmo humano de una fila y muy
    # por debajo de una máquina probando tokens. El token de 192 bits ya hace
    # inviable la fuerza bruta: esto solo frena spam y desbordes de log.
    async with db.cursor() as cur:
        await cur.execute(
            """SELECT count(*)::int AS n FROM redemptions
               WHERE scanned_by_user_id = %s
                 AND scanned_at > now() - INTERVAL '10 seconds'""",
            (user["id"],),
        )
        if (await cur.fetchone())["n"] >= 40:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Demasiados escaneos en poco tiempo. Espera unos segundos.",
            )

    # `force` (mig 013): solo staff, nunca el escáner automático del bouncer.
    if body.force:
        ensure_roles(user, venue_id, "super_admin", "admin")

    async with db.cursor() as cur:
        try:
            await cur.execute(
                "SELECT redeem_ticket(%s, %s, %s, %s)",
                (event_id, body.raw_token, user["id"], body.ticket_type_id),
            )
            row = await cur.fetchone()
            code = row["redeem_ticket"] if isinstance(row, dict) else row[0]

            if code == "NOT_ACTIVE" and body.force:
                # El staff decide dejar pasar fuera de ventana: consulta la
                # ventana sin exigirla. La boleta aún NO está consumida: el
                # UPDATE de abajo hace el canje real (mismo CAS de siempre).
                await cur.execute(
                    """
                    SELECT (starts_at - (qr_unlock_minutes * INTERVAL '1 minute')) <= now()
                           OR qr_unlock_minutes = 0
                       AS ok
                    FROM events WHERE id=%s
                    """,
                    (event_id,),
                )
                # Esta rama SOLO corre si redeem_ticket dijo NOT_ACTIVE
                # (ventana CERRADA). La consulta pregunta si la ventana ya
                # abrio: si abrio (ok=True) ya no corresponde forzar - el
                # canje debe volver a pasar por la logica normal. Antes la
                # condicion estaba invertida (pedia ok=True para forzar):
                # era imposible y el "forzar ingreso" de mig 013 nunca
                # funciono (codigo muerto).
                forced = not (await cur.fetchone())["ok"]
                if forced:
                    await cur.execute(
                        """
                        UPDATE tickets
                           SET status='redeemed', redeemed_at=now(),
                               redeemed_by_user_id=%s
                         WHERE id=(SELECT id FROM tickets
                                    WHERE token_hash=encode(digest(%s,'sha256'),'hex'))
                           AND status='issued'
                        """,
                        (user["id"], body.raw_token),
                    )
                    if cur.rowcount == 1:
                        await cur.execute(
                            """
                            INSERT INTO redemptions
                                (ticket_id, event_id, scanned_by_user_id, outcome)
                            SELECT id, %s, %s, 'granted_forced' FROM tickets
                             WHERE token_hash=encode(digest(%s,'sha256'),'hex')
                            """,
                            (event_id, user["id"], body.raw_token),
                        )
                        code = "GRANTED"
            await db.commit()
        except psycopg.errors.Error as e:
            _handle(venue_id, e)

    out = RedeemOut(code=code, redeemed=(code == "GRANTED"))
    if code == "NOT_ACTIVE":
        # Mig 013: boleta válida pero su QR aún no se activa (fuera de la
        # ventana). No se consumió: podrá entrar cuando abra la ventana. Se
        # informa LA HORA exacta (en la zona del evento): en la puerta eso es
        # lo accionable — "vuelve a las 22:00" y no "vuelve más tarde".
        async with db.cursor() as cur2:
            await cur2.execute(
                """
                SELECT starts_at, event_timezone,
                       (starts_at - (qr_unlock_minutes * INTERVAL '1 minute')) AS ready_at
                FROM events WHERE id = %s
                """,
                (event_id,),
            )
            ev = await cur2.fetchone()
        if ev:
            try:
                tz = ZoneInfo(ev["event_timezone"])
            except Exception:
                tz = ZoneInfo("UTC")
            fmt = lambda d: d.astimezone(tz).strftime("%H:%M")
            out.detail = (
                f"QR se activa a las {fmt(ev['ready_at'])} "
                f"(evento {fmt(ev['starts_at'])})"
            )
        else:
            out.detail = "El QR de esta boleta aún no está activo"
    if code == "WRONG_TYPE":
        # Boleta válida del evento pero de otra fila: no se consumió. Se
        # informa el tipo real para que el portero la redireccione.
        async with db.cursor() as cur2:
            await cur2.execute(
                """
                SELECT t.id, t.customer_name, tt.name AS type_name
                FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id
                WHERE t.event_id=%s
                  AND t.token_hash = encode(digest(%s, 'sha256'), 'hex')
                """,
                (event_id, body.raw_token),
            )
            info = await cur2.fetchone()
            if info:
                out.ticket_id = info["id"]
                out.customer_name = info["customer_name"]
                out.detail = f"Boleta de {info['type_name']}"
    if code == "ALREADY_REDEEMED":
        # La discusión clásica de puerta ("¿ya la usé?") se resuelve con el
        # NOMBRE y la HORA del primer canje, no con un "presentada antes" seco.
        # El ticket guarda redeemed_at; la hora se muestra en la zona del
        # evento (misma regla que NOT_ACTIVE: "vuelve a las 22:00", no UTC).
        async with db.cursor() as cur2:
            await cur2.execute(
                """
                SELECT t.id, t.customer_name, t.redeemed_at,
                       e.event_timezone
                FROM tickets t JOIN events e ON e.id = t.event_id
                WHERE t.event_id=%s
                  AND t.token_hash = encode(digest(%s, 'sha256'), 'hex')
                """,
                (event_id, body.raw_token),
            )
            info = await cur2.fetchone()
        if info:
            out.ticket_id = info["id"]
            out.customer_name = info["customer_name"]
            if info["redeemed_at"]:
                try:
                    tz = ZoneInfo(info["event_timezone"])
                except Exception:
                    tz = ZoneInfo("UTC")
                when = info["redeemed_at"].astimezone(tz).strftime("%H:%M")
                out.detail = f"Ya entró a las {when}"
            else:
                out.detail = "Ya presentada anteriormente"
    if code == "GRANTED":
        async with db.cursor() as cur2:
            await cur2.execute(
                """
                SELECT t.id, t.customer_name FROM tickets t
                WHERE t.event_id=%s AND t.status='redeemed'
                  AND t.token_hash = encode(digest(%s, 'sha256'), 'hex')
                """,
                (event_id, body.raw_token),
            )
            info = await cur2.fetchone()
            if info:
                out.ticket_id = info["id"]
                out.customer_name = info["customer_name"]
    return out


@router.post(
    "/events/{event_id}/tickets/{ticket_id}/reissue",
    response_model=TicketReissueResponse,
)
async def reissue_ticket(
    venue_id: int,
    event_id: int,
    ticket_id: int,
    body: TicketReissueRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Recupera una boleta viva rotando su token y devuelve el QR nuevo.

    El token crudo se entrego una sola vez al emitir y en la DB solo hay su
    SHA-256, asi que la boleta era irrecuperable si el invitado perdia el enlace
    (WhatsApp no salio, borro el chat, el promotor cerro la pestaña). No se puede
    resucitar el token viejo sin guardarlo en claro -justo lo que el hash evita-,
    asi que se emite uno nuevo: misma boleta, mismo cupo, mismo aforo.

    El token anterior deja de servir en el acto (el hash se reemplaza), lo que
    ademas corta cualquier copia del QR viejo que haya circulado.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")

    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT t.status, t.sold_by_user_id
              FROM tickets t
              JOIN events e ON e.id = t.event_id
             WHERE t.id = %s AND t.event_id = %s AND e.venue_id = %s
            """,
            (ticket_id, event_id, venue_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Boleta no encontrada")

        # Un promotor solo reemite SUS boletas: si no, podria rotar el QR de un
        # invitado ajeno y quedarse con la entrada (o invalidarsela).
        roles = user["roles"].get(venue_id, [])
        is_staff = any(r in ("super_admin", "admin") for r in roles)
        if not is_staff and row["sold_by_user_id"] != user["id"]:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Solo puedes reemitir tus propias boletas"
            )

        raw_token = secrets.token_urlsafe(24)  # credencial nueva para el QR
        try:
            await cur.execute(
                "SELECT reissue_ticket(%s, %s, %s, %s)",
                (ticket_id, raw_token, user["id"], body.reason),
            )
            await db.commit()
        except psycopg.errors.Error as e:
            _handle(venue_id, e)

        await cur.execute(
            "SELECT customer_name, customer_phone FROM tickets WHERE id = %s",
            (ticket_id,),
        )
        info = await cur.fetchone()

    return TicketReissueResponse(
        ticket_id=ticket_id,
        raw_token=raw_token,
        customer_name=info["customer_name"],
        customer_phone=info["customer_phone"],
        status="issued",
    )


@router.patch(
    "/events/{event_id}/tickets/{ticket_id}/contact",
    response_model=TicketContactEditResponse,
)
async def edit_ticket_contact(
    venue_id: int,
    event_id: int,
    ticket_id: int,
    body: TicketContactEditRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Corrige nombre y/o teléfono del asistente de una boleta vigente.

    El error más común del flujo de emisión: el promotor digitó mal el teléfono
    y el WhatsApp del QR nunca llegó. Antes la única salida era anular +
    reemitir (fricción doble); ahora se corrige al vuelo, con auditoría completa
    en la DB (mig 015: quién, cuándo, valores anteriores).

    Permisos espejo de reissue: el promotor corrige SOLO sus boletas; el staff
    (super_admin/admin) cualquiera del evento. El motivo es opcional y queda en
    la auditoría.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")

    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT t.status, t.sold_by_user_id
              FROM tickets t
              JOIN events e ON e.id = t.event_id
             WHERE t.id = %s AND t.event_id = %s AND e.venue_id = %s
            """,
            (ticket_id, event_id, venue_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Boleta no encontrada")

        # Espejo del reissue: un promotor no puede tocar boletas ajenas (podría
        # redirigir el QR de un invitado de otro promotor).
        roles = user["roles"].get(venue_id, [])
        is_staff = any(r in ("super_admin", "admin") for r in roles)
        if not is_staff and row["sold_by_user_id"] != user["id"]:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Solo puedes corregir tus propias boletas"
            )

        try:
            await cur.execute(
                "SELECT correct_ticket_contact(%s, %s, %s, %s, %s)",
                (ticket_id, body.customer_name, body.customer_phone, user["id"], body.reason),
            )
            await db.commit()
        except psycopg.errors.Error as e:
            _handle(venue_id, e)

        await cur.execute(
            "SELECT id, customer_name, customer_phone, status::text AS status FROM tickets WHERE id = %s",
            (ticket_id,),
        )
        info = await cur.fetchone()

    return TicketContactEditResponse(
        ticket_id=info["id"],
        customer_name=info["customer_name"],
        customer_phone=info["customer_phone"],
        status=info["status"],
    )


@router.get(
    "/events/{event_id}/tickets/{ticket_id}/contact-edits",
    response_model=list[TicketContactEditOut],
)
async def list_ticket_contact_edits(
    venue_id: int,
    event_id: int,
    ticket_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Auditoría de correcciones de contacto de una boleta (mig 015).

    Misma política que el PATCH: el promotor ve el historial de SUS boletas y
    el staff el de cualquiera del evento. Sirve para responder "quién cambió
    el teléfono y cuándo" sin abrir la DB.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")

    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT t.sold_by_user_id
              FROM tickets t
              JOIN events e ON e.id = t.event_id
             WHERE t.id = %s AND t.event_id = %s AND e.venue_id = %s
            """,
            (ticket_id, event_id, venue_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Boleta no encontrada")

        roles = user["roles"].get(venue_id, [])
        is_staff = any(r in ("super_admin", "admin") for r in roles)
        if not is_staff and row["sold_by_user_id"] != user["id"]:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Solo puedes ver el historial de tus propias boletas"
            )

        await cur.execute(
            """
            SELECT ce.id, ce.old_name, ce.new_name, ce.old_phone, ce.new_phone,
                   ce.reason, ce.created_at, u.full_name AS edited_by_name
              FROM ticket_contact_edits ce
              LEFT JOIN users u ON u.id = ce.edited_by_user_id
             WHERE ce.ticket_id = %s
             ORDER BY ce.created_at DESC, ce.id DESC
            """,
            (ticket_id,),
        )
        rows = await cur.fetchall()

    return rows


@router.post(
    "/events/{event_id}/tickets/{ticket_id}/return",
    response_model=TicketReturnOut,
)
async def return_ticket_staff(
    venue_id: int,
    event_id: int,
    ticket_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Devolucion de una boleta por parte del staff (mig 021).

    Caso real: el invitado escribe "no puedo ir" por WhatsApp en vez de usar
    el boton de su enlace. El promotor (dueno de la boleta) o el admin lo
    registra aqui para liberar el cupo YA, con la misma auditoria y la misma
    ventana limite que la devolucion del invitado.

    Es la contraparte autenticada de POST /tickets/return (publico): misma
    funcion SQL, sin hash esperado — la credencial aqui es el rol.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")

    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT t.status, t.sold_by_user_id
              FROM tickets t
              JOIN events e ON e.id = t.event_id
             WHERE t.id = %s AND t.event_id = %s AND e.venue_id = %s
            """,
            (ticket_id, event_id, venue_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Boleta no encontrada")

        # Espejo de reissue/contact: un promotor solo devuelve SUS boletas.
        roles = user["roles"].get(venue_id, [])
        is_staff = any(r in ("super_admin", "admin") for r in roles)
        if not is_staff and row["sold_by_user_id"] != user["id"]:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Solo puedes devolver tus propias boletas"
            )

        try:
            await cur.execute(
                "SELECT return_ticket(%s, NULL, %s)",
                (ticket_id, user["id"]),
            )
            await db.commit()
        except psycopg.errors.Error as e:
            _handle(venue_id, e)

    return TicketReturnOut(ticket_id=ticket_id, status="returned")


# ---------------------------------------------------------------------------
# Snapshot de puerta: hashes de las boletas vivas del evento
# ---------------------------------------------------------------------------


@router.get("/events/{event_id}/door-snapshot", response_model=DoorSnapshotOut)
async def door_snapshot(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Lista de validación para la puerta SIN red.

    Solo boletas vivas (`issued`; las `redeemed` no: contra el snapshot no se
    puede distinguir "ya entró" de "entró en otro teléfono" y esa decisión
    la toma el sync). Solo staff de puerta. Es un export de datos personales
    (nombre por boleta): mismo tratamiento de auditoría que invitados.csv.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "bouncer")

    # La puerta también cierra lo vencido (app/core/lifecycle.py): es la
    # pantalla que el bouncer abre antes de la fiesta, sin pasar por el panel.
    await auto_close_expired(db, context="door_snapshot")

    async with db.cursor() as cur:
        await cur.execute(
            """SELECT id, name, status FROM events
               WHERE id=%s AND venue_id=%s""",
            (event_id, venue_id),
        )
        ev = await cur.fetchone()
        if not ev:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Evento no encontrado")

        await cur.execute(
            """
            SELECT t.token_hash AS h, t.status::text AS s,
                   t.ticket_type_id AS t, t.customer_name AS n
            FROM tickets t
            WHERE t.event_id = %s AND t.status = 'issued'
            ORDER BY t.id
            """,
            (event_id,),
        )
        rows = await cur.fetchall()

    entries = [
        DoorSnapshotEntry(h=r["h"], s=r["s"], t=r["t"], n=r["n"]) for r in rows
    ]
    return DoorSnapshotOut(
        event_id=event_id,
        generated_at=datetime.now(timezone.utc),
        count=len(entries),
        live_event=(ev["status"] == "live"),
        entries=entries,
    )


# ---------------------------------------------------------------------------
# Sync de la cola offline: la DB re-evalúa cada token
# ---------------------------------------------------------------------------


@router.post("/events/{event_id}/door-sync", response_model=DoorSyncOut)
async def door_sync(
    venue_id: int,
    event_id: int,
    body: list[DoorSyncItem],
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Reconcilia las redenciones que el bouncer hizo sin red.

    Cada token pasa por `redeem_ticket` COMO SI FUERA AHORA: si la boleta fue
    anulada o ya canjeada mientras el teléfono estaba offline, la DB lo dice
    y el resultado refleja la verdad final (granted / already_redeemed /
    rejected).

    Idempotencia (mig 034): cada item trae un `scan_id` que el teléfono generó
    al escanear. Si el sync se reintenta (corte de red, la app se cierra a
    medias), el scan_id ya visto devuelve su resultado SIN volver a canjear:
    el reintento deja de falsear el conteo de la puerta. `scanned_at` es la
    hora real del escaneo, saneada en SQL.

    La respuesta trae `results` en el MISMO orden que la entrada: el cliente
    borra de IndexedDB solo lo que el server confirmó.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "bouncer")
    # La misma válvula anti-spam del redeem en línea: una cola offline nunca
    # debería traer más de lo que una fila humana generó, pero el límite
    # protege el log de redemptions de un cliente desbocado.
    if len(body) > 200:
        # 413 literal: ver media.py — el nombre nuevo de Starlette no existe
        # en todas las versiones soportadas y el viejo está deprecado.
        raise HTTPException(
            413,
            "Demasiados escaneos en una sola sincronización (máx 200)",
        )

    granted = already = rejected = 0
    results: list[DoorSyncResult] = []
    async with db.cursor() as cur:
        for item in body:
            # 1) ¿Ya procesamos este scan_id? Devolver el recibo, sin canjear.
            if item.scan_id:
                try:
                    await cur.execute(
                        "SELECT outcome FROM door_sync_receipts "
                        "WHERE event_id = %s AND scan_id = %s",
                        (event_id, item.scan_id),
                    )
                    prev = await cur.fetchone()
                except psycopg.errors.Error:
                    # Un scan_id malformado (no uuid) no debe tumbar la cola:
                    # se sigue como si no hubiera recibo.
                    await db.rollback()
                    prev = None
                if prev:
                    code = prev["outcome"] if isinstance(prev, dict) else prev[0]
                    results.append(DoorSyncResult(scan_id=item.scan_id, code=code))
                    if code == "GRANTED":
                        granted += 1
                    elif code == "ALREADY_REDEEMED":
                        already += 1
                    else:
                        rejected += 1
                    continue

            # 2) Canje real. La hora del escaneo viaja al SQL (saneada ahí).
            try:
                await cur.execute(
                    "SELECT redeem_ticket(%s, %s, %s, %s, %s)",
                    (
                        event_id,
                        item.raw_token,
                        user["id"],
                        item.ticket_type_id,
                        item.scanned_at,
                    ),
                )
                row = await cur.fetchone()
                code = row["redeem_ticket"] if isinstance(row, dict) else row[0]
            except psycopg.errors.Error:
                # Un token problemático no tira la cola entera: se cuenta como
                # rechazado y se sigue con el resto.
                await db.rollback()
                code = "INVALID"
                results.append(DoorSyncResult(scan_id=item.scan_id, code=code))
                rejected += 1
                continue

            # 3) Dejar el recibo para que un reintento sea no-op.
            if item.scan_id:
                try:
                    await cur.execute(
                        "INSERT INTO door_sync_receipts (event_id, scan_id, outcome) "
                        "VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                        (event_id, item.scan_id, code),
                    )
                except psycopg.errors.Error:
                    # El recibo es una optimización: si falla (scan_id no uuid),
                    # el canje ya ocurrió y la respuesta sigue siendo válida.
                    await db.rollback()

            results.append(DoorSyncResult(scan_id=item.scan_id, code=code))
            if code == "GRANTED":
                granted += 1
            elif code == "ALREADY_REDEEMED":
                already += 1
            else:
                rejected += 1

    await db.commit()
    return DoorSyncOut(
        processed=len(body),
        granted=granted,
        already_redeemed=already,
        rejected=rejected,
        results=results,
    )