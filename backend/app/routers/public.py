"""Entrega pública de la boleta: el link que el promotor envía por WhatsApp.

Sin autenticación a propósito. El token crudo del QR **es** el secreto: 32 bytes
de entropía, generados con `secrets.token_urlsafe`, y en la DB solo vive su
SHA-256. Quien tiene el link, tiene la boleta — que es exactamente lo que se
busca al entregarla. Por eso el nombre del asistente va impreso en la imagen y
el bouncer lo compara en la puerta (ver docs/arquitectura/03-seguridad.md).
"""
import json
import secrets
from datetime import datetime, timedelta, timezone
from html import escape
from typing import Annotated
from zoneinfo import ZoneInfo

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import HTMLResponse
from psycopg.types.json import Jsonb
from starlette.concurrency import run_in_threadpool

from app.core.categories import EVENT_CATEGORIES
from app.core.config import get_settings
from app.core.db import get_db
from app.core.db_errors import translate_db_error
from app.core.fan_access import create_fan_access_token, verify_fan_access_token
from app.core.mailer import Mailer
from app.core.phone import digits_only, phone_tail_sql
from app.core.public_venue import public_venue_name_sql
from app.core.rate_limit import enforce_rate_limit
from app.core.refs import payment_reference
from app.deps import ensure_roles, get_optional_current_user
from app.schemas import (
    FanAnswerIn,
    FanContactCorrectionIn,
    FanContactCorrectionOut,
    FanCredentialRequest,
    FanLookupRequest,
    FanQuestionOut,
    FanQuestionsOut,
    FanStreamOut,
    FanTicketsOut,
    FanTicketTokenOut,
    PublicCheckoutOut,
    PublicCheckoutRequest,
    PublicCheckoutStatusOut,
)
from app.services import wompi
from app.services.checkout import create_reserved_payment
from app.services.fees import compute_fees
from app.services.ticket_image import build_ticket_image

router = APIRouter(prefix="/public", tags=["publico"])

# Rate limit por IP en la DB (mig 041). El dict en memoria que vivía aquí no
# limitaba nada en serverless: cada invocación podía caer en otra instancia y
# el dict moría en cada cold start. El contador compartido en Postgres sí vale
# en todas las instancias. Scope propio para no mezclar cupos entre endpoints.
_RATE_SCOPE = "public:catalog"
_RATE_LIMIT = 120  # peticiones por minuto por IP
_RATE_WINDOW = 60


async def _rate_limit(
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
) -> None:
    await enforce_rate_limit(
        request,
        db,
        scope=_RATE_SCOPE,
        max_hits=_RATE_LIMIT,
        window_seconds=_RATE_WINDOW,
    )

# Ni cachear ni indexar: el contenido cambia (la boleta puede anularse) y no
# queremos que un buscador archive los QRs de los clientes.
_IMAGE_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
}


def _public_contact(row: dict) -> tuple[str | None, str | None, str | None]:
    """Contacto que la ficha puede mostrar, con permiso explícito.

    Prioridad: contacto propio del EVENTO (intencional, mig 057) > contacto
    del negocio solo si `public_contact_enabled` y el canal está autorizado.
    Un dato guardado no se publica por existir.
    """
    event_name = row.get("event_contact_name")
    event_phone = row.get("event_contact_phone")
    if event_name or event_phone:
        return event_name, event_phone, None

    if not row.get("public_contact_enabled"):
        return None, None, None
    channels = set(row.get("public_contact_channels") or [])
    name = row.get("venue_contact_name")
    phone = row.get("venue_contact_phone") if "whatsapp" in channels else None
    email = row.get("venue_contact_email") if "email" in channels else None
    if not phone and not email:
        return None, None, None
    return name, phone, email


def _qr_window(row: dict) -> tuple[bool, str | None]:
    """Ventana de activación del QR (mig 013, patrón DICE).

    El QR se dibuja solo desde starts_at - qr_unlock_minutes. Misma regla
    que public_tickets._activation: el GET de imagen es complementario al
    POST, y el QR regenerable desde el token exige que AMBOS honren la
    ventana. Devuelve (activo, mensaje_para_la_pagina).
    """
    unlock = row.get("qr_unlock_minutes")
    if unlock is None:
        unlock = 60
    starts_at: datetime = row["starts_at"]
    ready_at = starts_at - timedelta(minutes=unlock)
    if datetime.now(ready_at.tzinfo) >= ready_at:
        return True, None
    try:
        tz = ZoneInfo(row["event_timezone"])
    except Exception:
        tz = ready_at.tzinfo
    msg = (
        f"Tu QR se activa el {ready_at.astimezone(tz).strftime('%d/%m %H:%M')}. "
        f"El evento empieza el {starts_at.astimezone(tz).strftime('%d/%m %H:%M')}."
    )
    return False, msg


def _stream_window(row: dict) -> tuple[bool, str | None, datetime | None, datetime | None]:
    """Ventana de la transmisión de una boleta virtual (mig 075).

    El horario contratado manda. Si el organizador no cargó una ventana, cae
    al horario del evento (inicio a fin, o dos horas si no hay fin). Devuelve
    (activa, mensaje, inicio, fin); el enlace NO se incluye aquí.
    """
    starts_at = row.get("stream_starts_at") or row.get("starts_at")
    ends_at = row.get("stream_ends_at") or row.get("ends_at")
    if starts_at is None:
        return False, "El organizador aún no publicó el horario de la transmisión.", None, None
    if ends_at is None:
        ends_at = starts_at + timedelta(hours=2)
    now = datetime.now(starts_at.tzinfo) if starts_at.tzinfo else datetime.now(timezone.utc)
    try:
        tz = ZoneInfo(row.get("event_timezone") or "America/Bogota")
    except Exception:
        tz = timezone.utc
    if now < starts_at:
        return (
            False,
            f"La transmisión abre el {starts_at.astimezone(tz).strftime('%d/%m %H:%M')}.",
            starts_at,
            ends_at,
        )
    if now > ends_at:
        return (
            False,
            f"La transmisión terminó el {ends_at.astimezone(tz).strftime('%d/%m %H:%M')}.",
            starts_at,
            ends_at,
        )
    if not row.get("stream_url"):
        return (
            False,
            "La transmisión está en horario, pero el organizador aún no publicó el enlace.",
            starts_at,
            ends_at,
        )
    return True, "La transmisión está abierta.", starts_at, ends_at


def _starts_at_label(starts_at: datetime, tz_name: str | None) -> str:
    """Inicio del evento en su zona horaria, con la zona visible.

    Si la zona IANA no es resoluble (falta tzdata en el sistema) cae a UTC en
    vez de romper la generación de la boleta.
    """
    try:
        tz = ZoneInfo(tz_name) if tz_name else timezone.utc
    except Exception:
        tz = timezone.utc
    local = starts_at.astimezone(tz)
    return f"{local.strftime('%d/%m/%Y %H:%M')} ({local.tzname()})"


# --- Descubrimiento publico (app de consumidor) ---------------------------
#
# La pantalla "Inicio" del fan lista eventos sin login. El catalogo NO tiene
# precio en `events` (vive en `ticket_types`), asi que aqui se deriva. La
# categoria (mig 043) ahora SI es una columna elegida por el organizador; la
# heuristica por texto queda solo como fallback para eventos sin categoria.
# Todo es best-effort: un evento sin localidades igual se muestra (precio
# null), nunca rompe el listado.

# Lista canonica compartida con la DB y los validadores (mig 043).
_CATEGORIES = EVENT_CATEGORIES

_CATEGORY_HINTS = (
    ("Deportes", ("futbol", "fútbol", "liga", "copa", "deporte", "baloncesto",
                  "estadio", "partido", "torneo", "box", "atletismo", "nba")),
    ("Teatro", ("teatro", "obra", "teatral", "monologo", "monólogo", "danza",
                "comedia", "musical", "stand up", "standup")),
    ("Música", ("musica", "música", "concierto", "festival", "electronica",
                "electrónica", "rock", "pop", "banda", "dj", "reggaeton",
                "salsa", "vallenato", "sinfon", "orquesta", "tour", "live",
                "jazz", "indie")),
)


def _category_of(
    name: str | None, description: str | None, chosen: str | None = None
) -> str:
    """Categoria del evento: la elegida si existe, si no la inferida del texto.

    Determinista. `chosen` (mig 043) gana siempre: el organizador manda sobre
    la heuristica. Solo si no eligio (eventos viejos) se adivina, y el default
    sigue siendo "Música" (el rubro del negocio).
    """
    if chosen and chosen.strip():
        return chosen.strip()
    text = f"{name or ''} {description or ''}".lower()
    for label, hints in _CATEGORY_HINTS:
        if any(h in text for h in hints):
            return label
    return "Música"


def _sold_pct(active: int, capacity: int | None) -> int | None:
    """% de aforo vendido (boletas vivas / capacidad), acotado a [0, 100]."""
    if not capacity or capacity <= 0:
        return None
    return max(0, min(100, round(active * 100 / capacity)))


@router.get("/events")
async def public_events(
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    city: str | None = Query(None, max_length=80),
    category: str | None = Query(None, max_length=40),
    limit: int = Query(50, ge=1, le=100),
):
    """Catalogo publico de eventos para la app del fan (sin autenticacion).

    Devuelve solo eventos con venta abierta (`published`/`live`), con su venue,
    precio minimo, categoria inferida y aforo vendido. `city` filtra por nombre
    de venue o lugar (ILIKE); `category` por la categoria derivada.
    """
    async with db.cursor() as cur:
        # El filtro de ciudad va en SQL (ILIKE sobre lugar + venue): si se
        # aplicara en Python despues del LIMIT, la ventana de 50 filas se
        # llenaria con eventos de otras ciudades y el filtro devolveria casi
        # nada. La categoria es heuristica (no vive en la DB), asi que si se
        # pide se traen mas filas y se recorta al final.
        conds = [
            "e.status IN ('published', 'live')",
            "e.starts_at >= now()",
            "e.parent_event_id IS NULL",
        ]
        params: list = []
        if city and city.strip():
            conds.append(
                f"(coalesce(e.location, '') || ' ' || "
                f"{public_venue_name_sql()}) ILIKE %s"
            )
            params.append(f"%{city.strip()}%")
        # La categoria NO se filtra en SQL: un evento sin categoria elegida
        # (mig 043) igual cuenta si la heuristica lo clasifica ahi. Se traen
        # mas filas y se recorta en Python, como antes.
        want_cat = (category or "").strip()
        fetch_limit = limit if not want_cat else min(200, limit * 4)
        params.append(fetch_limit)
        await cur.execute(
            f"""
            SELECT e.id, e.name, e.description, e.flyer_url, e.location,
                   e.starts_at, e.event_timezone, e.capacity, e.status,
                   e.category,
                   {public_venue_name_sql()} AS venue_name,
                   -- Contacto por evento (mig 057) y del local (mig 036),
                   -- separados: el fallback del local solo se usa si la
                   -- persona autorizó publicarlo (mig 059).
                   to_jsonb(e) ->> 'contact_name' AS event_contact_name,
                   to_jsonb(e) ->> 'contact_phone' AS event_contact_phone,
                   v.contact_name AS venue_contact_name,
                   v.contact_phone AS venue_contact_phone,
                   to_jsonb(v) ->> 'contact_email' AS venue_contact_email,
                   coalesce(
                     (to_jsonb(v) ->> 'public_contact_enabled')::boolean, false
                   ) AS public_contact_enabled,
                   coalesce(
                     to_jsonb(v) -> 'public_contact_channels', '[]'::jsonb
                   ) AS public_contact_channels,
                   (SELECT min(tt.price_cents) FROM ticket_types tt
                     WHERE tt.event_id = e.id AND tt.is_active
                       AND NOT tt.is_pass_only
                       AND NOT tt.is_courtesy AND tt.price_cents > 0) AS min_price,
                   (SELECT count(*) FROM tickets t
                     WHERE t.event_id = e.id
                       AND t.status IN ('issued', 'redeemed'))::int AS active
            FROM events e
            JOIN venues v ON v.id = e.venue_id
            WHERE {" AND ".join(conds)}
            ORDER BY e.starts_at ASC
            LIMIT %s
            """,
            tuple(params),
        )
        rows = await cur.fetchall()

    events: list[dict] = []
    for r in rows:
        cat = _category_of(r["name"], r["description"], r["category"])
        if want_cat and want_cat.lower() != cat.lower():
            continue
        where = " · ".join(p for p in (r["location"], r["venue_name"]) if p)
        contact_name, contact_phone, contact_email = _public_contact(r)
        events.append(
            {
                "id": r["id"],
                "name": r["name"],
                "venue": r["venue_name"],
                "location": r["location"],
                "where": where,
                "starts_at": r["starts_at"].isoformat(),
                "timezone": r["event_timezone"],
                "flyer_url": r["flyer_url"],
                "category": cat,
                "price_cents": int(r["min_price"]) if r["min_price"] is not None else None,
                "sold_pct": _sold_pct(r["active"], r["capacity"]),
                "status": r["status"],
                # Contacto del organizador (mig 036/059): solo si está
                # autorizado y el canal elegido lo permite.
                "contact_name": contact_name,
                "contact_phone": contact_phone,
                "contact_email": contact_email,
            }
        )
    events = events[:limit]

    # Ciudad de cabecera: la mas frecuente del catalogo (o la pedida).
    cities: dict[str, int] = {}
    for e in events:
        c = (e["location"] or e["venue"] or "").split(",")[0].strip()
        if c:
            cities[c] = cities.get(c, 0) + 1
    top_city = max(cities, key=cities.get) if cities else (city or "")
    # `has_more`: se llenó la ventana pedida, así que hay (o puede haber) más
    # eventos fuera de la página. La vitrina lo usa para avisar que su filtro
    # en cliente no ve todo el catálogo — un filtro que miente en silencio es
    # peor que uno que dice su límite (Ley de Tesler).
    #
    # `payments_enabled`: si el pago en línea (Wompi) está configurado. Sin
    # esto, la ficha del evento ofrece "Comprar boleto" en un entorno que
    # responde 503 al iniciar el cobro: el fan llena el formulario para
    # chocarse con un error. La UI cae al WhatsApp del organizador en su lugar.
    return {
        "city": top_city,
        "count": len(events),
        "has_more": len(rows) >= fetch_limit,
        "categories": list(_CATEGORIES),
        "payments_enabled": get_settings().wompi_enabled,
        "events": events,
    }


@router.get("/events/{event_id}")
async def public_event_detail(
    event_id: int,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    preview: bool = Query(False),
    user: Annotated[dict | None, Depends(get_optional_current_user)] = None,
):
    """Detalle publico de un evento (pantalla "comprar boleto").

    Hermano de `/events`: misma derivacion (categoria inferida, precio minimo,
    aforo vendido) mas el `description` y las localidades activas con su
    precio. Mismas condiciones que el listado — venta abierta
    (`published`/`live`) y futuro —: un borrador, un evento pasado o un id
    inexistente responden 404 por igual, para no filtrar la existencia de
    eventos no publicos ni ofrecer compra de algo que ya ocurrio.

    `?preview=1` es la excepción: exige sesión con rol admin en la venue y
    devuelve la ficha actual aunque sea borrador, para revisarla antes de
    publicar. La venta sigue cerrada en vista previa (el front no muestra CTA).
    """
    if preview:
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "No autenticado")
        async with db.cursor() as cur:
            await cur.execute(
                "SELECT venue_id FROM events WHERE id = %s", (event_id,)
            )
            ev_owner = await cur.fetchone()
        if not ev_owner:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Evento no encontrado")
        ensure_roles(user, int(ev_owner["venue_id"]), "super_admin", "admin")

    visibility = (
        "e.id = %s"
        if preview
        else "e.id = %s AND e.status IN ('published', 'live') AND e.starts_at >= now()"
    )
    async with db.cursor() as cur:
        await cur.execute(
            f"""
            SELECT e.id, e.name, e.description, e.flyer_url, e.location,
                   e.starts_at, e.event_timezone, e.capacity, e.status,
                   e.category, e.min_age, e.dress_code, e.doors_open_at,
                   -- Por to_jsonb: si la migracion 055 no esta aplicada la
                   -- columna no existe y un SELECT directo tumba la ficha
                   -- entera con 500. Faltante -> false, no error.
                   coalesce(
                     (to_jsonb(e) ->> 'waiting_room_enabled')::boolean, false
                   ) AS waiting_room_enabled,
                   -- Identidad pública (mig 057). Por to_jsonb por la misma
                   -- razón que waiting_room: si la migración aún no corrió, la
                   -- ficha sigue funcionando con los campos viejos.
                   to_jsonb(e) ->> 'video_url' AS video_url,
                   to_jsonb(e) ->> 'location_url' AS location_url,
                   to_jsonb(e) ->> 'stream_url' AS stream_url,
                   (to_jsonb(e) ->> 'stream_starts_at')::timestamptz
                       AS stream_starts_at,
                   (to_jsonb(e) ->> 'stream_ends_at')::timestamptz
                       AS stream_ends_at,
                   {public_venue_name_sql()} AS venue_name,
                   to_jsonb(e) ->> 'contact_name' AS event_contact_name,
                   to_jsonb(e) ->> 'contact_phone' AS event_contact_phone,
                   v.contact_name AS venue_contact_name,
                   v.contact_phone AS venue_contact_phone,
                   to_jsonb(v) ->> 'contact_email' AS venue_contact_email,
                   coalesce(
                     (to_jsonb(v) ->> 'public_contact_enabled')::boolean, false
                   ) AS public_contact_enabled,
                   coalesce(
                     to_jsonb(v) -> 'public_contact_channels', '[]'::jsonb
                   ) AS public_contact_channels,
                   (SELECT count(*) FROM tickets t
                     WHERE t.event_id = e.id
                       AND t.status IN ('issued', 'redeemed'))::int AS active
            FROM events e
            JOIN venues v ON v.id = e.venue_id
            WHERE {visibility}
            """,
            (event_id,),
        )
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Evento no encontrado")
        await cur.execute(
            """
            SELECT t.id, t.name, t.price_cents, t.quantity, t.is_courtesy,
                   t.is_virtual,
                   (SELECT count(*) FROM tickets tk
                     WHERE tk.ticket_type_id = t.id
                       AND tk.status NOT IN ('voided', 'refunded'))::int AS sold
            FROM ticket_types t
            WHERE t.event_id = %s AND t.is_active AND NOT t.is_pass_only
            ORDER BY t.price_cents NULLS LAST, t.name
            """,
            (event_id,),
        )
        types = await cur.fetchall()
        # Jornadas que cubre cada pase (mig 068). La ficha las muestra bajo el
        # nombre del pase para que el fan sepa qué está comprando.
        pass_map: dict[int, list] = {}
        if types:
            await cur.execute(
                """
                SELECT ps.pass_ticket_type_id, e.id, e.name, e.starts_at
                  FROM pass_sessions ps
                  JOIN events e ON e.id = ps.session_event_id
                 WHERE ps.pass_ticket_type_id = ANY(%s)
                 ORDER BY e.starts_at, e.id
                """,
                ([t["id"] for t in types],),
            )
            for ps in await cur.fetchall():
                pass_map.setdefault(ps["pass_ticket_type_id"], []).append(
                    {
                        "id": ps["id"],
                        "name": ps["name"],
                        "starts_at": ps["starts_at"].isoformat(),
                    }
                )
        # Cupo total para el gate de agotado: SUM de TODAS las localidades,
        # igual que `join_waitlist` (que no filtra por is_active). Consultarlo
        # aparte evita que una localidad desactivada desincronice el CTA.
        await cur.execute(
            "SELECT COALESCE(SUM(quantity), 0)::int AS quota "
            "FROM ticket_types WHERE event_id = %s AND NOT is_pass_only",
            (event_id,),
        )
        quota = (await cur.fetchone())["quota"]
        # Lineup (mig 043): ahora sí hay artistas. Orden de cartel.
        await cur.execute(
            """
            SELECT id, name, role, sort_order, image_url, starts_at, description
              FROM event_lineup
             WHERE event_id = %s ORDER BY sort_order, id
            """,
            (event_id,),
        )
        lineup_rows = await cur.fetchall()

    prices = [
        int(t["price_cents"])
        for t in types
        if t["price_cents"] is not None and t["price_cents"] > 0
    ]
    min_price = min(prices) if prices else None
    cat = _category_of(row["name"], row["description"], row["category"])
    where = " · ".join(p for p in (row["location"], row["venue_name"]) if p)

    # Agotado: mismo gate que `join_waitlist` (la lista existe solo cuando NO
    # hay boletas). El cupo es SUM(quantity) de TODAS las localidades, acotado
    # por el aforo del evento; el publico ve la lista de espera en vez de
    # "comprar".
    sold_out = row["active"] >= min(int(quota), int(row["capacity"]))
    contact_name, contact_phone, contact_email = _public_contact(row)

    # Lineup (mig 043): los artistas de la noche, en orden de cartel. Vacio si
    # el organizador no cargo ninguno (la UI muestra "por anunciar").
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "flyer_url": row["flyer_url"],
        # Identidad pública (mig 057): clip opcional y mapa confirmado.
        # NULL = la ficha no muestra el bloque (no inventa un video ni un mapa).
        "video_url": row["video_url"],
        "location_url": row["location_url"],
        "location": row["location"],
        "venue": row["venue_name"],
        "where": where,
        "starts_at": row["starts_at"].isoformat(),
        "timezone": row["event_timezone"],
        "category": cat,
        "price_cents": min_price,
        "sold_pct": _sold_pct(row["active"], row["capacity"]),
        "sold_out": sold_out,
        "status": row["status"],
        # Sala de espera (mig 055): la UI solo pregunta por la fila si está
        # activa. Es un booleano: la tanda y los minutos son configuración
        # interna y no se exponen.
        "waiting_room": bool(row["waiting_room_enabled"]),
        # Ficha del evento (mig 043): lo que el invitado pregunta en la puerta.
        "min_age": row["min_age"],
        "dress_code": row["dress_code"],
        "doors_open_at": (
            row["doors_open_at"].isoformat() if row["doors_open_at"] else None
        ),
        # Transmisión (mig 075): la ficha solo anuncia que existe y cuándo.
        # La URL se entrega a cada boleta virtual dentro de la ventana.
        "stream": (
            {
                "starts_at": (
                    row["stream_starts_at"].isoformat()
                    if row["stream_starts_at"]
                    else row["starts_at"].isoformat()
                ),
                "ends_at": (
                    row["stream_ends_at"].isoformat()
                    if row["stream_ends_at"]
                    else None
                ),
            }
            if row["stream_url"]
            else None
        ),
        # Contacto del organizador (mig 036/057/059): el del evento si lo
        # definió; si no, el del local solo con autorización y canal elegido.
        "contact_name": contact_name,
        "contact_phone": contact_phone,
        "contact_email": contact_email,
        "ticket_types": [
            {
                "id": t["id"],
                "name": t["name"],
                "price_cents": int(t["price_cents"])
                if t["price_cents"] is not None
                else None,
                "quantity": t["quantity"],
                "is_courtesy": t["is_courtesy"],
                "is_virtual": t["is_virtual"],
                # Vendidas del tipo (boletas vivas): permite deshabilitar la
                # localidad agotada en el checkout. Best-effort: el aforo real
                # lo decide emit_ticket dentro de la transaccion.
                "sold_out": t["sold"] >= t["quantity"],
                "sessions": pass_map.get(t["id"], []),
            }
            for t in types
        ],
        "lineup": [
            {
                "id": row["id"], "name": row["name"], "role": row["role"],
                "sort_order": row["sort_order"],
                "image_url": row["image_url"],
                "starts_at": (
                    row["starts_at"].isoformat() if row["starts_at"] else None
                ),
                "description": row["description"],
            }
            for row in lineup_rows
        ],
        # Si el pago en línea está configurado: sin esto la pantalla ofrece
        # "Comprar boleto" y el POST devuelve 503. La UI muestra el contacto
        # del organizador para encargar la boleta en su lugar.
        "payments_enabled": get_settings().wompi_enabled,
    }


# --- Checkout publico del fan (sin cuenta, dinero primero) ----------------
#
# El fan compra solo, sin login. El flujo reutiliza ENTERO el ciclo de la
# mig 023 (el mismo del cobro del admin): se crea el link de Wompi aqui y el
# WEBHOOK emite la boleta cuando el pago se aprueba. Lo unico distinto es que
# no hay sesion: la `reference` (128 bits) es la capability con la que el fan
# vuelve a consultar, y el CONTACTO es la identidad con la que despues reclama
# su QR en /boletas. El token del QR jamas sale de este endpoint.

# Rate limit propio y mas duro que el del catalogo: cada POST crea una fila y
# llama a Wompi (dinero real). 20/hora por IP frena el abuso sin molestar a un
# fan legitimo que compra dos o tres boletas. En la DB (mig 041), no en
# memoria: si no, en serverless no frenaria nada.
_CHECKOUT_SCOPE = "public:checkout"
_CHECKOUT_RATE_LIMIT = 20
_CHECKOUT_WINDOW = 3600


async def _checkout_rate_limit(
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
) -> None:
    await enforce_rate_limit(
        request,
        db,
        scope=_CHECKOUT_SCOPE,
        max_hits=_CHECKOUT_RATE_LIMIT,
        window_seconds=_CHECKOUT_WINDOW,
        message="Demasiados intentos de compra. Espera unos minutos.",
    )


def _coupon_discount(kind: str, value: int, price_cents: int) -> int:
    """Descuento en centavos para un cupón sobre un precio. Nunca supera el
    precio (una boleta no queda con saldo a favor) ni es negativo."""
    if kind == "percent":
        return min(price_cents, price_cents * value // 100)
    return min(price_cents, int(value))


async def _resolve_coupon(
    cur,
    event_id: int,
    code: str | None,
    price_cents: int,
    ticket_type_id: int | None = None,
) -> tuple[dict | None, int]:
    """Busca y valida el cupón para una compra. Devuelve (cupón, descuento).

    Silencioso a propósito: un código que no existe, está vencido, agotado o
    desactivado simplemente no aplica (descuento 0). Rechazar la compra por un
    cupón mal escrito sería regalar la venta por un detalle.
    """
    text = (code or "").strip().upper().replace(" ", "")
    if not text:
        return None, 0
    await cur.execute(
        """
        SELECT id, code, kind, value, max_uses, used_count, expires_at, is_active,
               ticket_type_ids,
               (SELECT count(*) FROM ticket_payments p WHERE p.coupon_id=coupons.id
                AND p.status='pending' AND p.reservation_expires_at > now()) AS reserved
          FROM coupons
         WHERE event_id = %s AND lower(code) = lower(%s)
        """,
        (event_id, text),
    )
    coupon = await cur.fetchone()
    if not coupon or not coupon["is_active"]:
        return None, 0
    if coupon["expires_at"] is not None and coupon["expires_at"] <= datetime.now(timezone.utc):
        return None, 0
    if coupon["max_uses"] is not None and (coupon["used_count"] + coupon["reserved"]) >= coupon["max_uses"]:
        return None, 0
    eligible = coupon["ticket_type_ids"]
    if eligible and ticket_type_id is not None and int(ticket_type_id) not in {
        int(x) for x in eligible
    }:
        return None, 0
    discount = _coupon_discount(coupon["kind"], coupon["value"], price_cents)
    return coupon, discount


@router.get("/events/{event_id}/coupon")
async def public_coupon_quote(
    event_id: int,
    ticket_type_id: int,
    code: str,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Cotiza un cupón para el fan: cuánto pagaría. NO lo consume.

    El descuento se calcula aquí para que el fan vea el precio final antes de
    ir a Wompi; el cobro real (y el consumo del cupón) ocurre en el checkout.
    """
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT t.price_cents
              FROM ticket_types t
              JOIN events e ON e.id = t.event_id
             WHERE t.id = %s AND e.id = %s
               AND NOT t.is_pass_only
               AND e.status IN ('published', 'live') AND e.starts_at >= now()
            """,
            (ticket_type_id, event_id),
        )
        row = await cur.fetchone()
        if not row or row["price_cents"] <= 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Localidad no disponible")
        price = int(row["price_cents"])
        coupon, discount = await _resolve_coupon(
            cur, event_id, code, price, ticket_type_id
        )
    return {
        "code": coupon["code"] if coupon else (code or "").strip().upper(),
        "discount_in_cents": discount,
        "original_in_cents": price,
        "final_in_cents": price - discount,
        "valid": coupon is not None,
    }


@router.post(
    "/events/{event_id}/checkout",
    response_model=PublicCheckoutOut,
    status_code=status.HTTP_201_CREATED,
)
async def public_checkout(
    event_id: int,
    body: PublicCheckoutRequest,
    request: Annotated[None, Depends(_checkout_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """El fan inicia la compra: se crea el cobro y se devuelve la URL de Wompi.

    El MONTO sale de `ticket_types.price_cents`, nunca del cliente. Solo se
    cobra una localidad de pago activa de un evento con venta abierta (mismas
    condiciones que el detalle publico). La boleta se emite DESPUES, cuando el
    webhook confirme el pago: el dinero entra primero, el QR despues.
    """
    s = get_settings()

    # La sala de espera se evalúa ANTES que cualquier otra cosa, incluido el
    # chequeo de Wompi: si el fan todavía no tiene turno, no debe llegar ni a
    # la puerta del pago. Además deja el rechazo observable en entornos sin
    # pasarela configurada (si no, todo responde 503 y la sala es invisible).
    async with db.cursor() as cur:
        try:
            await cur.execute(
                "SELECT require_waiting_pass(%s, %s)", (event_id, body.waiting_pass)
            )
            await cur.fetchone()
        except psycopg.Error as error:
            raise translate_db_error(error, overrides={
                "waiting_pass_required": (
                    429, "Estás en la sala de espera: aún no es tu turno."
                ),
                "waiting_pass_invalid": (
                    429, "Tu turno en la sala venció. Vuelve a la fila."
                ),
            }) or error from error

    if not s.wompi_enabled:
        raise HTTPException(503, "Pagos online no configurados en este entorno")

    async with db.cursor() as cur:
        # Localidad pagada del evento, con la misma guardia de venta que el
        # detalle publico: un borrador/pasado/cerrado no vende (404 uniforme).
        await cur.execute(
            """
            SELECT t.id AS type_id, t.price_cents, t.quantity, t.is_active,
                   e.id AS event_id, e.venue_id, e.name AS event_name,
                   e.status,
                   COALESCE(pp.status, 'not_started') AS payout_status,
                   COALESCE(e.ends_at, e.starts_at + INTERVAL '12 hours') AS end_at
            FROM ticket_types t
            JOIN events e ON e.id = t.event_id
            LEFT JOIN venue_payout_profiles pp ON pp.venue_id = e.venue_id
            WHERE t.id = %s AND e.id = %s
              AND NOT t.is_pass_only
              AND e.status IN ('published', 'live')
              AND e.starts_at >= now()
            """,
            (body.ticket_type_id, event_id),
        )
        row = await cur.fetchone()
        if (
            not row
            or not row["is_active"]
            or row["price_cents"] <= 0
        ):
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Esa localidad no esta disponible para compra",
            )
        if row["payout_status"] != "approved":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "El organizador aún no está habilitado para cobrar en línea.",
            )

        now = datetime.now(timezone.utc)
        expires_at = min(row["end_at"], now + timedelta(minutes=15))
        if expires_at <= now:
            raise HTTPException(409, "El evento ya termino: no se puede comprar")

        # Cupón (mig 043): se resuelve ANTES de crear el link de Wompi, porque
        # el monto que se cobra es el NETO. Un cupón inválido no aplica.
        list_price = int(row["price_cents"])
        coupon, discount = await _resolve_coupon(
            cur, event_id, body.coupon_code, list_price, body.ticket_type_id
        )
        charge_cents = list_price - discount
        # Un cupón que cubre TODO el precio deja el cobro en 0: Wompi no cobra
        # $0 y la boleta gratis es una cortesía, no un descuento. Se avisa en
        # vez de crear un cobro roto (misma intención que el tope del 99% en
        # la tabla de cupones).
        if charge_cents <= 0:
            raise HTTPException(
                409,
                "Ese cupón cubre el precio completo: pídele al organizador "
                "una boleta de cortesía.",
            )
        # Costos transparentes (mig 072) + comisión de Enty (mig 074): el
        # comprador ve y paga el mismo total que muestra la ficha. El cupón
        # descuenta la boleta, no los cargos.
        await cur.execute(
            "SELECT service_fee_cents, payment_fee_pct, tax_pct,"
            " platform_fee_bps, platform_fee_fixed_cents, platform_fee_payer"
            " FROM event_fee_config WHERE event_id=%s",
            (event_id,),
        )
        fee_cfg = await cur.fetchone() or {}
        fees = compute_fees(
            base_cents=list_price,
            discount_cents=discount,
            service_fee_cents=int(fee_cfg.get("service_fee_cents") or 0),
            payment_fee_pct=float(fee_cfg.get("payment_fee_pct") or 0),
            tax_pct=float(fee_cfg.get("tax_pct") or 0),
            platform_fee_bps=int(fee_cfg.get("platform_fee_bps") or 0),
            platform_fee_fixed_cents=int(fee_cfg.get("platform_fee_fixed_cents") or 0),
            platform_fee_payer=fee_cfg.get("platform_fee_payer") or "organizer",
        )
        charge_cents = fees.buyer_total_cents
        reference = payment_reference(event_id)
        email = (body.customer_email or "").strip() or None
        promoter_id = None
        link_id = None
        if body.promoter_ref:
            # El link es público y no revela datos del promotor. Solo atribuye
            # si sigue activo, pertenece al evento y la persona conserva la
            # asignación y el rol. Un link viejo no rompe la compra: se ignora.
            await cur.execute(
                """
                SELECT l.id, l.promoter_id
                  FROM promoter_links l
                  JOIN events e ON e.id = l.event_id
                  JOIN event_staff s ON s.event_id = l.event_id
                                    AND s.user_id = l.promoter_id
                                    AND s.role = 'promotor'
                  JOIN venue_user_roles r ON r.venue_id = e.venue_id
                                         AND r.user_id = l.promoter_id
                                         AND r.role = 'promotor'
                 WHERE l.public_id = %s AND l.event_id = %s AND l.is_active
                """,
                (body.promoter_ref, event_id),
            )
            link = await cur.fetchone()
            if link:
                promoter_id = link["promoter_id"]
                link_id = link["id"]
                await cur.execute(
                    """
                    INSERT INTO promoter_link_events (link_id, kind, reference)
                    VALUES (%s, 'checkout_started', %s)
                    """,
                    (link_id, reference),
                )
        _, link = await create_reserved_payment(
            db, event_id=event_id, ticket_type_id=body.ticket_type_id,
            reference=reference, amount=charge_cents, customer_name=body.customer_name,
            customer_phone=body.customer_phone, customer_email=email,
            user_id=promoter_id, coupon_id=coupon["id"] if coupon else None,
            discount=discount, expires_at=expires_at,
            name=f"Boleta - {row['event_name']}",
            description=f"Compra del fan ({row['event_name']})",
            redirect_url=f"{s.app_public_url}/evento/{event_id}?pago={reference}",
            customer_birth_date=body.customer_birth_date,
            promoter_id=promoter_id,
            sale_channel="promoter_link" if promoter_id else "public",
            fee_breakdown=fees.as_dict(),
        )

    return PublicCheckoutOut(
        reference=reference,
        payment_url=wompi.link_public_url(link),
        amount_in_cents=charge_cents,
        event_id=event_id,
        event_name=row["event_name"],
    )


@router.post(
    "/promoter-links/{public_id}/visit",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def promoter_link_visit(
    public_id: str,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
) -> None:
    """Registra una apertura del link público del promotor.

    No identifica al visitante ni expone al promotor: el `public_id` es la
    única llave. Se cuenta una apertura por llamada; el frontend la hace una
    vez al montar la ficha, no en cada scroll.
    """
    async with db.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO promoter_link_events (link_id, kind)
            SELECT id, 'view' FROM promoter_links
             WHERE public_id = %s AND is_active
            """,
            (public_id,),
        )
        await db.commit()
    return None


@router.get("/checkout/{reference}", response_model=PublicCheckoutStatusOut)
async def public_checkout_status(
    reference: str,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Estado del checkout para el polling tras volver de Wompi.

    La `reference` (128 bits aleatorios) es el secreto; no se enumeran cobros.
    No se devuelve el token del QR: si `approved`, la boleta se reclama por
    contacto en /boletas. La respuesta solo confirma si el dinero entro.
    """
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT p.reference, p.status, p.event_id, p.ticket_id,
                   e.name AS event_name
              FROM ticket_payments p
              JOIN events e ON e.id = p.event_id
             WHERE p.reference = %s
            """,
            (reference,),
        )
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cobro no encontrado")
    return PublicCheckoutStatusOut(
        reference=row["reference"],
        status=row["status"],
        event_id=row["event_id"],
        event_name=row["event_name"],
        ticket_id=row["ticket_id"],
        approved=row["status"] == "approved",
    )


# --- App del fan: "mis boletas" (magic link) ------------------------------
#
# El fan no tiene cuenta. El contacto (correo o telefono) NO es la credencial:
# es solo con quien se pidio la boleta, un dato que cualquiera puede conocer.
# La credencial es el ENLACE firmado que se entrega a ese contacto (o la
# posesion de otra boleta suya, que tambien prueba que el contacto es suyo).
# Antes el contacto solo bastaba: con un correo ajeno se listaban sus boletas y
# se pedia su QR — que rota el token y deja al dueno sin entrada.

# Normalizacion del contacto. El correo solo se recorta y baja a minusculas
# (sus puntos son significativos: "a.b@x.com" no es "ab@x.com"). El telefono se
# reduce a digitos, para que "+57 300 123 4567" y "573001234567" sean el mismo.
# `is_email` decide que columna se compara: asi no hacen falta centinelas.
def _contact_params(raw: str) -> dict:
    s = raw.strip().lower()
    if "@" in s:
        return {"is_email": True, "email": s, "phone": ""}
    return {"is_email": False, "email": "", "phone": digits_only(s)}


# Los telefonos se comparan por sus ULTIMOS 10 digitos: el mismo numero guardado
# como "3001234567" (local) y como "+57 300 123 4567" (con indicativo) tiene que
# encontrar la misma boleta. Sin esto, quien escribe su numero como lo tiene
# agendado no encontraba nada y creia que la boleta no existia.
# Mismo criterio en un solo lugar: app.core.phone.
_PHONE_TAIL = phone_tail_sql("t.customer_phone")

# El correo tampoco distingue mayusculas: se guarda tal cual lo escribio quien
# emitio la boleta, asi que la comparacion normaliza el lado de la columna (el
# lado del parametro ya viene en minusculas desde _contact_params). Sin esto,
# una boleta emitida como "Fan@Bar.test" era invisible para quien buscaba
# "fan@bar.test" — el mismo caso que el telefono, pero sin cubrir.
_EMAIL_MATCH = "lower(t.customer_email) = %(email)s"


_FAN_TICKETS_SQL = f"""
    SELECT t.id            AS ticket_id,
           t.status::text  AS status,
           t.customer_name AS customer_name,
           t.customer_phone AS customer_phone,
           e.name          AS event_name,
           e.status        AS event_status,
           e.location      AS location,
           e.starts_at     AS starts_at,
           e.ends_at       AS ends_at,
           e.event_timezone AS event_timezone,
           e.qr_unlock_minutes AS qr_unlock_minutes,
           tt.is_virtual   AS is_virtual,
           e.stream_url    AS stream_url,
           e.stream_starts_at AS stream_starts_at,
           e.stream_ends_at AS stream_ends_at,
           e.stream_instructions AS stream_instructions,
           (SELECT count(*) FROM event_questions q
             WHERE q.event_id=e.id AND q.is_active)::int AS question_count,
           {public_venue_name_sql()} AS venue_name,
           (SELECT jsonb_build_object(
                       'id', n.id,
                       'kind', n.kind,
                       'title', n.title,
                       'message', n.message,
                       'created_at', n.created_at,
                       'affected_tickets', n.affected_tickets,
                       'affected_buyers', n.affected_buyers)
              FROM event_change_notices n
             WHERE n.event_id = e.id
             ORDER BY n.created_at DESC, n.id DESC
             LIMIT 1) AS change_notice
      FROM tickets t
      JOIN events e ON e.id = t.event_id
      JOIN ticket_types tt ON tt.id = t.ticket_type_id
      JOIN venues v ON v.id = e.venue_id
     WHERE (%(is_email)s AND {_EMAIL_MATCH})
        OR (NOT %(is_email)s AND {_PHONE_TAIL} = right(%(phone)s, 10))
     ORDER BY e.starts_at DESC
     LIMIT 100
"""


def _fan_starts_at_label(starts_at: datetime, tz_name: str | None) -> str:
    try:
        tz = ZoneInfo(tz_name) if tz_name else timezone.utc
    except Exception:
        tz = timezone.utc
    return starts_at.astimezone(tz).strftime("%d/%m/%Y %H:%M")


def _fan_ticket_row(r: dict) -> dict:
    """Fila de DB -> FanTicketOut. `has_link`: se puede regenerar el QR."""
    live = r["status"] == "issued" and r["event_status"] not in ("ended", "cancelled")
    qr_active, qr_message = _qr_window(r)
    stream_active, stream_message, _, _ = _stream_window(r)
    return {
        "ticket_id": r["ticket_id"],
        "event_name": r["event_name"],
        "venue_name": r["venue_name"],
        "location": r["location"],
        "starts_at": _fan_starts_at_label(r["starts_at"], r["event_timezone"]),
        "status": r["status"],
        "has_link": live,
        "qr_active": qr_active,
        "qr_message": qr_message,
        "customer_name": r.get("customer_name"),
        "customer_phone": r.get("customer_phone"),
        "has_questions": bool(r.get("question_count")),
        "is_virtual": bool(r.get("is_virtual")),
        "stream_active": stream_active,
        "stream_message": stream_message,
        "change_notice": r.get("change_notice"),
    }


@router.post("/my-tickets")
async def fan_my_tickets(
    body: FanLookupRequest,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Pide el enlace de acceso del fan (respuesta SIEMPRE generica).

    El contacto solo pide el enlace: no devuelve boletas. Si el contacto tiene
    boletas Y hay canal de entrega (correo), se envia un enlace firmado de vida
    corta; si no, la respuesta es la misma. Asi el endpoint no sirve para
    enumerar quien tiene boletas ni para leer las de nadie.
    """
    key = _contact_params(body.contact)
    async with db.cursor() as cur:
        await cur.execute(_FAN_TICKETS_SQL, key)
        rows = await cur.fetchall()

    settings = get_settings()
    mailer = Mailer(
        api_key=settings.resend_api_key,
        from_email=settings.email_from_address,
        from_name="Enty",
        app_url=settings.app_public_url,
    )

    # Solo se envia si hay boletas y el contacto es un correo (el enlace viaja
    # por correo; con un telefono no hay a donde mandarlo — el fan lo pide al
    # organizador, que lo reemite desde el panel).
    if rows and key["is_email"] and mailer.enabled:
        token = create_fan_access_token(key["email"])
        await run_in_threadpool(
            mailer.send_fan_access,
            to=key["email"],
            tickets=[
                {"event_name": r["event_name"], "venue_name": r["venue_name"]}
                for r in rows
            ],
            link=f"{settings.app_public_url}/boletas?acceso={token}",
        )

    # El texto no depende de si habia boletas (anti-enumeracion) ni de si el
    # correo se pudo enviar.
    return {
        "detail": (
            "Si ese contacto tiene boletas, te enviamos un enlace para verlas. "
            "Revisa también tu correo no deseado. Si no llega, pídeselo al "
            "organizador del evento."
        ),
        "email_configured": mailer.enabled and key["is_email"],
    }


@router.post("/my-tickets/access", response_model=FanTicketsOut)
async def fan_tickets_with_access(
    body: FanCredentialRequest,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Lista las boletas del dueno acreditado (enlace firmado o posesion).

    La credencial manda: sin firma valida ni token de boleta, 401 uniforme (no
    se distingue "vencido" de "inventado"). El contacto sale DE LA CREDENCIAL,
    nunca del cuerpo: asi una credencial legitima no puede apuntar a otro.
    """
    contact = await _resolve_contact(db, body)
    if not contact:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "El enlace venció o no es válido. Pide uno nuevo.",
        )

    key = _contact_params(contact)
    async with db.cursor() as cur:
        await cur.execute(_FAN_TICKETS_SQL, key)
        rows = await cur.fetchall()

    return {
        "contact": contact,
        "count": len(rows),
        "tickets": [_fan_ticket_row(r) for r in rows],
    }


@router.post("/my-tickets/{ticket_id}/token", response_model=FanTicketTokenOut)
async def fan_ticket_token(
    ticket_id: int,
    body: FanCredentialRequest,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Regenera el enlace (QR) de UNA boleta, con una credencial valida.

    Misma credencial que la lista (enlace firmado o posesion de otra boleta del
    mismo dueno); ninguna es "conozco el correo". La DB rota el token con
    `reissue_ticket` (auditado).
    """
    contact = await _resolve_contact(db, body)
    if not contact:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "El enlace venció o no es válido. Pide uno nuevo.",
        )

    key = _contact_params(contact)
    async with db.cursor() as cur:
        await cur.execute(
            f"""
            SELECT t.id
              FROM tickets t
             WHERE t.id = %(ticket_id)s
               AND ((%(is_email)s AND {_EMAIL_MATCH})
                    OR (NOT %(is_email)s AND {_PHONE_TAIL} = right(%(phone)s, 10)))
            """,
            {"ticket_id": ticket_id, **key},
        )
        if not await cur.fetchone():
            # Mismo mensaje que una boleta inexistente: no revelamos si existe.
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Boleta no encontrada")

        raw_token = secrets.token_urlsafe(24)
        try:
            await cur.execute(
                "SELECT reissue_ticket(%s, %s, %s, %s)",
                (ticket_id, raw_token, None, "fan_self_service"),
            )
        except psycopg.errors.Error as e:
            raise _fan_reissue_error(e)

    return {"ticket_id": ticket_id, "raw_token": raw_token}


async def _resolve_contact(
    db: psycopg.AsyncConnection, body: FanCredentialRequest
) -> str | None:
    """Contacto acreditado por la credencial, o None si no acredita nada.

    Acepta el enlace firmado (`token`) o la posesion del token crudo de una
    boleta (`raw_token`). En el segundo caso devuelve el contacto ya
    normalizado (correo o digitos) del dueno de esa boleta. Cualquier valor que
    no acredite da None — y el llamador responde 401 uniforme.
    """
    if body.token:
        return verify_fan_access_token(body.token)
    if not body.raw_token:
        return None
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT t.customer_email, t.customer_phone
              FROM tickets t
             WHERE t.token_hash = encode(digest(%s, 'sha256'), 'hex')
            """,
            (body.raw_token,),
        )
        row = await cur.fetchone()
    if not row:
        return None
    if row["customer_email"]:
        return row["customer_email"].strip().lower()
    phone = digits_only(row["customer_phone"])
    return phone or None


def _fan_reissue_error(e: psycopg.errors.Error) -> HTTPException:
    """Errores de reissue_ticket a HTTP legible para el fan."""
    primary = str(e)
    diag = getattr(e, "diag", None)
    if diag is not None and getattr(diag, "message_primary", ""):
        primary = diag.message_primary
    if "cannot_reissue_redeemed" in primary:
        return HTTPException(status.HTTP_409_CONFLICT, "Esta boleta ya fue usada")
    if "event_closed" in primary:
        return HTTPException(status.HTTP_409_CONFLICT, "El evento ya cerró")
    if "cannot_reissue_ticket" in primary or "ticket_not_found" in primary:
        return HTTPException(status.HTTP_409_CONFLICT, "Esta boleta ya no se puede usar")
    return HTTPException(status.HTTP_400_BAD_REQUEST, "No pudimos generar el enlace")


@router.get(
    "/tickets/{raw_token}/image.jpg",
    response_class=Response,
    responses={200: {"content": {"image/jpeg": {}}, "description": "Boleta con QR"}},
)
async def public_ticket_image(
    raw_token: str,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            f"""
            SELECT t.id AS ticket_number, t.customer_name, t.status,
                   e.name AS event_name, e.location, e.starts_at, e.event_timezone,
                   e.qr_unlock_minutes, {public_venue_name_sql()} AS venue_name
            FROM tickets t
            JOIN events e ON e.id = t.event_id
            JOIN venues v ON v.id = e.venue_id

            WHERE t.token_hash = encode(digest(%s, 'sha256'), 'hex')
            """,
            (raw_token,),
        )
        row = await cur.fetchone()

    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Boleta no encontrada")
    if row["status"] in ("voided", "refunded"):
        # El link sigue circulando por WhatsApp: mejor un 410 explícito que
        # mostrar un QR que la puerta ya va a rechazar.
        raise HTTPException(status.HTTP_410_GONE, "Boleta anulada")
    qr_active, _qr_msg = _qr_window(row)
    if not qr_active:
        # La imagen lleva el QR dentro: fuera de la ventana, 403 con el
        # motivo (WhatsApp no tendrá og:image, a propósito).
        raise HTTPException(status.HTTP_403_FORBIDDEN, "El QR aún no está activo")

    # Pillow + QR son CPU-bound: al threadpool para no bloquear el event loop.
    image = await run_in_threadpool(
        build_ticket_image,
        ticket_number=row["ticket_number"],
        customer_name=row["customer_name"],
        event_name=row["event_name"],
        starts_at=_starts_at_label(row["starts_at"], row["event_timezone"]),
        raw_token=raw_token,
        venue_name=row["venue_name"],
        location=row["location"],
    )
    return Response(content=image, media_type="image/jpeg", headers=_IMAGE_HEADERS)


_STATUS_TEXT = {
    "issued": ("Boleta activa", "#34d399"),
    "redeemed": ("Boleta ya ingresada", "#fbbf24"),
    "voided": ("Boleta anulada", "#f87171"),
    "refunded": ("Boleta reembolsada", "#f87171"),
}


# --- Vista previa al compartir un evento ----------------------------------
#
# El catalogo es una SPA: `/evento/12` es HTML estatico sin datos, asi que
# WhatsApp (el canal principal de este producto) mostraba un link pelado. No
# se puede resolver con metadatos estaticos ni con JS: el crawler no ejecuta
# JS. Vercel reescribe SOLO las peticiones con User-Agent de crawler a esta
# ruta (ver vercel.json); las personas siguen recibiendo la app. Aqui se
# responde la tarjeta del evento: nombre, fecha, lugar y precio. Sin datos
# personales: es informacion que ya es publica en la vitrina.

_DEFAULT_SHARE_IMAGE = "/og-cover.png"


def _absolute_url(base: str, path_or_url: str | None) -> str:
    """Absoluta siempre: los crawlers no resuelven rutas relativas."""
    if not path_or_url:
        return f"{base}{_DEFAULT_SHARE_IMAGE}"
    if path_or_url.startswith(("http://", "https://")):
        return path_or_url
    return f"{base}{path_or_url if path_or_url.startswith('/') else '/' + path_or_url}"


def _share_event_html(
    *,
    base_url: str,
    event_id: int,
    name: str,
    starts_at: datetime,
    tz_name: str | None,
    venue: str | None,
    location: str | None,
    flyer_url: str | None,
    min_price: int | None,
    description: str | None = None,
    ends_at: datetime | None = None,
    sold_out: bool = False,
    lineup: list[str] | None = None,
    has_stream: bool = False,
) -> str:
    """HTML de la tarjeta social. Puro: sin DB, para poder probarlo aislado."""
    url = f"{base_url}/evento/{event_id}"
    image = _absolute_url(base_url, flyer_url)
    when = _starts_at_label(starts_at, tz_name)
    where = " · ".join(p for p in (venue, location) if p)
    fallback = f"{when} · {where}"
    clean_desc = (description or "").strip()
    desc = clean_desc or fallback
    meta_desc = desc if len(desc) <= 160 else f"{desc[:157].rstrip()}..."

    schema: dict = {
        "@context": "https://schema.org",
        "@type": "Event",
        "name": name,
        "description": desc,
        "startDate": starts_at.isoformat(),
        "eventStatus": "https://schema.org/EventScheduled",
        # Un espacio sin identidad pública no aporta nombre; el lugar genérico
        # mantiene el JSON-LD válido sin revelar "Mi organización".
        "location": {"@type": "Place", "name": venue or location or "Lugar por confirmar"},
        "image": [image],
        "url": url,
    }
    if ends_at is not None:
        schema["endDate"] = ends_at.isoformat()
    if venue:
        schema["organizer"] = {"@type": "Organization", "name": venue}
    if lineup:
        schema["performer"] = [{"@type": "PerformingGroup", "name": n} for n in lineup]
    if has_stream:
        schema["eventAttendanceMode"] = (
            "https://schema.org/MixedEventAttendanceMode"
        )
    if location:
        schema["location"]["address"] = location
    if min_price is not None:
        schema["offers"] = {
            "@type": "Offer",
            "price": f"{min_price / 100:.2f}",
            "priceCurrency": "COP",
            "url": url,
            "availability": (
                "https://schema.org/SoldOut" if sold_out else "https://schema.org/InStock"
            ),
        }
    # Todo `<` se escribe como `\u003c`: ni `</script>` ni `<script>` de un
    # nombre malicioso pueden escapar del bloque. Sigue siendo JSON valido.
    ld = json.dumps(schema, ensure_ascii=False).replace("<", "\\u003c")

    title = escape(name)
    return f"""<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{title} — Enty</title>
    <meta name="description" content="{escape(meta_desc)}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="{escape(url)}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Enty" />
    <meta property="og:locale" content="es_CO" />
    <meta property="og:title" content="{title}" />
    <meta property="og:description" content="{escape(desc)}" />
    <meta property="og:url" content="{escape(url)}" />
    <meta property="og:image" content="{escape(image)}" />
    <meta property="og:image:alt" content="{title} — boletas en Enty" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="{title}" />
    <meta name="twitter:description" content="{escape(desc)}" />
    <meta name="twitter:image" content="{escape(image)}" />
    <script type="application/ld+json">{ld}</script>
  </head>
  <body>
    <p><a href="{escape(url)}">{title}</a></p>
    <p>{escape(desc)}</p>
  </body>
</html>
"""


@router.get(
    "/share/evento/{event_id}",
    response_class=HTMLResponse,
    include_in_schema=False,
    responses={200: {"content": {"text/html": {}}, "description": "Tarjeta del evento"}},
)
async def public_event_share_page(
    event_id: int,
    request: Annotated[None, Depends(_rate_limit)],
    settings=Depends(get_settings),
    db=Depends(get_db),
):
    """Tarjeta social de un evento (la consumen los crawlers via rewrite).

    Solo eventos con venta abierta: un borrador no debe filtrarse por un link
    compartido. Cacheable 5 minutos: el nombre o la fecha pueden cambiar.
    """
    async with db.cursor() as cur:
        await cur.execute(
            f"""
            SELECT e.name, e.description, e.flyer_url, e.location, e.starts_at,
                   e.ends_at, e.capacity, e.event_timezone,
                   to_jsonb(e) ->> 'stream_url' AS stream_url,
                   {public_venue_name_sql()} AS venue_name,
                   (SELECT min(tt.price_cents) FROM ticket_types tt
                     WHERE tt.event_id = e.id AND tt.is_active
                       AND NOT tt.is_pass_only
                       AND NOT tt.is_courtesy AND tt.price_cents > 0) AS min_price,
                   (SELECT count(*) FROM tickets t
                     WHERE t.event_id = e.id
                       AND t.status IN ('issued', 'redeemed'))::int AS active,
                   (SELECT coalesce(json_agg(l.name ORDER BY l.sort_order, l.id), '[]'::json)
                      FROM event_lineup l WHERE l.event_id = e.id) AS lineup
            FROM events e
            JOIN venues v ON v.id = e.venue_id
            WHERE e.id = %s AND e.status IN ('published', 'live')
            """,
            (event_id,),
        )
        row = await cur.fetchone()

    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Evento no encontrado")

    html = _share_event_html(
        base_url=settings.app_public_url.rstrip("/"),
        event_id=event_id,
        name=row["name"],
        starts_at=row["starts_at"],
        tz_name=row["event_timezone"],
        venue=row["venue_name"],
        location=row["location"],
        flyer_url=row["flyer_url"],
        min_price=row["min_price"],
        description=row["description"],
        ends_at=row["ends_at"],
        sold_out=bool(row["capacity"]) and row["active"] >= row["capacity"],
        lineup=list(row["lineup"] or []),
        has_stream=bool(row["stream_url"]),
    )
    return HTMLResponse(
        content=html,
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.get(
    "/tickets/{raw_token}",
    responses={200: {"content": {"text/html": {}}, "description": "Página de la boleta"}},
)
async def public_ticket_page(
    raw_token: str,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Página HTML de la boleta: lo que el cliente abre y puede reenviar.

    Ventajas sobre enviar solo la imagen: el link se puede reenviar sin que se
    pierda calidad, WhatsApp/Teléfono generan vista previa (og:image apunta a
    la imagen con QR) y el estado se consulta en vivo (una boleta anulada se
    ve como tal aquí aunque el QR siga circulando).
    """
    async with db.cursor() as cur:
        await cur.execute(
            f"""
            SELECT t.id AS ticket_number, t.customer_name, t.status,
                   e.name AS event_name, e.location, e.starts_at, e.ends_at,
                   e.event_timezone, e.qr_unlock_minutes,
                   tt.is_virtual, e.stream_url, e.stream_starts_at,
                   e.stream_ends_at, e.stream_instructions,
                   {public_venue_name_sql()} AS venue_name,
                   (SELECT n.title || ' — ' || n.message
                      FROM event_change_notices n
                     WHERE n.event_id = e.id
                     ORDER BY n.created_at DESC, n.id DESC
                     LIMIT 1) AS change_notice
            FROM tickets t
            JOIN events e ON e.id = t.event_id
            JOIN ticket_types tt ON tt.id = t.ticket_type_id
            JOIN venues v ON v.id = e.venue_id
            WHERE t.token_hash = encode(digest(%s, 'sha256'), 'hex')
            """,
            (raw_token,),
        )
        row = await cur.fetchone()

    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Boleta no encontrada")

    image_url = f"/api/public/tickets/{raw_token}/image.jpg"
    # La boleta virtual no tiene QR: su vista previa usa la portada de marca,
    # no una imagen de puerta que no existe para este tipo.
    share_image = "/og-cover.png" if row["is_virtual"] else image_url
    # El lugar, si existe, va en la descripción de WhatsApp y en la página.
    where_line = f" · {row['location']}" if row["location"] else ""
    status_text, status_color = _STATUS_TEXT.get(row["status"], (row["status"], "#9ca3af"))
    qr_active, qr_msg = _qr_window(row)
    if row["status"] in ("voided", "refunded"):
        # El QR ya no sirve; la página lo dice claro en vez de mostrar imagen.
        body = f"""
        <div class='box'><p class='bad'>{escape(status_text)}</p>
        <p>Esta boleta fue anulada por el organizador y no permite el ingreso.</p></div>"""
    elif row["is_virtual"]:
        # Boleta virtual (mig 075): no hay QR de puerta. El enlace se entrega
        # solo dentro de la ventana contratada; fuera de ella se explica cuándo
        # vuelve a abrir, sin filtrar la URL.
        stream_active, stream_msg, _, _ = _stream_window(row)
        if stream_active:
            instructions = (
                f"<p class='hint'>{escape(row['stream_instructions'])}</p>"
                if row.get("stream_instructions")
                else ""
            )
            body = f"""
            <div class='box'><p class='ok'>Boleta virtual activa</p>
            <p>Tu transmisión está abierta.</p>{instructions}
            <p><a class='stream' href='{escape(row['stream_url'])}'>Ver transmisión</a></p>
            <p class='hint'>Guarda este enlace: si se corta, vuelve aquí y ábrelo de nuevo.</p></div>"""
        else:
            body = f"""
            <div class='box'><p class='ok'>Boleta virtual</p>
            <p class='hint'>{escape(stream_msg or "")}</p>
            <p class='hint'>Vuelve a este enlace durante el horario de la transmisión.</p></div>"""
    elif not qr_active:
        # Mig 013: el enlace sigue sirviendo (quien lo recibió no queda
        # fuera), pero el QR no se dibuja fuera de la ventana. La imagen no
        # se referencia: tampoco se compone por fuera de la ventana.
        body = f"""
        <div class='box'><p class='ok'>{escape(status_text)}</p>
        <p class='hint'>{escape(qr_msg or "")}</p>
        <p class='hint'>Vuelve a este enlace cuando se active tu QR.</p></div>"""
    else:
        where_html = (
            f"<p class='where'>{escape(row['location'])}</p>"
            if row["location"]
            else ""
        )
        body = f"""
        <div class='box'><img src='{escape(image_url)}' alt='Boleta con QR' class='ticket'/>
        <p class='ok'>{escape(status_text)}</p>{where_html}
        <p class='hint'>Presenta este QR en la puerta junto con tu documento.</p></div>"""

    notice_html = (
        f"<div class='box notice'><p class='notice-title'>Aviso del organizador</p>"
        f"<p>{escape(row['change_notice'])}</p></div>"
        if row.get("change_notice")
        else ""
    )

    title = f"Boleta #{row['ticket_number']} · {row['event_name']}"
    # escape() en TODA interpolacion que llega de la DB (nombre del evento,
    # lugar, cliente): sin el, un evento llamado "<script>" o un lugar con
    # comilla ejecuta HTML en el telefono del invitado (stored XSS publico).
    html = f"""<!doctype html>
<html lang='es'><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<meta name='robots' content='noindex, nofollow'>
<meta property='og:title' content='{escape(title)}'>
<meta property='og:description' content='{escape(row["customer_name"])} · {escape(status_text)}{escape(where_line)}'>
<meta property='og:image' content='{escape(share_image)}'>
<title>{escape(title)}</title>
<style>
  body {{ margin:0; min-height:100vh; display:grid; place-items:center;
         background:#09090b; color:#e4e4e7; font-family:system-ui,sans-serif; }}
  .box {{ max-width:520px; padding:24px; text-align:center; }}
  .ticket {{ width:100%; border-radius:14px; display:block; }}
  .ok {{ color:#34d399; font-weight:600; margin:14px 0 4px; }}
  .bad {{ color:#f87171; font-weight:700; font-size:1.2em; margin-bottom:6px; }}
  .hint {{ color:#a1a1aa; font-size:.9em; }}
  .where {{ color:#e4e4e7; font-weight:600; font-size:.95em; margin:4px 0 0; }}
  .where::before {{ content:'📍 '; }}
  .stream {{ display:inline-block; margin-top:14px; padding:12px 18px;
            border-radius:10px; background:#7c3aed; color:#fff;
            font-weight:700; text-decoration:none; }}
  .notice {{ border:1px solid #f59e0b; border-radius:12px; padding:14px;
            margin-bottom:16px; color:#fbbf24; text-align:left; }}
  .notice p {{ margin:6px 0 0; color:#e4e4e7; font-size:.92em; }}
  .notice-title {{ margin:0; font-weight:700; }}
</style></head><body>{notice_html}{body}</body></html>"""
    return Response(content=html, media_type="text/html; charset=utf-8", headers=_IMAGE_HEADERS)


# --- Autoservicio del comprador (mig 075) ---------------------------------
#
# Todo pasa por la misma credencial que abre Mis boletas. El contacto del
# cuerpo nunca es la identidad: se resuelve desde el enlace firmado o desde la
# posesión de otra boleta del mismo dueño.

async def _fan_ticket_for_contact(cur, ticket_id: int, contact: str) -> dict | None:
    key = _contact_params(contact)
    await cur.execute(
        f"""
        SELECT t.id, t.customer_name, t.customer_phone, t.customer_email,
               t.status::text AS status, e.status AS event_status,
               e.starts_at, e.ends_at, e.event_timezone,
               e.stream_url, e.stream_starts_at, e.stream_ends_at,
               e.stream_instructions, tt.is_virtual
          FROM tickets t
          JOIN events e ON e.id = t.event_id
          JOIN ticket_types tt ON tt.id = t.ticket_type_id
         WHERE t.id = %(ticket_id)s
           AND ((%(is_email)s AND {_EMAIL_MATCH})
                OR (NOT %(is_email)s AND {_PHONE_TAIL} = right(%(phone)s, 10)))
        """,
        {"ticket_id": ticket_id, **key},
    )
    return await cur.fetchone()


def _contact_matches_ticket(value: str, ticket: dict) -> bool:
    """¿El contacto escrito coincide con el que tiene la boleta?"""
    raw = (value or "").strip()
    if not raw:
        return False
    if "@" in raw:
        return bool(ticket.get("customer_email")) and (
            raw.lower() == ticket["customer_email"].strip().lower()
        )
    current = digits_only(ticket.get("customer_phone") or "")
    return bool(current) and digits_only(raw)[-10:] == current[-10:]


@router.post("/my-tickets/{ticket_id}/questions", response_model=FanQuestionsOut)
async def fan_ticket_questions(
    ticket_id: int,
    body: FanCredentialRequest,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Preguntas que el organizador hace después de comprar (mig 075)."""
    contact = await _resolve_contact(db, body)
    if not contact:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "El enlace venció o no es válido. Pide uno nuevo.",
        )

    async with db.cursor() as cur:
        ticket = await _fan_ticket_for_contact(cur, ticket_id, contact)
        if not ticket:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Boleta no encontrada")

        await cur.execute(
            """
            SELECT q.id, q.event_id, q.prompt, q.help_text, q.kind,
                   q.options, q.required, q.sort_order, q.closes_at,
                   q.is_active, a.answer
              FROM event_questions q
              LEFT JOIN ticket_answers a
                     ON a.question_id = q.id AND a.ticket_id = %s
             WHERE q.event_id = (SELECT event_id FROM tickets WHERE id = %s)
               AND q.is_active
             ORDER BY q.sort_order, q.id
            """,
            (ticket_id, ticket_id),
        )
        rows = await cur.fetchall()

    ticket_usable = ticket["status"] in ("issued", "redeemed")
    event_open = ticket["event_status"] not in ("ended", "cancelled")
    now = datetime.now(timezone.utc)
    questions = []
    for row in rows:
        closes_at = row["closes_at"]
        deadline_open = closes_at is None or now <= closes_at
        if not event_open:
            reason = "El evento ya terminó."
        elif not ticket_usable:
            reason = "Esta boleta ya no permite respuestas."
        elif not deadline_open:
            reason = "El plazo para responder terminó."
        else:
            reason = None
        questions.append(
            FanQuestionOut(
                **{k: row[k] for k in (
                    "id", "event_id", "prompt", "help_text", "kind", "options",
                    "required", "sort_order", "closes_at", "is_active",
                )},
                answer=row["answer"],
                can_answer=reason is None,
                closed_reason=reason,
            )
        )
    return FanQuestionsOut(ticket_id=ticket_id, questions=questions)


def _validate_answer(question: dict, answer):
    kind = question["kind"]
    if kind in ("text", "textarea"):
        if not isinstance(answer, str) or not answer.strip():
            raise HTTPException(422, "Escribe una respuesta")
        if len(answer) > 1000:
            raise HTTPException(422, "La respuesta es demasiado larga")
        return answer.strip()
    if kind == "select":
        options = question.get("options") or []
        if answer not in options:
            raise HTTPException(422, "Elige una de las opciones")
        return answer
    if kind == "number":
        if isinstance(answer, bool) or not isinstance(answer, (int, float)):
            raise HTTPException(422, "Escribe un número")
        return answer
    if kind == "boolean":
        if not isinstance(answer, bool):
            raise HTTPException(422, "Elige sí o no")
        return answer
    raise HTTPException(422, "Tipo de pregunta no válido")


@router.put("/my-tickets/{ticket_id}/questions/{question_id}")
async def fan_answer_question(
    ticket_id: int,
    question_id: int,
    body: FanAnswerIn,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Guarda o actualiza una respuesta hasta la fecha límite (mig 075)."""
    contact = await _resolve_contact(
        db, FanCredentialRequest(token=body.token, raw_token=body.raw_token)
    )
    if not contact:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "El enlace venció o no es válido. Pide uno nuevo.",
        )

    async with db.cursor() as cur:
        ticket = await _fan_ticket_for_contact(cur, ticket_id, contact)
        if not ticket:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Boleta no encontrada")
        if ticket["status"] not in ("issued", "redeemed"):
            raise HTTPException(409, "Esta boleta ya no permite respuestas")
        if ticket["event_status"] in ("ended", "cancelled"):
            raise HTTPException(409, "El evento ya terminó")

        await cur.execute(
            """
            SELECT q.*
              FROM event_questions q
             WHERE q.id = %s
               AND q.event_id = (SELECT event_id FROM tickets WHERE id = %s)
               AND q.is_active
            """,
            (question_id, ticket_id),
        )
        question = await cur.fetchone()
        if not question:
            raise HTTPException(404, "Pregunta no encontrada")
        if question["closes_at"] is not None and datetime.now(timezone.utc) > question["closes_at"]:
            raise HTTPException(409, "El plazo para responder terminó")

        answer = _validate_answer(question, body.answer)
        await cur.execute(
            """
            INSERT INTO ticket_answers
                (question_id, ticket_id, answer, answered_by_contact)
            VALUES (%s, %s, %s::jsonb, %s)
            ON CONFLICT (question_id, ticket_id) DO UPDATE
               SET answer = EXCLUDED.answer,
                   answered_by_contact = EXCLUDED.answered_by_contact,
                   updated_at = now()
            RETURNING answer, updated_at
            """,
            (question_id, ticket_id, Jsonb(answer), contact),
        )
        saved = await cur.fetchone()
        await db.commit()
    return {
        "question_id": question_id,
        "answer": saved["answer"],
        "updated_at": saved["updated_at"],
    }


@router.post("/my-tickets/{ticket_id}/stream", response_model=FanStreamOut)
async def fan_ticket_stream(
    ticket_id: int,
    body: FanCredentialRequest,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Enlace de la transmisión, solo para una boleta virtual y en su ventana."""
    contact = await _resolve_contact(db, body)
    if not contact:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "El enlace venció o no es válido. Pide uno nuevo.",
        )

    async with db.cursor() as cur:
        ticket = await _fan_ticket_for_contact(cur, ticket_id, contact)
    if not ticket:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Boleta no encontrada")
    if not ticket["is_virtual"]:
        raise HTTPException(409, "Esta boleta no incluye transmisión")
    if ticket["status"] in ("voided", "refunded"):
        raise HTTPException(409, "Esta boleta ya no está vigente")

    active, message, starts_at, ends_at = _stream_window(ticket)
    return FanStreamOut(
        ticket_id=ticket_id,
        active=active,
        url=ticket["stream_url"] if active else None,
        starts_at=starts_at,
        ends_at=ends_at,
        instructions=ticket["stream_instructions"] if active else None,
        message=message or "",
    )


@router.post(
    "/my-tickets/{ticket_id}/contact",
    response_model=FanContactCorrectionOut,
)
async def fan_correct_contact(
    ticket_id: int,
    body: FanContactCorrectionIn,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Corrección de nombre/teléfono por el comprador, sin reemitir el QR.

    La credencial de Mis boletas identifica al dueño. Si además cambia el
    teléfono, se exige el contacto actual como segundo factor: quien solo
    tenga un enlace reenviado no puede redirigir los avisos a otro número.
    """
    contact = await _resolve_contact(
        db, FanCredentialRequest(token=body.token, raw_token=body.raw_token)
    )
    if not contact:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "El enlace venció o no es válido. Pide uno nuevo.",
        )
    new_name = (body.customer_name or "").strip() or None
    new_phone = (body.customer_phone or "").strip() or None
    if new_name is None and new_phone is None:
        raise HTTPException(422, "Indica qué dato quieres corregir")

    async with db.cursor() as cur:
        ticket = await _fan_ticket_for_contact(cur, ticket_id, contact)
        if not ticket:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Boleta no encontrada")
        if ticket["status"] != "issued":
            raise HTTPException(409, "Esta boleta ya no se puede corregir")
        if ticket["event_status"] in ("ended", "cancelled"):
            raise HTTPException(409, "El evento ya terminó")

        verification = "Credencial de la boleta"
        if new_phone is not None:
            if not _contact_matches_ticket(body.current_contact or "", ticket):
                raise HTTPException(
                    403,
                    "Para cambiar el teléfono confirma el correo o teléfono "
                    "actual de la boleta.",
                )
            verification += " + contacto actual confirmado"

        try:
            await cur.execute(
                "SELECT correct_ticket_contact(%s, %s, %s, %s, %s)",
                (
                    ticket_id,
                    new_name,
                    new_phone,
                    None,
                    body.reason or "Autocorrección desde Mis boletas",
                ),
            )
            await db.commit()
        except psycopg.errors.Error as e:
            primary = str(e)
            diag = getattr(e, "diag", None)
            if diag is not None and getattr(diag, "message_primary", ""):
                primary = diag.message_primary
            if "invalid_phone" in primary or "invalid_name" in primary:
                raise HTTPException(422, "Revisa el dato que quieres corregir")
            if "event_closed" in primary:
                raise HTTPException(409, "El evento ya terminó")
            if "cannot_edit_ticket_status" in primary:
                raise HTTPException(409, "Esta boleta ya no se puede corregir")
            raise HTTPException(400, "No pudimos corregir tus datos")

        await cur.execute(
            "SELECT customer_name, customer_phone FROM tickets WHERE id=%s",
            (ticket_id,),
        )
        updated = await cur.fetchone()

    changed = []
    if new_name is not None and new_name != ticket["customer_name"]:
        changed.append("nombre")
    if new_phone is not None and new_phone != ticket["customer_phone"]:
        changed.append("teléfono")
    return FanContactCorrectionOut(
        ticket_id=ticket_id,
        customer_name=updated["customer_name"],
        customer_phone=updated["customer_phone"],
        changed=changed,
        verification=verification,
        message=(
            "Datos corregidos. La boleta y el QR siguen siendo los mismos."
            if changed
            else "Los datos ya coincidían con lo que escribiste."
        ),
    )
