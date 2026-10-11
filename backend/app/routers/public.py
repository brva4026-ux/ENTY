"""Entrega pública de la boleta: el link que el promotor envía por WhatsApp.

Sin autenticación a propósito. El token crudo del QR **es** el secreto: 32 bytes
de entropía, generados con `secrets.token_urlsafe`, y en la DB solo vive su
SHA-256. Quien tiene el link, tiene la boleta — que es exactamente lo que se
busca al entregarla. Por eso el nombre del asistente va impreso en la imagen y
el bouncer lo compara en la puerta (ver docs/arquitectura/03-seguridad.md).
"""
from html import escape
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Annotated
from zoneinfo import ZoneInfo

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from starlette.concurrency import run_in_threadpool

from app.core.db import get_db
from app.schemas import FanLookupRequest, FanTicketTokenOut
from app.services.ticket_image import build_ticket_image

router = APIRouter(prefix="/public", tags=["publico"])

# Rate limit en memoria por IP (best-effort, por proceso). En la práctica esto
# frena scrapers y fuerza bruta de tokens; detrás de Vercel el número de
# instancias es pequeño y el costo de Redis no está justificado todavía.
_RATE_LIMIT = 120  # peticiones por minuto por IP
_RATE_WINDOW = 60.0
_rate_bucket: dict[str, list[float]] = {}


def _rate_key(request: Request) -> str:
    # Detras de Vercel (y de cualquier proxy) request.client.host es la edge,
    # no la persona: sin los headers de reenvio, TODOS los invitados compartian
    # un solo cubo de 120/min y la pagina de boleta devolvia 429 a todo el
    # mundo con unas decenas de usuarios concurrentes. Misma fuente que en
    # auth/public_tickets: x-real-ip del edge, luego el primer salto de
    # x-forwarded-for, y el peer de socket como ultimo recurso (dev directo).
    fwd = request.headers.get("x-forwarded-for", "")
    return (
        request.headers.get("x-real-ip")
        or (fwd.split(",")[0].strip() if fwd else "")
        or (request.client.host if request.client else "unknown")
    )


async def _rate_limit(request: Request) -> None:
    ip = _rate_key(request)
    now = time.monotonic()
    bucket = [t for t in _rate_bucket.get(ip, []) if now - t < _RATE_WINDOW]
    if len(bucket) >= _RATE_LIMIT:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Demasiadas peticiones")
    bucket.append(now)
    _rate_bucket[ip] = bucket

# Ni cachear ni indexar: el contenido cambia (la boleta puede anularse) y no
# queremos que un buscador archive los QRs de los clientes.
_IMAGE_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
}


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
# categoria ni precio en `events` (viven en `ticket_types`), asi que aqui se
# derivan: el precio es el minimo de las localidades pagas activas y la
# categoria se infiere del texto. Todo es best-effort: un evento sin
# localidades igual se muestra (precio null), nunca rompe el listado.

_CATEGORIES = ("Música", "Deportes", "Teatro")

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


def _category_of(name: str | None, description: str | None) -> str:
    """Categoria inferida del texto (mejor-esfuerzo, determinista)."""
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
        conds = ["e.status IN ('published', 'live')", "e.starts_at >= now()"]
        params: list = []
        if city and city.strip():
            conds.append("(coalesce(e.location, '') || ' ' || v.name) ILIKE %s")
            params.append(f"%{city.strip()}%")
        fetch_limit = limit if not category else min(200, limit * 4)
        params.append(fetch_limit)
        await cur.execute(
            f"""
            SELECT e.id, e.name, e.description, e.flyer_url, e.location,
                   e.starts_at, e.event_timezone, e.capacity, e.status,
                   v.name AS venue_name,
                   (SELECT min(tt.price_cents) FROM ticket_types tt
                     WHERE tt.event_id = e.id AND tt.is_active
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

    want_cat = (category or "").strip().lower()
    events: list[dict] = []
    for r in rows:
        cat = _category_of(r["name"], r["description"])
        if want_cat and want_cat != cat.lower():
            continue
        where = " · ".join(p for p in (r["location"], r["venue_name"]) if p)
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
    return {
        "city": top_city,
        "count": len(events),
        "categories": list(_CATEGORIES),
        "events": events,
    }


# --- App del fan: "mis boletas" (magic link) ------------------------------
#
# El fan no tiene cuenta: su correo o telefono ES la identidad con la que le
# emitieron las boletas. Pide el enlace con ese contacto, ve su lista y, para
# la boleta que quiera usar, regenera el QR (magic link). Sin sesion, igual
# que la boleta: el contacto es el unico dato y la respuesta nunca lo repite.

# Normalizacion del contacto. El correo solo se recorta y baja a minusculas
# (sus puntos son significativos: "a.b@x.com" no es "ab@x.com"). El telefono se
# reduce a digitos, para que "+57 300 123 4567" y "573001234567" sean el mismo.
# `is_email` decide que columna se compara: asi no hacen falta centinelas.
def _contact_params(raw: str) -> dict:
    s = raw.strip().lower()
    if "@" in s:
        return {"is_email": True, "email": s, "phone": ""}
    return {"is_email": False, "email": "", "phone": re.sub(r"\D", "", s)}


_FAN_TICKETS_SQL = """
    SELECT t.id            AS ticket_id,
           t.status::text  AS status,
           e.name          AS event_name,
           e.status        AS event_status,
           e.location      AS location,
           e.starts_at     AS starts_at,
           e.event_timezone AS event_timezone,
           e.qr_unlock_minutes AS qr_unlock_minutes,
           v.name          AS venue_name
      FROM tickets t
      JOIN events e ON e.id = t.event_id
      JOIN venues v ON v.id = e.venue_id
     WHERE (%(is_email)s AND t.customer_email = %(email)s)
        OR (NOT %(is_email)s
            AND regexp_replace(coalesce(t.customer_phone, ''), '[^0-9]', '', 'g') = %(phone)s)
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
    }


@router.post("/my-tickets")
async def fan_my_tickets(
    body: FanLookupRequest,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Boletas de un fan, buscadas por el contacto con que se emitieron.

    Sin sesion: el contacto (correo o telefono) es la identidad, igual que el
    token del QR es la credencial de una boleta. No se expone ningun token
    aqui; para ver el QR se pide `my-ticket-token`.
    """
    key = _contact_params(body.contact)
    async with db.cursor() as cur:
        await cur.execute(_FAN_TICKETS_SQL, key)
        rows = await cur.fetchall()

    tickets = [_fan_ticket_row(r) for r in rows]
    return {"contact": body.contact, "count": len(tickets), "tickets": tickets}


@router.post("/my-tickets/{ticket_id}/token", response_model=FanTicketTokenOut)
async def fan_ticket_token(
    ticket_id: int,
    body: FanLookupRequest,
    request: Annotated[None, Depends(_rate_limit)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Regenera el enlace (QR) de UNA boleta del fan que comprueba el contacto.

    Es el "magic link": el contacto identifica al dueno; la DB rota el token
    con `reissue_ticket` (auditado) y devuelve el token crudo una sola vez.
    """
    key = _contact_params(body.contact)
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT t.id
              FROM tickets t
             WHERE t.id = %s
               AND ((%s AND t.customer_email = %s)
                    OR (NOT %s
                        AND regexp_replace(coalesce(t.customer_phone, ''), '[^0-9]', '', 'g') = %s))
            """,
            (ticket_id, key["is_email"], key["email"], key["is_email"], key["phone"]),
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
            """
            SELECT t.id AS ticket_number, t.customer_name, t.status,
                   e.name AS event_name, e.location, e.starts_at, e.event_timezone,
                   e.qr_unlock_minutes, v.name AS venue_name
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
            """
            SELECT t.id AS ticket_number, t.customer_name, t.status,
                   e.name AS event_name, e.location, e.starts_at, e.event_timezone,
                   e.qr_unlock_minutes, v.name AS venue_name
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

    image_url = f"/api/public/tickets/{raw_token}/image.jpg"
    # El lugar, si existe, va en la descripción de WhatsApp y en la página.
    where_line = f" · {row['location']}" if row["location"] else ""
    status_text, status_color = _STATUS_TEXT.get(row["status"], (row["status"], "#9ca3af"))
    qr_active, qr_msg = _qr_window(row)
    if row["status"] in ("voided", "refunded"):
        # El QR ya no sirve; la página lo dice claro en vez de mostrar imagen.
        body = f"""
        <div class='box'><p class='bad'>{escape(status_text)}</p>
        <p>Esta boleta fue anulada por el organizador y no permite el ingreso.</p></div>"""
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
<meta property='og:image' content='{escape(image_url)}'>
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
</style></head><body>{body}</body></html>"""
    return Response(content=html, media_type="text/html; charset=utf-8", headers=_IMAGE_HEADERS)
