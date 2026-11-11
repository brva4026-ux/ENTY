"""Ciclo de vida del evento (publish/live/end/cancel), anulacion de boletas
y listado de usuarios de la venue (para asignar cupos con nombres reales)."""
from typing import Annotated

import csv
import io

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status

from app.core.config import get_settings
from app.core.db import get_db
from app.core.db_errors import translate_db_error
from app.core.observability import capture_exception
from app.core.pusher import notify_venue
from app.core.phone import digits_only, phone_tail_sql
from app.deps import ensure_roles, get_current_user
from app.core.audit import write_audit
# fetch_event vive en events.py para que listar, crear y transicionar devuelvan
# el mismo shape de evento (ver EVENT_COLUMNS).
from app.routers.events import fetch_event
from app.schemas import (
    CreateVenueUser,
    DeleteEventRequest,
    EventOut,
    EventPreflight,
    MessageOut,
    PurgeUserRequest,
    ResetPassword,
    TicketListOut,
    TicketOut,
    UpdateVenueUser,
    VenueUserOut,
    VoidRequest,
)

router = APIRouter(prefix="/venues/{venue_id}", tags=["ciclo de vida"])

VALID_TRANSITIONS = {
    "publish": ("draft", "published"),
    "live": ("published", "live"),
    "end": ("live", "ended"),
    # Reapertura (mig 034): 'ended' dejó de ser terminal. El auto-cierre con
    # gracia (6 h) evita el caso normal, pero un ends_at mal cargado o un
    # "Terminar" pulsado sin querer dejaban el evento muerto para siempre, sin
    # puerta y sin venta. Reabrir es explícito, de admin, y queda auditado.
    "reopen": ("ended", "live"),
    # Se puede cancelar desde borrador O publicado (migración 005: el trigger de
    # DB valida la matriz completa, así que 'live/ended/cancelled -> cancelled'
    # queda bloqueado a nivel DB aunque el endpoint lo intentara).
    "cancel": (None, "cancelled"),
}


def _error_to_http(e: psycopg.errors.Error) -> HTTPException:
    """Errores de transición → HTTPException (mapa único; 500 si es desconocido).

    Las transiciones envuelven el error en lugar de re-lanzarlo, así que un
    código no mapeado cae al 500 genérico en vez de propagar el SQL.
    """
    return translate_db_error(
        e,
        overrides={
            "event_closed": (409, "La boleta no puede anularse en este estado"),
            "cannot_void_ticket": (409, "La boleta no puede anularse en este estado"),
        },
    ) or HTTPException(500, "Error interno")


async def _transition(venue_id, event_id, user, db, action):
    """Ejecuta set_event_status(...) dentro de la transición válida."""
    ensure_roles(user, venue_id, "super_admin", "admin")
    if venue_id not in user["venue_ids"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No perteneces a esta venue")
    p_from, p_to = VALID_TRANSITIONS[action]

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")

        # Cancelar vale desde draft y published (trigger de DB valida el resto).
        if action == "cancel":
            await cur.execute("SELECT status FROM events WHERE id=%s", (event_id,))
            status_now = (await cur.fetchone())["status"]
            if status_now not in ("draft", "published"):
                raise HTTPException(
                    409,
                    "Solo se puede cancelar un evento en borrador o publicado "
                    "(en puerta, terminado o ya cancelado no)",
                )
            p_from = status_now

        try:
            await cur.execute("SELECT set_event_status(%s, %s, %s)", (event_id, p_from, p_to))
        except psycopg.errors.Error as e:
            raise _error_to_http(e)

        # La reapertura es la única transición que "resucita" un evento y
        # devuelve la puerta: merece rastro (mig 034).
        if action == "reopen":
            await write_audit(
                cur, venue_id, user["id"], "event_reopen", "event", event_id,
                {"from": p_from, "to": p_to},
            )

        out = await fetch_event(cur, event_id, venue_id)
        await db.commit()
    return out


@router.post("/events/{event_id}/publish", response_model=EventOut)
async def publish_event(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    return await _transition(venue_id, event_id, user, db, "publish")


@router.post("/events/{event_id}/live", response_model=EventOut)
async def go_live(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Abre puertas (published -> live) y avisa por Web Push a los
    dispositivos de la puerta suscritos a esta venue.

    El push es best-effort: fallar el envío NUNCA impide abrir puertas. Sus
    suscripciones muertas (404/410 del push service) se limpian."""
    out = await _transition(venue_id, event_id, user, db, "live")

    settings = get_settings()
    if settings.vapid_private_key_b64:
        try:
            async with db.cursor() as cur:
                # El aviso va AL EQUIPO DE LA NOCHE (mig 025), no a la venue
                # entera: el promotor de la noche del 14 no necesita enterarse
                # de que abrió la del 21. Si la noche no tiene roster, cae al
                # comportamiento anterior (todos los dispositivos de la venue):
                # avisar de más sigue siendo mejor que no avisar.
                await cur.execute(
                    """
                    SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
                    FROM push_subscriptions ps
                    WHERE ps.venue_id = %s
                      AND (
                        EXISTS (
                            SELECT 1 FROM event_staff s
                            WHERE s.event_id = %s AND s.user_id = ps.user_id
                        )
                        OR NOT EXISTS (
                            SELECT 1 FROM event_staff s2 WHERE s2.event_id = %s
                        )
                      )
                    """,
                    (venue_id, event_id, event_id),
                )
                rows = await cur.fetchall()

            dead, sent = await notify_venue(
                rows,
                {
                    "title": "🚪 Puertas abiertas",
                    "body": (
                        f"{out['name']} está en puerta. Activa el escáner para "
                        "empezar a validar boletas."
                    ),
                    "tag": f"event-live-{event_id}",
                    "url": "/bouncer",
                },
                vapid_private_b64=settings.vapid_private_key_b64,
                vapid_subject=settings.vapid_subject,
            )

            if dead:
                # Cursor nuevo: el bloque `async with` de la consulta anterior
                # ya cerró `cur`.
                async with db.cursor() as cur_del:
                    await cur_del.execute(
                        "DELETE FROM push_subscriptions WHERE id = ANY(%s)",
                        (dead,),
                    )
                await db.commit()
        except Exception as e:
            # Un fallo de push (red, claves, DB) no debe revertir la apertura,
            # pero tampoco puede quedar invisible: sin esto, las puertas
            # abrian sin avisar al staff y nadie se enteraba.
            capture_exception(e, context={"component": "lifecycle", "event": event_id})

    return out


@router.post("/events/{event_id}/end", response_model=EventOut)
async def end_event(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    return await _transition(venue_id, event_id, user, db, "end")


@router.post("/events/{event_id}/reopen", response_model=EventOut)
async def reopen_event(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Devuelve un evento terminado a la puerta (ended -> live, mig 034).

    El auto-cierre tiene 6 h de gracia, pero la noche puede estirarse más (o
    el cierre fue un error): sin esta salida, 'ended' era terminal y no había
    forma de volver a escanear ni de vender. Requiere admin y queda auditado.
    """
    return await _transition(venue_id, event_id, user, db, "reopen")


@router.post("/events/{event_id}/cancel", response_model=EventOut)
async def cancel_event(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    return await _transition(venue_id, event_id, user, db, "cancel")


# ---------------------------------------------------------------------------
# Pre-vuelo de apertura y cierre de noche (tanda 3)
# ---------------------------------------------------------------------------
@router.get("/events/{event_id}/preflight", response_model=EventPreflight)
async def event_preflight(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Qué falta ANTES de abrir puertas (published -> live).

    La apertura con la puerta vacía era un fracaso silencioso: el evento pasaba
    a live, los escaneos empezaban a rechazar con 403 y nadie entendía por qué.
    Este endpoint alimenta el aviso del admin ANTES del confirm: abrir sin
    puerta asignada sigue siendo posible (el negocio decide), pero ya no es
    un accidente.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, name, status, capacity, starts_at FROM events WHERE id=%s AND venue_id=%s",
            (event_id, venue_id),
        )
        ev = await cur.fetchone()
        if not ev:
            raise HTTPException(404, "Evento no encontrado")

        await cur.execute(
            """
            SELECT s.user_id, s.role, s.shift_start, s.shift_end,
                   u.full_name,
                   EXISTS (
                       SELECT 1 FROM event_access_tokens t
                       WHERE t.event_id = s.event_id AND t.user_id = s.user_id
                         AND t.used_at IS NOT NULL AND t.revoked_at IS NULL
                   ) AS link_used
            FROM event_staff s
            JOIN users u ON u.id = s.user_id
            WHERE s.event_id = %s
            ORDER BY s.role, u.full_name
            """,
            (event_id,),
        )
        roster = await cur.fetchall()

        await cur.execute(
            """
            SELECT count(*) FILTER (WHERE status IN ('issued','redeemed'))::int AS issued,
                   count(*) FILTER (WHERE status='redeemed')::int AS redeemed
            FROM tickets WHERE event_id = %s
            """,
            (event_id,),
        )
        tk = await cur.fetchone()

    puerta = [r for r in roster if r["role"] == "bouncer"]
    venta = [r for r in roster if r["role"] == "promotor"]
    # Con link usado = la persona ya canjeó su acceso y tiene el escáner listo.
    ready = any(r["link_used"] for r in puerta)
    return EventPreflight(
        event_id=event_id,
        event_name=ev["name"],
        status=ev["status"],
        capacity=ev["capacity"],
        starts_at=ev["starts_at"],
        bouncers=len(puerta),
        promoters=len(venta),
        door_ready=ready,
        door_staff=[
            {
                "user_id": r["user_id"],
                "full_name": r["full_name"],
                "shift_start": r["shift_start"],
                "shift_end": r["shift_end"],
                "link_used": r["link_used"],
            }
            for r in puerta
        ],
        tickets_issued=tk["issued"],
        tickets_redeemed=tk["redeemed"],
    )


@router.get("/events/{event_id}/closing.csv")
async def export_closing_csv(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Cierre de ESTA noche: caja + puerta + equipo en un CSV para el contador.

    Existe porque /summary vive en la pantalla y se pierde con el refresh; la
    noche real se cierra con un papel (o un Excel compartido por WhatsApp).
    Mismos criterios contables del reporte: boletas vivas facturan, la
    integridad de la puerta viene del log de redemptions.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT name FROM events WHERE id=%s AND venue_id=%s",
            (event_id, venue_id),
        )
        ev = await cur.fetchone()
        if not ev:
            raise HTTPException(404, "Evento no encontrado")

        await cur.execute(
            """
            SELECT coalesce(sum(price_cents_snapshot)
                            FILTER (WHERE status IN ('issued','redeemed')), 0)::bigint AS revenue_cents,
                   count(*) FILTER (WHERE status IN ('issued','redeemed')
                                      AND price_cents_snapshot > 0)::int AS paid,
                   count(*) FILTER (WHERE status IN ('issued','redeemed')
                                      AND price_cents_snapshot = 0)::int AS courtesy,
                   count(*) FILTER (WHERE status='voided')::int AS voided
            FROM tickets WHERE event_id=%s
            """,
            (event_id,),
        )
        money = await cur.fetchone()

        # Caja por medio de pago (mig 042): lo que convierte el "Recaudo" en un
        # arqueo. El efectivo es el unico numero que se puede contar contra el
        # cajon al cerrar; las transferencias y cobros en linea se concilian
        # aparte. Las boletas historicas sin dato salen como "sin especificar".
        await cur.execute(
            """
            SELECT t.payment_method,
                   count(*)::int AS n,
                   coalesce(sum(t.price_cents_snapshot), 0)::bigint AS amount
            FROM tickets t
            WHERE t.event_id=%s AND t.status IN ('issued','redeemed')
              AND t.price_cents_snapshot > 0
            GROUP BY t.payment_method ORDER BY amount DESC
            """,
            (event_id,),
        )
        pay_rows = await cur.fetchall()

        await cur.execute(
            """
            SELECT coalesce(u.full_name, 'Sin identificar') AS who,
                   count(*) FILTER (WHERE r.outcome IN ('granted','granted_forced'))::int AS granted,
                   count(*) FILTER (WHERE r.outcome NOT IN ('granted','granted_forced'))::int AS failed,
                   count(*)::int AS total,
                   max(r.scanned_at) AS last_scan
            FROM redemptions r
            LEFT JOIN users u ON u.id = r.scanned_by_user_id
            WHERE r.event_id=%s
            GROUP BY u.full_name ORDER BY total DESC
            """,
            (event_id,),
        )
        door_rows = await cur.fetchall()

        await cur.execute(
            """
            SELECT u.full_name, s.role,
                   s.shift_start, s.shift_end
            FROM event_staff s JOIN users u ON u.id = s.user_id
            WHERE s.event_id=%s ORDER BY s.role, u.full_name
            """,
            (event_id,),
        )
        roster = await cur.fetchall()

        await write_audit(
            cur, venue_id, user["id"], "export", "closing_csv", event_id,
            {"evento": ev["name"]},
        )
        await db.commit()

    paid = money["paid"]
    revenue = money["revenue_cents"]
    rows_door = [
        [r["who"], r["granted"], r["failed"], r["total"],
         r["last_scan"].strftime("%H:%M") if r["last_scan"] else ""]
        for r in door_rows
    ] or [["(nadie escaneó)", 0, 0, 0, ""]]
    rows_staff = [
        [r["full_name"], "Puerta" if r["role"] == "bouncer" else "Venta",
         r["shift_start"].strftime("%H:%M") if r["shift_start"] else "",
         r["shift_end"].strftime("%H:%M") if r["shift_end"] else ""]
        for r in roster
    ] or [["(sin equipo asignado)", "", "", ""]]

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([f"Cierre de noche - {ev['name']}"])
    w.writerow([])
    w.writerow(["Caja", ""])
    w.writerow(["Recaudo (COP)", round(revenue / 100, 2)])
    w.writerow(["Boletas pagas", paid])
    w.writerow(["Cortesias", money["courtesy"]])
    w.writerow(["Anuladas", money["voided"]])
    w.writerow(["Promedio por boleta paga (COP)", round(revenue / paid / 100, 2) if paid else 0])
    w.writerow([])
    w.writerow(["Caja por medio de pago", "Boletas", "Monto (COP)"])
    method_label = {
        "efectivo": "Efectivo",
        "transferencia": "Transferencia",
        "online": "Pago en linea",
        "cortesia": "Cortesia",
    }
    rows_pay = [
        [method_label.get(r["payment_method"], "Sin especificar"),
         r["n"], round((r["amount"] or 0) / 100, 2)]
        for r in pay_rows
    ] or [["(sin ventas de pago)", 0, 0]]
    w.writerows(rows_pay)
    w.writerow([])
    w.writerow(["Puerta", "Entras", "Rechazadas", "Total escaneos", "Ultimo escaneo"])
    w.writerows(rows_door)
    w.writerow([])
    w.writerow(["Equipo de la noche", "Rol", "Turno desde", "Turno hasta"])
    w.writerows(rows_staff)

    content = "\ufeff" + buf.getvalue()
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="cierre-evento-{event_id}.csv"',
            "Cache-Control": "no-store",
        },
    )


@router.delete("/events/{event_id}", response_model=MessageOut)
async def delete_event(
    venue_id: int, event_id: int,
    body: DeleteEventRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Elimina definitivamente un evento, en cualquier estado salvo `live`.

    El dueno del negocio limpia su catalogo sin vaciar boletas a mano: la
    salvaguarda es la confirmacion por nombre exacto y el veto al evento con
    las puertas abiertas (se esta operando ahora mismo). `tickets`, tipos,
    cupos, redenciones, devoluciones y waitlist caen por ON DELETE CASCADE;
    `ticket_payments` no tiene cascada, asi que se borra explicitamente."""
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT name, status FROM events WHERE id=%s AND venue_id=%s",
            (event_id, venue_id),
        )
        ev = await cur.fetchone()
        if not ev:
            raise HTTPException(404, "Evento no encontrado")
        if ev["name"] != body.confirm.strip():
            raise HTTPException(
                400, "Escribe el nombre exacto del evento para confirmar el borrado."
            )
        if ev["status"] == "live":
            raise HTTPException(
                409,
                "El evento tiene las puertas abiertas: finalizalo antes de "
                "borrarlo.",
            )

        # ticket_payments conserva el cobro historico y NO tiene ON DELETE
        # CASCADE: sin esta limpieza el FK aborta el borrado de un evento con
        # pagos. El resto de las tablas hijas cae sola.
        await cur.execute(
            "DELETE FROM ticket_payments WHERE event_id=%s", (event_id,)
        )
        await cur.execute("DELETE FROM events WHERE id=%s", (event_id,))
        await db.commit()
    return MessageOut(detail=f"Evento '{ev['name']}' eliminado.")


# ---------------------------------------------------------------------------
# Gestión de un miembro del equipo: editar, desactivar, borrar, reset password
# ---------------------------------------------------------------------------
async def _target_membership(cur, venue_id: int, target_user_id: int) -> list[str]:
    """Devuelve los roles del usuario en la venue o 404 si no pertenece."""
    await cur.execute(
        "SELECT role FROM venue_user_roles WHERE venue_id=%s AND user_id=%s",
        (venue_id, target_user_id),
    )
    roles = [r["role"] for r in await cur.fetchall()]
    if not roles:
        raise HTTPException(404, "Ese usuario no pertenece a esta venue")
    return roles


@router.patch("/users/{user_id}", response_model=VenueUserOut)
async def update_venue_user(
    venue_id: int, user_id: int,
    body: UpdateVenueUser,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Edición parcial: nombre, rol y desactivación.

    - Desactivar (is_active=false): el usuario deja de poder iniciar sesión
      de inmediato (get_current_user lo rechaza) — es el modo "se fue de la
      empresa", conserva historial.
    - Cambiar rol: quita el rol anterior y asigna el nuevo (transaccional).
    - El admin no puede desactivarse a sí mismo ni modificar a un super_admin.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        roles = await _target_membership(cur, venue_id, user_id)
        if "super_admin" in roles:
            raise HTTPException(400, "No puedes modificar a un super_admin desde aquí")
        if user_id == user["id"] and body.is_active is False:
            raise HTTPException(400, "No puedes desactivar tu propia cuenta")

        if body.is_active is not None:
            await cur.execute("UPDATE users SET is_active=%s WHERE id=%s", (body.is_active, user_id))

        if body.full_name is not None:
            await cur.execute("UPDATE users SET full_name=%s WHERE id=%s", (body.full_name, user_id))

        if body.role is not None:
            for r in roles:
                if r != body.role:
                    await cur.execute(
                        "DELETE FROM venue_user_roles WHERE venue_id=%s AND user_id=%s AND role=%s",
                        (venue_id, user_id, r),
                    )
            await cur.execute(
                """INSERT INTO venue_user_roles (venue_id, user_id, role)
                   VALUES (%s, %s, %s) ON CONFLICT DO NOTHING""",
                (venue_id, user_id, body.role),
            )

        await cur.execute(
            """
            SELECT u.id, u.email, u.full_name, u.is_active,
                   COALESCE(array_agg(DISTINCT r.role) FILTER (WHERE r.role IS NOT NULL), '{}')::text[] AS roles
            FROM users u
            LEFT JOIN venue_user_roles r ON r.user_id = u.id AND r.venue_id = %s
            WHERE u.id = %s
            GROUP BY u.id, u.email, u.full_name, u.is_active
            """,
            (venue_id, user_id),
        )
        out = await cur.fetchone()
        await db.commit()
    if not out:
        raise HTTPException(404, "Usuario no encontrado")
    return out


@router.delete("/users/{user_id}", response_model=MessageOut)
async def remove_venue_user(
    venue_id: int, user_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Quita al usuario de la venue (revoca acceso).

    Mantiene el usuario y su historial de boletas (ON DELETE SET NULL / RESTRICT
    lo requieren): esto es una desvinculación, no un borrado físico. Si el
    usuario no tiene roles en ninguna otra venue, también queda desactivado
    para que no pueda iniciar sesión en ningún lado.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        roles = await _target_membership(cur, venue_id, user_id)
        if "super_admin" in roles:
            raise HTTPException(400, "No puedes revocar a un super_admin")
        if user_id == user["id"]:
            raise HTTPException(400, "No puedes quitarte a ti mismo de la venue")

        await cur.execute(
            "DELETE FROM venue_user_roles WHERE venue_id=%s AND user_id=%s",
            (venue_id, user_id),
        )
        # Si quedó sin ninguna venue, desactivar (no puede loguearse a nada).
        await cur.execute(
            "SELECT count(*)::int AS n FROM venue_user_roles WHERE user_id=%s",
            (user_id,),
        )
        remaining = (await cur.fetchone())["n"]
        if remaining == 0:
            await cur.execute("UPDATE users SET is_active=false WHERE id=%s", (user_id,))
        await db.commit()
    return MessageOut(detail="Usuario removido de la venue.")


@router.post("/users/{user_id}/reset-password", response_model=MessageOut)
async def reset_venue_user_password(
    venue_id: int, user_id: int,
    body: ResetPassword,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Reset de contraseña por el admin (flujo operativo, no self-service)."""
    ensure_roles(user, venue_id, "super_admin", "admin")
    from app.core.security import hash_password

    async with db.cursor() as cur:
        await _target_membership(cur, venue_id, user_id)
        # Bump de token_version (mig 019): las sesiones del usuario reseteado
        # mueren aquí — el admin que resetea no deja sesiones ajenas vivas.
        await cur.execute(
            "UPDATE users SET password_hash=%s, token_version = token_version + 1 WHERE id=%s",
            (hash_password(body.new_password), user_id),
        )
        await db.commit()
    return MessageOut(detail="Contraseña actualizada.")


@router.delete("/users/{user_id}/purge", response_model=MessageOut)
async def purge_venue_user(
    venue_id: int, user_id: int,
    body: PurgeUserRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Elimina al usuario de la plataforma de forma definitiva.

    Diferencia con DELETE /users/{id} (remover de la venue): esto borra la
    fila en users. Sus boletas emitidas conservan su nombre (LEFT JOIN).
    `confirm` debe ser el email exacto del usuario. Protege al último admin
    con miembros a cargo y nunca aplica a un super_admin."""
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        roles = await _target_membership(cur, venue_id, user_id)
        if "super_admin" in roles:
            raise HTTPException(400, "No puedes eliminar a un super_admin")
        if user_id == user["id"]:
            raise HTTPException(400, "Usa tu perfil para borrar tu propia cuenta")

        await cur.execute("SELECT email FROM users WHERE id=%s", (user_id,))
        target = await cur.fetchone()
        if not target or target["email"].lower() != body.confirm.strip().lower():
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "La confirmación no coincide con el email del usuario.",
            )

        await cur.execute(
            """SELECT count(*)::int AS n FROM venue_user_roles
               WHERE venue_id=%s AND role='admin' AND user_id<>%s""",
            (venue_id, user_id),
        )
        other_admins = (await cur.fetchone())["n"]
        await cur.execute(
            """SELECT count(*)::int AS n FROM venue_user_roles
               WHERE venue_id=%s AND user_id<>%s""",
            (venue_id, user_id),
        )
        others = (await cur.fetchone())["n"]
        if other_admins == 0 and others > 0:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Es el último administrador con miembros en el equipo: asigna "
                "otro admin antes de eliminarlo.",
            )

        await cur.execute("DELETE FROM users WHERE id=%s", (user_id,))
        await db.commit()
    return MessageOut(detail="Usuario eliminado definitivamente.")


# ---------------------------------------------------------------------------
# Export CSV: invitados del evento y resumen de recaudo
# ---------------------------------------------------------------------------
def _csv_response(filename: str, header: list[str], rows: list[list]) -> Response:
    """Arma la respuesta CSV con BOM UTF-8 (Excel/Sheets la abren bien)."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    content = "\ufeff" + buf.getvalue()
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/events/{event_id}/guests.csv")
async def export_guests_csv(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Lista de invitados (todas las boletas del evento).

    Doble propósito: respaldo de puerta (se puede chequear a mano si falla el
    escáner) y control del organizador.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT name FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
        )
        ev = await cur.fetchone()
        if not ev:
            raise HTTPException(404, "Evento no encontrado")
        await cur.execute(
            """
            SELECT t.id, t.customer_name, t.customer_phone, t.customer_email,
                   t.status, t.issued_at, t.redeemed_at,
                   tt.name AS type_name, tt.is_courtesy,
                   u.full_name AS sold_by
            FROM tickets t
            JOIN ticket_types tt ON tt.id = t.ticket_type_id
            LEFT JOIN users u ON u.id = t.sold_by_user_id
            WHERE t.event_id = %s
            ORDER BY t.id
            """,
            (event_id,),
        )
        rows = await cur.fetchall()

    data = [
        [
            r["id"],
            r["customer_name"],
            r["customer_phone"] or "",
            r["customer_email"] or "",
            r["type_name"] + (" (cortesía)" if r["is_courtesy"] else ""),
            r["status"],
            ("SI" if r["redeemed_at"] else "NO"),
            r["sold_by"] or "",
            r["issued_at"].strftime("%Y-%m-%d %H:%M"),
        ]
        for r in rows
    ]
    return _csv_response(
        f"invitados-evento-{event_id}.csv",
        ["Boleta", "Nombre", "Telefono", "Email", "Tipo", "Estado", "Ingresó", "Emitida por", "Fecha emision"],
        data,
    )


@router.get("/events/{event_id}/revenue.csv")
async def export_revenue_csv(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Resumen de recaudo del evento: por tipo de boleta y total."""
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT tt.name, tt.is_courtesy,
                   count(t.id) FILTER (WHERE t.status NOT IN ('voided','refunded'))::int AS emitidas,
                   count(t.id) FILTER (WHERE t.status='voided')::int AS anuladas,
                   count(t.id) FILTER (WHERE t.status='redeemed')::int AS canjeadas,
                   COALESCE(SUM(t.price_cents_snapshot) FILTER (
                       WHERE t.status NOT IN ('voided','refunded')
                         AND NOT tt.is_courtesy), 0)::bigint AS recaudo
            FROM ticket_types tt
            LEFT JOIN tickets t ON t.ticket_type_id = tt.id AND t.event_id = %s
            WHERE tt.event_id = %s
            GROUP BY tt.name, tt.is_courtesy ORDER BY tt.name
            """,
            (event_id, event_id),
        )
        by_type = await cur.fetchall()
        total = sum(r["recaudo"] for r in by_type)

    data = [[r["name"] + (" (cortesía)" if r["is_courtesy"] else ""), r["emitidas"], r["anuladas"], r["canjeadas"], r["recaudo"]] for r in by_type]
    data.append(["TOTAL", sum(r["emitidas"] for r in by_type), sum(r["anuladas"] for r in by_type), sum(r["canjeadas"] for r in by_type), total])
    return _csv_response(
        f"recaudo-evento-{event_id}.csv",
        ["Tipo de boleta", "Emitidas", "Anuladas", "Canjeadas", "Recaudo (cents)"],
        data,
    )


@router.get("/events/{event_id}/noshow.csv")
async def export_noshow_csv(
    venue_id: int, event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """No-shows del evento: boletas ACTIVAS que nunca ingresaron.

    Es la lista de re-marketing: personas que confirmaron asistencia
    (cortesía o venta) pero no llegaron. Excluye anuladas, reembolsadas y
    canjeadas; solo incluye quienes tienen teléfono o email para contactar.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT name FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
        )
        ev = await cur.fetchone()
        if not ev:
            raise HTTPException(404, "Evento no encontrado")
        await cur.execute(
            """
            SELECT t.id, t.customer_name, t.customer_phone, t.customer_email,
                   tt.name AS type_name, tt.is_courtesy,
                   u.full_name AS sold_by, t.issued_at
            FROM tickets t
            JOIN ticket_types tt ON tt.id = t.ticket_type_id
            LEFT JOIN users u ON u.id = t.sold_by_user_id
            WHERE t.event_id = %s
              AND t.status = 'issued'
              AND (t.customer_phone IS NOT NULL OR t.customer_email IS NOT NULL)
            ORDER BY t.id
            """,
            (event_id,),
        )
        rows = await cur.fetchall()

    data = [
        [
            r["customer_name"],
            r["customer_phone"] or "",
            r["customer_email"] or "",
            r["type_name"] + (" (cortesía)" if r["is_courtesy"] else ""),
            r["sold_by"] or "",
            r["issued_at"].strftime("%Y-%m-%d %H:%M"),
        ]
        for r in rows
    ]
    return _csv_response(
        f"noshow-evento-{event_id}.csv",
        ["Nombre", "Telefono", "Email", "Tipo", "Emitida por", "Fecha emision"],
        data,
    )
@router.post("/events/{event_id}/tickets/{ticket_id}/void", response_model=MessageOut)
async def void_ticket(
    venue_id: int, event_id: int, ticket_id: int,
    body: VoidRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        # La boleta debe pertenecer a la venue (via evento).
        await cur.execute(
            """
            SELECT t.id FROM tickets t
            JOIN events e ON e.id = t.event_id
            WHERE t.id=%s AND t.event_id=%s AND e.venue_id=%s
            """,
            (ticket_id, event_id, venue_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Boleta no encontrada en este evento")
        try:
            await cur.execute(
                "SELECT void_ticket(%s, %s, %s)", (ticket_id, body.reason, user["id"])
            )
        except psycopg.errors.Error as e:
            raise _error_to_http(e)
        await db.commit()
    return MessageOut(detail="Boleta anulada. El cupo quedó liberado.")


# ---------------------------------------------------------------------------
# Listado de usuarios de la venue (admins asignan cupos con nombres reales)
# ---------------------------------------------------------------------------
@router.get("/users", response_model=list[VenueUserOut])
async def list_users(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    include_inactive: bool = False,
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    if venue_id not in user["venue_ids"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No perteneces a esta venue")
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT u.id, u.email, u.full_name, u.is_active,
                   array_agg(DISTINCT r.role)::text[] AS roles
            FROM venue_user_roles r
            JOIN users u ON u.id = r.user_id
            WHERE r.venue_id = %s AND (%s OR u.is_active)
            GROUP BY u.id, u.email, u.full_name, u.is_active
            ORDER BY u.is_active DESC, u.full_name
            """,
            (venue_id, include_inactive),
        )
        rows = await cur.fetchall()
    return rows


# ---------------------------------------------------------------------------
# Alta de personal de la venue (equipo) desde la UI del admin
# ---------------------------------------------------------------------------
@router.post("/users", response_model=VenueUserOut, status_code=status.HTTP_201_CREATED)
async def create_venue_user(
    venue_id: int,
    body: CreateVenueUser,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Crea (o reutiliza) un usuario y le asigna rol en esta venue.

    - Email existente: solo agrega el rol (si ya lo tiene, es idempotente).
    - Email nuevo: crea el usuario con el password dado (hasheado bcrypt).
    - super_admin nunca se asigna desde aqui (es rol de plataforma).
    """
    from app.core.security import hash_password

    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute("SELECT id FROM venues WHERE id=%s", (venue_id,))
        if not await cur.fetchone():
            raise HTTPException(404, "Venue no encontrada")

        await cur.execute(
            "SELECT id FROM users WHERE lower(email)=lower(%s)", (body.email,)
        )
        row = await cur.fetchone()
        if row:
            target_id = row["id"]
            # Si el usuario estaba desactivado (ej. fue removido de su única
            # venue), al reincorporarlo recupera el acceso. Sin esto, un
            # recontratado aparecía en el equipo pero no podía iniciar sesión.
            await cur.execute(
                "UPDATE users SET is_active=true WHERE id=%s AND NOT is_active",
                (target_id,),
            )
        else:
            await cur.execute(
                """
                INSERT INTO users (email, password_hash, full_name)
                VALUES (%s, %s, %s)
                RETURNING id
                """,
                (body.email, hash_password(body.password), body.full_name),
            )
            target_id = (await cur.fetchone())["id"]

        await cur.execute(
            """
            INSERT INTO venue_user_roles (venue_id, user_id, role)
            VALUES (%s, %s, %s)
            ON CONFLICT DO NOTHING
            """,
            (venue_id, target_id, body.role),
        )

        await cur.execute(
            """
            SELECT u.id, u.email, u.full_name,
                   array_agg(DISTINCT r.role)::text[] AS roles
            FROM users u
            JOIN venue_user_roles r ON r.user_id = u.id AND r.venue_id = %s
            WHERE u.id = %s
            GROUP BY u.id, u.email, u.full_name
            """,
            (venue_id, target_id),
        )
        out = await cur.fetchone()
        await db.commit()
    return out


# ---------------------------------------------------------------------------
# Listado de boletas del evento (para revisar, anular y reimprimir desde la UI)
# ---------------------------------------------------------------------------
@router.get("/events/{event_id}/tickets", response_model=TicketListOut)
async def list_tickets(
    venue_id: int, event_id: int,
    request: Request,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    phone: str | None = None,
    status: str | None = None,
    type_id: int | None = None,
    q: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """Boletas del evento, paginadas y con filtros.

    El staff (super_admin/admin) ve todas; el promotor ve SOLO las suyas. Antes
    esto era admin-only y el promotor no podia ni listar lo que habia vendido,
    asi que si perdia el enlace de una boleta no tenia forma de recuperarla.

    Filtros (y combinables entre si):
    - `?phone=` digitos, comparados normalizados por sufijo (el invitado no
      recibio su QR).
    - `?status=` issued|redeemed|voided|refunded — "las anuladas del evento".
    - `?type_id=` fila/tipo del evento — "las VIP".
    - `?q=` texto libre sobre el nombre del asistente.
    - `?limit=&offset=` pagina de a 50 (max 200).

    La respuesta trae `total` (con los filtros aplicados, sin paginar) para
    que la UI pinte "128 boletas · pagina 2 de 3" y el paginador no adivine.
    `?format=csv&all=1` devuelve el listado COMPLETO filtrado como CSV
    (stream de texto, sin limite de paginas) — para el contador.
    """
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor")
    roles = user["roles"].get(venue_id, [])
    is_staff = any(r in ("super_admin", "admin") for r in roles)

    params: list = [event_id]
    # Un promotor puro solo ve las boletas que el mismo vendio. Si ademas es
    # staff, manda el rol mas amplio (ve todo el evento).
    owner_filter = ""
    if not is_staff:
        owner_filter = " AND t.sold_by_user_id = %s"
        params.append(user["id"])

    phone_filter = ""
    if phone:
        # El teléfono puede estar guardado con +, espacios o guiones, y el
        # usuario lo recuerda sin el código de país: se comparan los últimos
        # dígitos a ambos lados (mismo criterio que el resto del sistema, ver
        # app.core.phone). Se exige un mínimo de dígitos para que una búsqueda
        # corta no arrastre medio evento.
        digits = digits_only(phone)
        if len(digits) >= 6:
            phone_filter = f" AND {phone_tail_sql('t.customer_phone', len(digits))} = %s"
            params.append(digits)

    status_filter = ""
    if status:
        if status not in ("issued", "redeemed", "voided", "refunded"):
            raise HTTPException(422, "Estado invalido")
        status_filter = " AND t.status = %s"
        params.append(status)

    type_filter = ""
    if type_id:
        type_filter = " AND t.ticket_type_id = %s"
        params.append(type_id)

    q_filter = ""
    if q and q.strip():
        q_filter = " AND t.customer_name ILIKE %s"
        params.append(f"%{q.strip()}%")

    where = f"{owner_filter}{phone_filter}{status_filter}{type_filter}{q_filter}"

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")

        # Para CSV: sin límite (el export es COMPLETO — un recorte silencioso
        # seria un informe contable mentiroso); para JSON: paginado. El total
        # con filtros alimenta el paginador en ambos casos.
        is_csv = request.query_params.get("format") == "csv"
        await cur.execute(
            f"SELECT count(*)::int AS n FROM tickets t WHERE t.event_id = %s{where}",
            tuple(params),
        )
        total = (await cur.fetchone())["n"]

        page = "LIMIT %s OFFSET %s" if not is_csv else ""
        await cur.execute(
            f"""
            SELECT t.id, t.customer_name, t.customer_phone, t.customer_email, t.status,
                   t.issued_at, t.price_cents_snapshot, t.payment_method,
                   tt.name AS type_name,
                   u.full_name AS sold_by_name,
                   (a.id IS NOT NULL) AS from_allocation
            FROM tickets t
            JOIN ticket_types tt ON tt.id = t.ticket_type_id
            LEFT JOIN users u ON u.id = t.sold_by_user_id
            LEFT JOIN promoter_allocations a ON a.id = t.allocation_id
            WHERE t.event_id = %s{where}
            ORDER BY t.id DESC
            {page}
            """,
            tuple([*params, limit, offset] if not is_csv else params),
        )
        rows = await cur.fetchall()

        # Auditoria de exportaciones (mig 019): la base de clientes (nombre,
        # telefono, email) es el activo mas facil de filtrar — cada CSV que
        # sale del sistema queda registrado con quien, cuando y cuanto.
        if is_csv:
            await write_audit(
                cur, venue_id, user["id"], "export", "tickets_csv", event_id,
                {"filas": len(rows), "filtros": {"status": status, "q": q, "type_id": type_id}},
            )
            await db.commit()

    if request.query_params.get("format") == "csv":
        # CSV del listado filtrado COMPLETO (sin paginar): mismo contrato de
        # permisos que el JSON — el promotor exporta solo las suyas.
        header = ["id", "asistente", "telefono", "email", "estado", "fila",
                  "vendida_por", "con_cupo", "precio", "medio_pago", "emitida"]
        rows_csv = [
            [
                r["id"], r["customer_name"], r["customer_phone"] or "",
                r["customer_email"] or "", r["status"], r["type_name"] or "",
                r["sold_by_name"] or "", "si" if r["from_allocation"] else "no",
                (r["price_cents_snapshot"] or 0) / 100,
                r["payment_method"] or "sin especificar",
                r["issued_at"].isoformat() if r["issued_at"] else "",
            ]
            for r in rows
        ]
        return _csv_response(f"boletas-evento-{event_id}.csv", header, rows_csv)
    return {"total": total, "items": rows}
