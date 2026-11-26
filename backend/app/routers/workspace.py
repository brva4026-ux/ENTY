"""Mudarse a Enty, operar en lote y salir ordenadamente (mig 073).

Incluye:
- importación guiada de eventos e invitados desde CSV o XLSX,
- vista previa y aplicación de acciones en lote,
- buscador global autorizado,
- comprobante de compra descargable,
- resumen y exportación de salida de una organización.
"""
import base64
import csv
import hashlib
import html
import io
import json
import re
import secrets
import unicodedata
import zipfile
from datetime import datetime, timezone
from typing import Annotated, Any
from xml.etree import ElementTree as ET

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from psycopg.types.json import Jsonb

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    BulkApplyIn,
    BulkPreviewIn,
    ImportApplyIn,
    ImportPreviewIn,
    ReceiptIn,
)

router = APIRouter(tags=["workspace"])

_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
_HEADER_ALIASES = {
    "evento": "name",
    "nombre": "name",
    "name": "name",
    "fecha": "date",
    "inicio": "date",
    "starts_at": "date",
    "hora": "time",
    "time": "time",
    "aforo": "capacity",
    "capacidad": "capacity",
    "capacity": "capacity",
    "lugar": "location",
    "location": "location",
    "categoria": "category",
    "categoría": "category",
    "category": "category",
    "descripcion": "description",
    "descripción": "description",
    "description": "description",
    "telefono": "phone",
    "teléfono": "phone",
    "celular": "phone",
    "phone": "phone",
    "correo": "email",
    "email": "email",
    "tipo": "type",
    "type": "type",
}


def _norm(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", text).strip().lower()


def _xlsx_rows(raw: bytes) -> list[list[str]]:
    """Lector mínimo de XLSX: primera hoja, sin dependencias externas."""
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", _NS):
                shared.append("".join(t.text or "" for t in si.iter(
                    "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t"
                )))
        sheet_name = next(
            (n for n in zf.namelist() if n.startswith("xl/worksheets/sheet")),
            None,
        )
        if not sheet_name:
            raise ValueError("El archivo no tiene una hoja de cálculo")
        root = ET.fromstring(zf.read(sheet_name))
        out: list[list[str]] = []
        for row in root.findall(".//m:sheetData/m:row", _NS):
            values: dict[int, str] = {}
            for cell in row.findall("m:c", _NS):
                ref = cell.get("r", "")
                letters = re.sub(r"[^A-Z]", "", ref.upper())
                index = 0
                for letter in letters:
                    index = index * 26 + (ord(letter) - 64)
                kind = cell.get("t")
                node = cell.find("m:v", _NS)
                if kind == "s" and node is not None:
                    value = shared[int(node.text)]
                elif kind == "inlineStr":
                    value = "".join(cell.itertext())
                else:
                    value = node.text if node is not None else ""
                values[max(0, index - 1)] = value
            if values:
                out.append([values.get(i, "") for i in range(max(values) + 1)])
        return out


def _read_table(filename: str, content_base64: str) -> list[list[str]]:
    try:
        raw = base64.b64decode(content_base64, validate=True)
    except Exception as error:
        raise HTTPException(422, "El archivo no llegó completo") from error
    if filename.lower().endswith((".xlsx", ".xlsm")):
        try:
            return _xlsx_rows(raw)
        except Exception as error:
            raise HTTPException(422, "No pudimos leer el Excel") from error
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise HTTPException(422, "El CSV debe estar en UTF-8") from error
    return list(csv.reader(io.StringIO(text)))


def _header_map(row: list[str]) -> dict[str, int]:
    mapped: dict[str, int] = {}
    for i, value in enumerate(row):
        key = _HEADER_ALIASES.get(_norm(value))
        if key and key not in mapped:
            mapped[key] = i
    return mapped


def _cell(row: list[str], idx: int | None) -> str:
    if idx is None or idx >= len(row):
        return ""
    return str(row[idx] or "").strip()


def _parse_dt(date_text: str, time_text: str = "") -> datetime | None:
    value = date_text.strip()
    if not value:
        return None
    if "T" in value or re.search(r"\d{2}:\d{2}", value):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed
        except ValueError:
            pass
    combined = f"{value} {time_text}".strip()
    for fmt in ("%d/%m/%Y %H:%M", "%d/%m/%Y", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(combined, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _fingerprint(*parts: Any) -> str:
    raw = "|".join(_norm(p) for p in parts)
    return hashlib.sha256(raw.encode()).hexdigest()


def _event_row(row: list[str], headers: dict[str, int]) -> tuple[dict | None, str]:
    name = _cell(row, headers.get("name"))
    date_text = _cell(row, headers.get("date"))
    time_text = _cell(row, headers.get("time"))
    if not name:
        return None, "Falta el nombre del evento"
    starts_at = _parse_dt(date_text, time_text)
    if not starts_at:
        return None, "La fecha no se entiende (usa DD/MM/AAAA o AAAA-MM-DD)"
    try:
        capacity = int(float(_cell(row, headers.get("capacity")) or "0"))
    except ValueError:
        return None, "El aforo debe ser un número entero"
    if capacity < 1:
        return None, "El aforo debe ser mayor que cero"
    category = _cell(row, headers.get("category")) or None
    if category and category not in (
        "Música", "Deportes", "Teatro", "Fiesta", "Cultural",
        "Académico", "Comedia", "Otro",
    ):
        return None, "Categoría no válida"
    return {
        "name": name,
        "starts_at": starts_at.isoformat(),
        "capacity": capacity,
        "location": _cell(row, headers.get("location")) or None,
        "category": category,
        "description": _cell(row, headers.get("description")) or None,
    }, ""


def _guest_row(
    row: list[str], headers: dict[str, int], event_id: int
) -> tuple[dict | None, str]:
    name = _cell(row, headers.get("name"))
    email = _cell(row, headers.get("email")).lower()
    phone = _cell(row, headers.get("phone")) or None
    if not name:
        return None, "Falta el nombre del invitado"
    if not email or "@" not in email:
        return None, "Falta un correo válido"
    return {
        "event_id": event_id,
        "name": name,
        "email": email,
        "phone": phone,
    }, ""


async def _existing_fingerprints(
    cur, venue_id: int, kind: str, fingerprints: list[str]
) -> set[str]:
    if not fingerprints:
        return set()
    await cur.execute(
        "SELECT fingerprint FROM imported_records"
        " WHERE venue_id=%s AND kind=%s AND fingerprint=ANY(%s)",
        (venue_id, kind, fingerprints),
    )
    return {row["fingerprint"] for row in await cur.fetchall()}


@router.post("/venues/{venue_id}/imports/preview")
async def preview_import(
    venue_id: int,
    body: ImportPreviewIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    if body.kind == "guests" and not body.event_id:
        raise HTTPException(422, "Elige el evento para cargar invitados")
    rows = _read_table(body.filename, body.content_base64)
    if not rows:
        raise HTTPException(422, "El archivo está vacío")
    headers = _header_map(rows[0])
    required = "name" if body.kind == "events" else "name"
    if required not in headers:
        raise HTTPException(422, "Falta la columna 'nombre' o 'evento'")

    preview: list[dict] = []
    fingerprints: list[str] = []
    for index, row in enumerate(rows[1:], start=2):
        if not any(str(cell).strip() for cell in row):
            continue
        if body.kind == "events":
            data, error = _event_row(row, headers)
            fingerprint = _fingerprint(
                venue_id, "events", data["name"], data["starts_at"]
            ) if data else ""
        else:
            data, error = _guest_row(row, headers, body.event_id)
            fingerprint = _fingerprint(
                venue_id, "guests", body.event_id,
                data["email"] if data else "",
            ) if data else ""
        preview.append({
            "row_number": index,
            "data": data or {},
            "error": error,
            "fingerprint": fingerprint,
        })
        if fingerprint:
            fingerprints.append(fingerprint)

    async with db.cursor() as cur:
        existing = await _existing_fingerprints(
            cur, venue_id, body.kind, fingerprints
        )
        for item in preview:
            if item["error"]:
                item["status"] = "error"
            elif item["fingerprint"] in existing:
                item["status"] = "duplicate"
            else:
                item["status"] = "valid"
            item.pop("fingerprint", None)
    return {
        "filename": body.filename,
        "kind": body.kind,
        "headers": list(headers.keys()),
        "rows": preview,
        "valid": sum(1 for r in preview if r["status"] == "valid"),
        "duplicates": sum(1 for r in preview if r["status"] == "duplicate"),
        "errors": sum(1 for r in preview if r["status"] == "error"),
    }


@router.post("/venues/{venue_id}/imports/apply")
async def apply_import(
    venue_id: int,
    body: ImportApplyIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    if body.kind == "guests" and not body.event_id:
        raise HTTPException(422, "Elige el evento para cargar invitados")
    imported = duplicates = errors = 0
    async with db.cursor() as cur:
        if body.event_id:
            await cur.execute(
                "SELECT id FROM events WHERE id=%s AND venue_id=%s",
                (body.event_id, venue_id),
            )
            if not await cur.fetchone():
                raise HTTPException(404, "Evento no encontrado")
        await cur.execute(
            "INSERT INTO import_batches"
            " (venue_id, event_id, kind, filename, total_rows, created_by)"
            " VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
            (venue_id, body.event_id, body.kind, body.filename,
             len(body.rows), user["id"]),
        )
        batch_id = (await cur.fetchone())["id"]
        for item in body.rows:
            data = item.data
            if body.kind == "events":
                name = str(data.get("name") or "").strip()
                starts_at = data.get("starts_at")
                try:
                    capacity = int(data.get("capacity") or 0)
                except (TypeError, ValueError):
                    capacity = 0
                if not name or not starts_at or capacity < 1:
                    errors += 1
                    await cur.execute(
                        "INSERT INTO import_rows"
                        " (batch_id,row_number,status,message,data)"
                        " VALUES (%s,%s,'error',%s,%s)",
                        (batch_id, item.row_number,
                         "Nombre, fecha o aforo inválido", Jsonb(data)),
                    )
                    continue
                fingerprint = _fingerprint(venue_id, "events", name, starts_at)
                await cur.execute(
                    "INSERT INTO imported_records"
                    " (venue_id,kind,fingerprint,batch_id)"
                    " VALUES (%s,'events',%s,%s)"
                    " ON CONFLICT DO NOTHING RETURNING id",
                    (venue_id, fingerprint, batch_id),
                )
                claim = await cur.fetchone()
                if not claim:
                    duplicates += 1
                    await cur.execute(
                        "INSERT INTO import_rows"
                        " (batch_id,row_number,status,message,data)"
                        " VALUES (%s,%s,'duplicate',%s,%s)",
                        (batch_id, item.row_number,
                         "Ya estaba cargado", Jsonb(data)),
                    )
                    continue
                await cur.execute(
                    """
                    INSERT INTO events
                        (venue_id, name, starts_at, event_timezone, capacity,
                         status, location, category, description)
                    VALUES (%s,%s,%s,'America/Bogota',%s,'draft',%s,%s,%s)
                    RETURNING id
                    """,
                    (venue_id, name, starts_at, capacity, data.get("location"),
                     data.get("category"), data.get("description")),
                )
                event_id = (await cur.fetchone())["id"]
                await cur.execute(
                    "UPDATE imported_records SET record_id=%s WHERE id=%s",
                    (event_id, claim["id"]),
                )
            else:
                name = str(data.get("name") or "").strip()
                email = str(data.get("email") or "").strip().lower()
                if not name or "@" not in email:
                    errors += 1
                    await cur.execute(
                        "INSERT INTO import_rows"
                        " (batch_id,row_number,status,message,data)"
                        " VALUES (%s,%s,'error',%s,%s)",
                        (batch_id, item.row_number,
                         "Nombre o correo inválido", Jsonb(data)),
                    )
                    continue
                fingerprint = _fingerprint(
                    venue_id, "guests", body.event_id, email
                )
                await cur.execute(
                    "INSERT INTO imported_records"
                    " (venue_id,kind,fingerprint,batch_id)"
                    " VALUES (%s,'guests',%s,%s)"
                    " ON CONFLICT DO NOTHING RETURNING id",
                    (venue_id, fingerprint, batch_id),
                )
                claim = await cur.fetchone()
                if not claim:
                    duplicates += 1
                    await cur.execute(
                        "INSERT INTO import_rows"
                        " (batch_id,row_number,status,message,data)"
                        " VALUES (%s,%s,'duplicate',%s,%s)",
                        (batch_id, item.row_number,
                         "Ya estaba cargado", Jsonb(data)),
                    )
                    continue
                await cur.execute(
                    "INSERT INTO event_rsvps"
                    " (event_id,name,email,phone,token,status)"
                    " VALUES (%s,%s,%s,%s,%s,'confirmada')"
                    " ON CONFLICT (event_id,email) DO NOTHING RETURNING id",
                    (body.event_id, name, email, data.get("phone"),
                     secrets.token_urlsafe(24)),
                )
                rsvp = await cur.fetchone()
                if not rsvp:
                    duplicates += 1
                    await cur.execute(
                        "INSERT INTO import_rows"
                        " (batch_id,row_number,status,message,data)"
                        " VALUES (%s,%s,'duplicate',%s,%s)",
                        (batch_id, item.row_number,
                         "Ese correo ya está en la lista", Jsonb(data)),
                    )
                    continue
                await cur.execute(
                    "UPDATE imported_records SET record_id=%s WHERE id=%s",
                    (rsvp["id"], claim["id"]),
                )
            imported += 1
            await cur.execute(
                "INSERT INTO import_rows"
                " (batch_id,row_number,status,data) VALUES (%s,%s,'imported',%s)",
                (batch_id, item.row_number, Jsonb(data)),
            )
        await cur.execute(
            "UPDATE import_batches SET imported_rows=%s, duplicate_rows=%s,"
            " error_rows=%s WHERE id=%s",
            (imported, duplicates, errors, batch_id),
        )
        await db.commit()
    return {
        "batch_id": batch_id,
        "imported": imported,
        "duplicates": duplicates,
        "errors": errors,
    }


async def _bulk_scope(
    cur, venue_id: int, event_id: int, ids: list[int], action: str
) -> tuple[list[dict], bool]:
    await cur.execute(
        "SELECT id FROM events WHERE id=%s AND venue_id=%s",
        (event_id, venue_id),
    )
    if not await cur.fetchone():
        raise HTTPException(404, "Evento no encontrado")
    await cur.execute(
        """
        SELECT tt.id, tt.name, tt.price_cents, tt.quantity, tt.is_active,
               count(t.id) FILTER (WHERE t.status IN ('issued','redeemed'))::int
                   AS issued
          FROM ticket_types tt
          LEFT JOIN tickets t ON t.ticket_type_id=tt.id
         WHERE tt.event_id=%s AND tt.id=ANY(%s)
         GROUP BY tt.id ORDER BY tt.id
        """,
        (event_id, ids),
    )
    rows = await cur.fetchall()
    if len(rows) != len(set(ids)):
        raise HTTPException(404, "Algún tipo no pertenece a este evento")
    return rows, action == "activate"


@router.post("/venues/{venue_id}/events/{event_id}/bulk/preview")
async def bulk_preview(
    venue_id: int,
    event_id: int,
    body: BulkPreviewIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        rows, new_active = await _bulk_scope(
            cur, venue_id, event_id, body.ids, body.action
        )
    return {
        "new_active": new_active,
        "affected": rows,
        "count": len(rows),
        "issued_tickets": sum(row["issued"] for row in rows),
    }


@router.post("/venues/{venue_id}/events/{event_id}/bulk/apply")
async def bulk_apply(
    venue_id: int,
    event_id: int,
    body: BulkApplyIn,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await _bulk_scope(cur, venue_id, event_id, body.ids, body.action)
        new_active = body.action == "activate"
        await cur.execute(
            "UPDATE ticket_types SET is_active=%s"
            " WHERE event_id=%s AND id=ANY(%s) RETURNING id, name, is_active",
            (new_active, event_id, body.ids),
        )
        updated = await cur.fetchall()
        await db.commit()
    return {"updated": updated, "count": len(updated), "is_active": new_active}


@router.get("/search")
async def global_search(
    q: Annotated[str, Query(min_length=2, max_length=120)],
    venue_id: Annotated[int | None, Query()] = None,
    user: Annotated[dict, Depends(get_current_user)] = None,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)] = None,
):
    if not venue_id:
        venue_id = user.get("active_venue_id") or (
            user.get("venue_ids") or [None]
        )[0]
    if not venue_id:
        return {"items": []}
    ensure_roles(
        user, venue_id, "super_admin", "admin", "promotor", "bouncer"
    )
    needle = f"%{q.strip()}%"
    items: list[dict] = []
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, name, starts_at, status FROM events"
            " WHERE venue_id=%s AND (name ILIKE %s OR coalesce(location,'') ILIKE %s)"
            " ORDER BY starts_at DESC LIMIT 8",
            (venue_id, needle, needle),
        )
        for row in await cur.fetchall():
            items.append({
                "kind": "event",
                "title": row["name"],
                "subtitle": f"{row['starts_at']:%d/%m/%Y} · {row['status']}",
                "url": f"/admin?event={row['id']}",
            })
        await cur.execute(
            """
            SELECT DISTINCT u.id, u.full_name, u.email, r.role
              FROM users u JOIN venue_user_roles r ON r.user_id=u.id
             WHERE r.venue_id=%s AND (u.full_name ILIKE %s OR u.email ILIKE %s)
             ORDER BY u.full_name LIMIT 8
            """,
            (venue_id, needle, needle),
        )
        for row in await cur.fetchall():
            items.append({
                "kind": "person",
                "title": row["full_name"],
                "subtitle": f"{row['role']} · {row['email']}",
                "url": "/admin/organizacion?tab=equipo",
            })
    actions = [
        ("Cambiar contraseña", "Seguridad de tu cuenta", "/perfil?tab=seguridad"),
        ("Descargar mis datos", "Portabilidad de tu cuenta", "/perfil?tab=cuenta"),
        ("Importar CSV o Excel", "Eventos e invitados", "/admin/organizacion?tab=importar"),
        ("Salida ordenada", "Descargar datos de la organización", "/admin/organizacion?tab=salida"),
        ("Eventos", "Volver a la lista", "/admin"),
        ("Reportes", "Ventas y operación", "/admin/reportes"),
    ]
    for title, subtitle, url in actions:
        if _norm(q) in _norm(title) or _norm(q) in _norm(subtitle):
            items.append({
                "kind": "action", "title": title, "subtitle": subtitle, "url": url,
            })
    return {"items": items[:12]}


@router.post("/public/purchase-receipt")
async def purchase_receipt(
    body: ReceiptIn,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    digest = hashlib.sha256(body.raw_token.encode()).hexdigest()
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT t.id, t.customer_name, t.price_cents_snapshot, t.status,
                   t.payment_method, t.issued_at,
                   e.name AS event_name, e.starts_at,
                   v.name AS venue_name,
                   p.reference, p.amount_in_cents, p.status AS payment_status,
                   p.approved_at
              FROM tickets t
              JOIN events e ON e.id=t.event_id
              JOIN venues v ON v.id=e.venue_id
              LEFT JOIN ticket_payments p ON p.ticket_id=t.id
             WHERE t.token_hash=%s
             ORDER BY p.approved_at DESC NULLS LAST
             LIMIT 1
            """,
            (digest,),
        )
        row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Boleta no encontrada")
    amount = row["amount_in_cents"] or row["price_cents_snapshot"]
    reference = row["reference"] or "Pago en taquilla"
    paid_at = row["approved_at"] or row["issued_at"]
    body_html = f"""<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>Comprobante Enty #{row['id']}</title>
<style>
body{{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 24px;color:#111}}
h1{{font-size:24px;margin:0 0 4px}} .muted{{color:#555}}
table{{width:100%;border-collapse:collapse;margin:24px 0}}
td,th{{padding:10px 0;border-bottom:1px solid #ddd;text-align:left}}
td:last-child{{text-align:right;font-weight:600}}
.footer{{margin-top:32px;font-size:12px;color:#666}}
</style></head><body>
<h1>Comprobante de compra</h1>
<p class="muted">{html.escape(row['venue_name'])}</p>
<table>
<tr><th>Evento</th><td>{html.escape(row['event_name'])}</td></tr>
<tr><th>Asistente</th><td>{html.escape(row['customer_name'])}</td></tr>
<tr><th>Boleta</th><td>#{row['id']}</td></tr>
<tr><th>Referencia de pago</th><td>{html.escape(str(reference))}</td></tr>
<tr><th>Fecha</th><td>{paid_at:%d/%m/%Y %H:%M}</td></tr>
<tr><th>Estado</th><td>{html.escape(row['payment_status'] or row['status'])}</td></tr>
<tr><th>Total</th><td>${amount/100:,.0f} COP</td></tr>
</table>
<p class="footer">Este comprobante no reemplaza el QR de acceso. Guárdalo por separado.
Generado por Enty.</p>
</body></html>"""
    return Response(
        content=body_html,
        media_type="text/html; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename="comprobante-enty-{row["id"]}.html"'
            )
        },
    )


async def _venue(cur, venue_id: int, user: dict) -> dict:
    ensure_roles(user, venue_id, "super_admin", "admin")
    await cur.execute("SELECT * FROM venues WHERE id=%s", (venue_id,))
    row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Organización no encontrada")
    return row


@router.get("/venues/{venue_id}/exit-summary")
async def exit_summary(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        venue = await _venue(cur, venue_id, user)
        await cur.execute(
            """
            SELECT count(*) FILTER (WHERE starts_at >= now())::int AS future_events,
                   count(*) FILTER (WHERE status IN ('published','live'))::int
                       AS selling_events
              FROM events WHERE venue_id=%s
            """,
            (venue_id,),
        )
        events = await cur.fetchone()
        await cur.execute(
            """
            SELECT count(*)::int AS sold,
                   count(*) FILTER (WHERE t.status='redeemed')::int AS admitted,
                   coalesce(sum(t.price_cents_snapshot)
                            FILTER (WHERE t.status IN ('issued','redeemed')),0)::bigint
                       AS gross_cents
              FROM tickets t JOIN events e ON e.id=t.event_id
             WHERE e.venue_id=%s
            """,
            (venue_id,),
        )
        tickets = await cur.fetchone()
    return {
        "venue": {"id": venue["id"], "name": venue["name"]},
        "future_events": events["future_events"],
        "selling_events": events["selling_events"],
        "sold_tickets": tickets["sold"],
        "admitted_tickets": tickets["admitted"],
        "gross_cents": tickets["gross_cents"],
        "note": (
            "Las boletas ya vendidas siguen siendo válidas hasta el final del "
            "evento. Descarga el archivo para conservar el historial."
        ),
    }


@router.get("/venues/{venue_id}/export.json")
async def export_venue(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        venue = await _venue(cur, venue_id, user)
        await cur.execute(
            "SELECT id,name,starts_at,ends_at,status,capacity,location,category"
            " FROM events WHERE venue_id=%s ORDER BY starts_at",
            (venue_id,),
        )
        events = await cur.fetchall()
        await cur.execute(
            "SELECT tt.id,tt.event_id,tt.name,tt.price_cents,tt.quantity,tt.is_active"
            " FROM ticket_types tt JOIN events e ON e.id=tt.event_id"
            " WHERE e.venue_id=%s ORDER BY tt.event_id,tt.id",
            (venue_id,),
        )
        types = await cur.fetchall()
        await cur.execute(
            "SELECT t.id,t.event_id,t.ticket_type_id,t.customer_name,"
            "t.customer_email,t.status,t.issued_at,t.redeemed_at,"
            "t.price_cents_snapshot,t.payment_method"
            " FROM tickets t JOIN events e ON e.id=t.event_id"
            " WHERE e.venue_id=%s ORDER BY t.issued_at",
            (venue_id,),
        )
        tickets = await cur.fetchall()
        await cur.execute(
            "SELECT u.id,u.full_name,u.email,r.role"
            " FROM users u JOIN venue_user_roles r ON r.user_id=u.id"
            " WHERE r.venue_id=%s ORDER BY u.full_name",
            (venue_id,),
        )
        team = await cur.fetchall()
    payload = {
        "format": "enty-venue-export",
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "venue": {k: venue[k] for k in (
            "id", "name", "slug", "legal_name", "tax_id", "country", "currency"
        ) if k in venue},
        "events": events,
        "ticket_types": types,
        "tickets": tickets,
        "team": team,
    }
    return Response(
        content=json.dumps(payload, ensure_ascii=False, indent=2, default=str),
        media_type="application/json; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename="enty-{venue["slug"]}-export.json"'
            )
        },
    )
