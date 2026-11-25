"""Avisos de cambio de evento para compradores que ya tienen boleta.

El aviso se guarda con el texto ya armado y el impacto en compras. La app lo
muestra en Mis boletas y en la página pública de la boleta; el panel puede
copiarlo para enviarlo por el canal que el organizador tenga configurado.
"""
from datetime import date, datetime
from json import dumps
from zoneinfo import ZoneInfo

# Campos que cambian lo que el comprador necesita saber para asistir.
MATERIAL_FIELDS = {
    "name": "Nombre del evento",
    "starts_at": "Fecha y hora",
    "ends_at": "Fin del evento",
    "location": "Lugar",
    "location_url": "Enlace del lugar",
    "doors_open_at": "Apertura de puertas",
    "dress_code": "Código de vestimenta",
    "min_age": "Edad mínima",
    "description": "Descripción",
    "contact_name": "Contacto",
    "contact_phone": "Teléfono de contacto",
}


def _jsonable(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _fmt(value, tz_name: str | None) -> str:
    if value in (None, ""):
        return "sin dato"
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value
    if isinstance(value, datetime):
        try:
            tz = ZoneInfo(tz_name) if tz_name else ZoneInfo("UTC")
        except Exception:
            tz = ZoneInfo("UTC")
        if value.tzinfo is None:
            value = value.replace(tzinfo=ZoneInfo("UTC"))
        return value.astimezone(tz).strftime("%d/%m/%Y %H:%M")
    return str(value)


def changed_fields(before: dict, after: dict) -> list[tuple[str, object, object]]:
    out = []
    for field, label in MATERIAL_FIELDS.items():
        old, new = before.get(field), after.get(field)
        if old != new:
            out.append((field, old, new))
    return out


def build_message(
    kind: str,
    changes: list[tuple[str, object, object]],
    tz_name: str | None,
) -> str:
    if kind == "cancelled":
        return (
            "El evento fue cancelado. No se permitirá el ingreso con esta "
            "boleta. Escríbele al organizador para gestionar el reembolso o "
            "un cambio."
        )

    lines = []
    for field, old, new in changes:
        label = MATERIAL_FIELDS.get(field, field)
        lines.append(f"{label}: antes {_fmt(old, tz_name)}, ahora {_fmt(new, tz_name)}.")

    return (
        " ".join(lines)
        + " Tu boleta sigue válida. Si el cambio te impide asistir, escríbele "
        "al organizador para revisar el reembolso o un cambio."
    ).strip()


async def record_event_change(
    cur,
    *,
    venue_id: int,
    event_id: int,
    user_id: int | None,
    kind: str,
    before: dict,
    after: dict,
) -> dict | None:
    """Crea el aviso si el cambio afecta a compradores. Devuelve el aviso o None."""
    changes = changed_fields(before, after)
    if kind != "cancelled" and not changes:
        return None

    await cur.execute(
        """
        SELECT count(*) FILTER (WHERE status IN ('issued', 'redeemed'))::int
                   AS tickets,
               count(DISTINCT lower(coalesce(nullif(customer_email, ''),
                                             customer_phone)))::int
                   AS buyers
          FROM tickets
         WHERE event_id = %s
        """,
        (event_id,),
    )
    impact = await cur.fetchone()
    if not impact or not impact["tickets"]:
        return None

    tz_name = after.get("event_timezone") or before.get("event_timezone")
    title = "Evento cancelado" if kind == "cancelled" else "El evento cambió"
    message = build_message(kind, changes, tz_name)
    old_values = {
        field: _jsonable(old) for field, old, _ in changes
    }
    new_values = {
        field: _jsonable(new) for field, _, new in changes
    }
    if kind == "cancelled":
        old_values["status"] = before.get("status")
        new_values["status"] = after.get("status")

    await cur.execute(
        """
        INSERT INTO event_change_notices
            (venue_id, event_id, kind, title, message, old_values, new_values,
             affected_tickets, affected_buyers, created_by)
        VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s)
        RETURNING id, kind, title, message, created_at,
                  affected_tickets, affected_buyers
        """,
        (
            venue_id,
            event_id,
            kind,
            title,
            message,
            dumps(old_values, ensure_ascii=False),
            dumps(new_values, ensure_ascii=False),
            impact["tickets"],
            impact["buyers"],
            user_id,
        ),
    )
    return await cur.fetchone()
