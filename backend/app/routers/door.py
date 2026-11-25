"""Puerta como espacio operativo (mig 064).

Este router concentra lo que NO es solo un escaneo:

- el contexto de la puerta (estado, aforo, tres cifras separadas, contacto);
- la autorización del teléfono y el relevo de turno;
- las incidencias compartidas por Evento, Administración y Promotor.

Las operaciones de entrada/salida siguen viviendo en tickets/scanner. Allí se
revalida el mismo dispositivo con `core.door_auth`; este router no es una
segunda puerta de autorización.
"""
from datetime import datetime, timedelta, timezone
from secrets import token_urlsafe
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, Header, HTTPException, Query, status

from app.core.db import get_db
from app.core.door_auth import token_hash
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    DoorContextOut,
    DoorDeviceOut,
    DoorIncidentCommentCreate,
    DoorIncidentCommentOut,
    DoorIncidentCreate,
    DoorIncidentDetailOut,
    DoorIncidentOut,
    DoorIncidentPromoterRequest,
    DoorIncidentStatusUpdate,
    DoorShiftApprove,
    DoorShiftRequestCreate,
    DoorShiftRequestOut,
    MessageOut,
)

router = APIRouter(prefix="/venues/{venue_id}", tags=["puerta"])

_LINK_HOURS = 72


def _role_label(roles: list[str]) -> str:
    if "admin" in roles or "super_admin" in roles:
        return "admin"
    if "promotor" in roles:
        return "promotor"
    return "bouncer"


async def _event_or_404(cur, venue_id: int, event_id: int) -> dict:
    await cur.execute(
        """SELECT e.id, e.venue_id, e.name, e.status, e.starts_at,
                  e.capacity, e.allow_reentry,
                  v.contact_name, v.contact_phone,
                  coalesce(
                    (to_jsonb(v) ->> 'contact_team_visible')::boolean, true
                  ) AS contact_team_visible
             FROM events e JOIN venues v ON v.id=e.venue_id
            WHERE e.id=%s AND e.venue_id=%s""",
        (event_id, venue_id),
    )
    ev = await cur.fetchone()
    if not ev:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Evento no encontrado")
    return ev


async def _device_by_token(cur, event_id: int, user_id: int, raw: str | None):
    if not raw:
        return None
    await cur.execute(
        """SELECT id, event_id, user_id, door_name, ticket_type_id, phone,
                  status, activated_at, expires_at, last_seen_at
             FROM event_door_devices
            WHERE event_id=%s AND user_id=%s AND token_hash=%s
            ORDER BY id DESC LIMIT 1""",
        (event_id, user_id, token_hash(raw)),
    )
    device = await cur.fetchone()
    if not device:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Tu teléfono no está autorizado para esta puerta.",
        )
    if device["status"] != "active":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Tu autorización de Puerta fue revocada o reemplazada.",
        )
    await cur.execute(
        "SELECT (%s::timestamptz > now()) AS vigente",
        (device["expires_at"],),
    )
    if not (await cur.fetchone())["vigente"]:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "La autorización de este teléfono venció.",
        )
    return device


async def _device_only(
    cur, *, event_id: int, venue_id: int, user: dict, raw: str | None
) -> dict | None:
    """Puerta puede operar sin link solo en eventos sin dispositivos (legacy)."""
    roles = user["roles"].get(venue_id, [])
    if any(r in ("super_admin", "admin") for r in roles):
        return None
    if raw:
        return await _device_by_token(cur, event_id, user["id"], raw)
    await cur.execute(
        "SELECT count(*)::int AS n FROM event_door_devices WHERE event_id=%s",
        (event_id,),
    )
    if (await cur.fetchone())["n"] > 0:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Este teléfono no está autorizado. Abre el link de Puerta de tu puesto.",
        )
    return None


async def _incident_row(cur, incident_id: int, venue_id: int) -> dict:
    await cur.execute(
        """SELECT i.*, e.name AS event_name, e.status AS event_status,
                  creator.full_name AS created_by_name,
                  changer.full_name AS status_changed_by_name,
                  admin.full_name AS assigned_admin_name,
                  promoter.full_name AS promoter_name,
                  tt.name AS ticket_type_name
             FROM door_incidents i
             JOIN events e ON e.id=i.event_id
             JOIN users creator ON creator.id=i.created_by
             LEFT JOIN users changer ON changer.id=i.status_changed_by
             LEFT JOIN users admin ON admin.id=i.assigned_admin_id
             LEFT JOIN users promoter ON promoter.id=i.promoter_id
             LEFT JOIN tickets t ON t.id=i.ticket_id
             LEFT JOIN ticket_types tt ON tt.id=t.ticket_type_id
            WHERE i.id=%s AND i.venue_id=%s""",
        (incident_id, venue_id),
    )
    row = await cur.fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Incidencia no encontrada")
    return row


def _can_access(row: dict, user: dict, venue_id: int) -> tuple[bool, bool]:
    roles = user["roles"].get(venue_id, [])
    if any(r in ("super_admin", "admin") for r in roles):
        return True, True
    if "bouncer" in roles and row["created_by"] == user["id"]:
        return True, False
    if "promotor" in roles and (
        row["promoter_access"] or row["promoter_id"] == user["id"]
    ):
        return True, False
    return False, False


async def _assert_incident_access(cur, incident_id: int, venue_id: int, user: dict) -> dict:
    row = await _incident_row(cur, incident_id, venue_id)
    allowed, _ = _can_access(row, user, venue_id)
    if not allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "No tienes acceso a esta incidencia.",
        )
    return row


def _incident_out(row: dict, user: dict, venue_id: int) -> DoorIncidentOut:
    can_comment, can_manage = _can_access(row, user, venue_id)
    return DoorIncidentOut(
        id=row["id"],
        event_id=row["event_id"],
        status=row["status"],
        reason=row["reason"],
        note=row["note"],
        door_name=row["door_name"],
        ticket_id=row["ticket_id"],
        ticket_ref=row["ticket_ref"],
        ticket_type_name=row["ticket_type_name"],
        created_by=row["created_by"],
        created_by_name=row["created_by_name"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        status_changed_by_name=row["status_changed_by_name"],
        status_changed_at=row["status_changed_at"],
        resolved_at=row["resolved_at"],
        resolution_guidance=row["resolution_guidance"],
        promoter_id=row["promoter_id"],
        promoter_name=row["promoter_name"],
        promoter_access=row["promoter_access"],
        assigned_admin_name=row["assigned_admin_name"],
        can_comment=can_comment,
        can_manage=can_manage,
    )


async def _comments(cur, incident_id: int) -> list[DoorIncidentCommentOut]:
    await cur.execute(
        """SELECT c.id, c.author_id, u.full_name AS author_name,
                  c.author_role, c.body, c.channel, c.created_at
             FROM door_incident_comments c
             JOIN users u ON u.id=c.author_id
            WHERE c.incident_id=%s
            ORDER BY c.created_at, c.id""",
        (incident_id,),
    )
    return [DoorIncidentCommentOut(**r) for r in await cur.fetchall()]


def _incident_link(incident: dict, role: str) -> str:
    if role == "admin":
        return (
            f"/admin?event={incident['event_id']}&tab=accesos"
            f"&incidencia={incident['id']}"
        )
    if role == "promotor":
        return f"/promotor/evento/{incident['event_id']}?incidencia={incident['id']}"
    return f"/bouncer?evento={incident['event_id']}&incidencia={incident['id']}"


async def _notify(cur, user_id: int, venue_id: int, kind: str, title: str, body: str, link: str):
    if not user_id:
        return
    await cur.execute(
        "SELECT notify_user(%s, %s, %s, %s, %s, %s)",
        (user_id, venue_id, kind, title, body, link),
    )


async def _admin_ids(cur, venue_id: int) -> list[int]:
    await cur.execute(
        """SELECT DISTINCT r.user_id
             FROM venue_user_roles r JOIN users u ON u.id=r.user_id
            WHERE r.venue_id=%s AND r.role IN ('admin','super_admin')
              AND u.is_active""",
        (venue_id,),
    )
    return [r["user_id"] for r in await cur.fetchall()]


async def _notify_incident(
    cur,
    incident: dict,
    *,
    kind: str,
    title: str,
    body: str,
    actor_id: int | None,
    include_admins: bool = True,
) -> None:
    """Un aviso por persona y por el canal que le corresponde.

    El mismo expediente se ve en tres apps distintas; por eso el link se arma
    por rol. Se excluye al actor para no duplicar su propia acción.
    """
    recipients: dict[int, str] = {}
    if include_admins:
        for uid in await _admin_ids(cur, incident["venue_id"]):
            if uid != actor_id:
                recipients[uid] = _incident_link(incident, "admin")
    if incident["created_by"] != actor_id:
        recipients[incident["created_by"]] = _incident_link(incident, "bouncer")
    if incident["promoter_access"] or incident["promoter_id"]:
        promoter_id = incident["promoter_id"]
        if promoter_id and promoter_id != actor_id:
            recipients[promoter_id] = _incident_link(incident, "promotor")
    for uid, link in recipients.items():
        await _notify(cur, uid, incident["venue_id"], kind, title, body, link)


# ---------------------------------------------------------------------------
# Contexto de la puerta
# ---------------------------------------------------------------------------
@router.get("/events/{event_id}/door-context", response_model=DoorContextOut)
async def door_context(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    x_door_device: Annotated[str | None, Header(alias="X-Door-Device")] = None,
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        ev = await _event_or_404(cur, venue_id, event_id)
        device = await _device_by_token(cur, event_id, user["id"], x_door_device)

        # El turno y el puesto viven en el roster aunque el teléfono traiga
        # token: Puerta necesita mostrar la ventana del turno, no solo el
        # dispositivo.
        await cur.execute(
            """SELECT door_name, door_ticket_type_id, shift_start, shift_end
                 FROM event_staff WHERE event_id=%s AND user_id=%s""",
            (event_id, user["id"]),
        )
        staff = await cur.fetchone()

        await cur.execute("SELECT * FROM event_occupancy(%s)", (event_id,))
        occ = await cur.fetchone()

        roles = user["roles"].get(venue_id, [])
        if any(r in ("super_admin", "admin") for r in roles):
            await cur.execute(
                """SELECT count(*)::int AS n FROM door_incidents
                    WHERE event_id=%s AND status<>'resolved'""",
                (event_id,),
            )
        elif "promotor" in roles:
            await cur.execute(
                """SELECT count(*)::int AS n FROM door_incidents
                    WHERE event_id=%s AND status<>'resolved'
                      AND (promoter_id=%s OR promoter_access)""",
                (event_id, user["id"]),
            )
        else:
            await cur.execute(
                """SELECT count(*)::int AS n FROM door_incidents
                    WHERE event_id=%s AND status<>'resolved' AND created_by=%s""",
                (event_id, user["id"]),
            )
        open_incidents = (await cur.fetchone())["n"]

    assigned_door = (
        device["door_name"] if device else (staff["door_name"] if staff else None)
    )
    assigned_type = (
        device["ticket_type_id"]
        if device
        else (staff["door_ticket_type_id"] if staff else None)
    )
    return DoorContextOut(
        event_id=event_id,
        event_name=ev["name"],
        event_status=ev["status"],
        starts_at=ev["starts_at"],
        capacity=ev["capacity"],
        allow_reentry=ev["allow_reentry"],
        door_open=ev["status"] == "live",
        inside=occ["inside"],
        admitted=occ["unique_admitted"],
        exits=occ["exits"],
        reentries=occ["reentries"],
        issued=occ["issued"],
        rejected=occ["rejected"],
        last_verified_at=datetime.now(timezone.utc),
        assigned_door=assigned_door,
        assigned_ticket_type_id=assigned_type,
        shift_start=staff["shift_start"] if staff else None,
        shift_end=staff["shift_end"] if staff else None,
        open_incidents=open_incidents,
        device=DoorDeviceOut(**device) if device else None,
        # El contacto operativo es para el equipo. Si la organización decidió
        # no compartirlo internamente, la puerta no lo recibe: guardar no es
        # autorizar, y el mismo dato alimenta la ficha pública solo por sus
        # propios canales.
        ops_contact_name=ev["contact_name"] if ev["contact_team_visible"] else None,
        ops_contact_phone=ev["contact_phone"] if ev["contact_team_visible"] else None,
    )


# ---------------------------------------------------------------------------
# Turno / relevo / dispositivos
# ---------------------------------------------------------------------------
@router.post(
    "/events/{event_id}/door-shift-requests",
    response_model=DoorShiftRequestOut,
    status_code=status.HTTP_201_CREATED,
)
async def request_shift(
    venue_id: int,
    event_id: int,
    body: DoorShiftRequestCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    x_door_device: Annotated[str | None, Header(alias="X-Door-Device")] = None,
):
    ensure_roles(user, venue_id, "bouncer", "admin", "super_admin")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        device = await _device_only(
            cur, event_id=event_id, venue_id=venue_id, user=user, raw=x_door_device
        )
        await cur.execute(
            """INSERT INTO door_shift_requests
                   (event_id, device_id, requested_by, requested_phone, reason)
               VALUES (%s, %s, %s, %s, %s)
               RETURNING id, created_at""",
            (event_id, device["id"] if device else None, user["id"],
             body.requested_phone, body.reason),
        )
        row = await cur.fetchone()
        await cur.execute(
            """SELECT s.id, s.event_id, s.device_id, s.requested_by,
                      u.full_name AS requested_by_name, s.requested_phone,
                      s.reason, s.status, s.created_at,
                      d.door_name
                 FROM door_shift_requests s
                 JOIN users u ON u.id=s.requested_by
                 LEFT JOIN event_door_devices d ON d.id=s.device_id
                WHERE s.id=%s""",
            (row["id"],),
        )
        out = await cur.fetchone()
        for uid in await _admin_ids(cur, venue_id):
            if uid != user["id"]:
                await _notify(
                    cur, uid, venue_id, "door_shift_requested",
                    "Relevo solicitado en Puerta",
                    f"{user['full_name']}: {body.reason}",
                    f"/admin?event={event_id}&tab=equipo",
                )
        await db.commit()
    return DoorShiftRequestOut(**out)


@router.get(
    "/events/{event_id}/door-shift-requests",
    response_model=list[DoorShiftRequestOut],
)
async def list_shift_requests(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "admin", "super_admin", "bouncer")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        roles = user["roles"].get(venue_id, [])
        mine = not any(r in ("admin", "super_admin") for r in roles)
        await cur.execute(
            """SELECT s.id, s.event_id, s.device_id, s.requested_by,
                      u.full_name AS requested_by_name, s.requested_phone,
                      s.reason, s.status, s.created_at,
                      d.door_name,
                      reviewer.full_name AS reviewed_by_name,
                      s.reviewed_at, s.review_note
                 FROM door_shift_requests s
                 JOIN users u ON u.id=s.requested_by
                 LEFT JOIN event_door_devices d ON d.id=s.device_id
                 LEFT JOIN users reviewer ON reviewer.id=s.reviewed_by
                WHERE s.event_id=%s AND (%s = false OR s.requested_by=%s)
                ORDER BY s.created_at DESC""",
            (event_id, mine, user["id"]),
        )
        return [DoorShiftRequestOut(**r) for r in await cur.fetchall()]


async def _issue_handover(
    cur,
    *,
    venue_id: int,
    event_id: int,
    old_device_id: int | None,
    target_user_id: int,
    phone: str | None,
    actor_id: int,
) -> tuple[str, str | None]:
    """Releva el puesto: revoca el teléfono anterior y emite link al nuevo."""
    old = None
    if old_device_id:
        await cur.execute(
            """SELECT d.door_name, d.ticket_type_id, d.event_id
                 FROM event_door_devices d
                WHERE d.id=%s AND d.event_id=%s""",
            (old_device_id, event_id),
        )
        old = await cur.fetchone()
    door_name = old["door_name"] if old else None
    ticket_type_id = old["ticket_type_id"] if old else None

    await cur.execute(
        """SELECT s.door_name, s.door_ticket_type_id
             FROM event_staff s
            WHERE s.event_id=%s AND s.user_id=%s AND s.role='bouncer'""",
        (event_id, target_user_id),
    )
    target_staff = await cur.fetchone()
    if not target_staff:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "La persona de relevo debe estar asignada a Puerta esa noche.",
        )
    door_name = door_name or target_staff["door_name"]
    ticket_type_id = ticket_type_id or target_staff["door_ticket_type_id"]

    if door_name:
        await cur.execute(
            """UPDATE event_door_devices
                  SET status='replaced', revoked_at=now(), revoked_by=%s
                WHERE event_id=%s AND lower(door_name)=lower(%s)
                  AND status='active'""",
            (actor_id, event_id, door_name),
        )

    await cur.execute(
        """UPDATE event_access_tokens SET revoked_at=now()
            WHERE event_id=%s AND user_id=%s
              AND used_at IS NULL AND revoked_at IS NULL""",
        (event_id, target_user_id),
    )
    raw = token_urlsafe(24)
    await cur.execute(
        """INSERT INTO event_access_tokens
               (event_id, user_id, token_hash, expires_at, created_by,
                door_name, ticket_type_id, phone)
           VALUES (%s, %s, %s, now() + %s, %s, %s, %s, %s)""",
        (event_id, target_user_id, token_hash(raw), timedelta(hours=_LINK_HOURS),
         actor_id, door_name, ticket_type_id, phone),
    )
    return f"/puerta?token={raw}", door_name


async def _request_out(cur, request_id: int) -> dict:
    await cur.execute(
        """SELECT s.id, s.event_id, s.device_id, s.requested_by,
                  u.full_name AS requested_by_name, s.requested_phone,
                  s.reason, s.status, s.created_at, d.door_name,
                  reviewer.full_name AS reviewed_by_name,
                  s.reviewed_at, s.review_note
             FROM door_shift_requests s
             JOIN users u ON u.id=s.requested_by
             LEFT JOIN event_door_devices d ON d.id=s.device_id
             LEFT JOIN users reviewer ON reviewer.id=s.reviewed_by
            WHERE s.id=%s""",
        (request_id,),
    )
    row = await cur.fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Solicitud no encontrada")
    return row


@router.post(
    "/events/{event_id}/door-shift-requests/{request_id}/approve",
    response_model=DoorShiftRequestOut,
)
async def approve_shift(
    venue_id: int,
    event_id: int,
    request_id: int,
    body: DoorShiftApprove,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "admin", "super_admin")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        await cur.execute(
            """SELECT id, device_id, requested_by, status
                 FROM door_shift_requests
                WHERE id=%s AND event_id=%s""",
            (request_id, event_id),
        )
        req = await cur.fetchone()
        if not req:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Solicitud no encontrada")
        if req["status"] != "pending":
            raise HTTPException(status.HTTP_409_CONFLICT, "Esa solicitud ya fue revisada.")

        access_url, door_name = await _issue_handover(
            cur,
            venue_id=venue_id,
            event_id=event_id,
            old_device_id=req["device_id"],
            target_user_id=body.user_id,
            phone=body.phone,
            actor_id=user["id"],
        )
        await cur.execute(
            """UPDATE door_shift_requests
                  SET status='approved', reviewed_by=%s, reviewed_at=now(),
                      review_note=%s
                WHERE id=%s""",
            (user["id"], body.note, request_id),
        )
        await _notify(
            cur, req["requested_by"], venue_id, "door_shift_changed",
            "Relevo aprobado",
            "Administración aprobó tu relevo. Tu teléfono ya no registra operaciones.",
            f"/bouncer?evento={event_id}",
        )
        await _notify(
            cur, body.user_id, venue_id, "door_shift_changed",
            "Nuevo turno en Puerta",
            f"Te asignaron el puesto {door_name or 'de Puerta'}. Abre el link nuevo.",
            f"/bouncer?evento={event_id}",
        )
        out = await _request_out(cur, request_id)
        out["access_url"] = access_url
        await db.commit()
    return DoorShiftRequestOut(**out)


@router.post(
    "/events/{event_id}/door-shift-requests/{request_id}/reject",
    response_model=DoorShiftRequestOut,
)
async def reject_shift(
    venue_id: int,
    event_id: int,
    request_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    body: DoorShiftApprove | None = None,
):
    ensure_roles(user, venue_id, "admin", "super_admin")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        await cur.execute(
            """UPDATE door_shift_requests
                  SET status='rejected', reviewed_by=%s, reviewed_at=now(),
                      review_note=%s
                WHERE id=%s AND event_id=%s AND status='pending'
                RETURNING requested_by""",
            (user["id"], body.note if body else None, request_id, event_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_409_CONFLICT, "Esa solicitud ya fue revisada.")
        await _notify(
            cur, row["requested_by"], venue_id, "door_shift_changed",
            "Relevo no aprobado",
            "Administración revisó tu solicitud de relevo.",
            f"/bouncer?evento={event_id}",
        )
        out = await _request_out(cur, request_id)
        await db.commit()
    return DoorShiftRequestOut(**out)


@router.post("/events/{event_id}/door-devices/{device_id}/revoke", response_model=MessageOut)
async def revoke_device(
    venue_id: int,
    event_id: int,
    device_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "admin", "super_admin")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        await cur.execute(
            """UPDATE event_door_devices
                  SET status='revoked', revoked_at=now(), revoked_by=%s
                WHERE id=%s AND event_id=%s AND status='active'
                RETURNING user_id, door_name""",
            (user["id"], device_id, event_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Dispositivo activo no encontrado")
        await _notify(
            cur, row["user_id"], venue_id, "door_device_revoked",
            "Autorización de Puerta revocada",
            f"El teléfono del puesto {row['door_name'] or 'Puerta'} ya no puede operar.",
            f"/bouncer?evento={event_id}",
        )
        await db.commit()
    return MessageOut(detail="Dispositivo revocado.")


@router.post("/events/{event_id}/door-devices/{device_id}/transfer")
async def transfer_device(
    venue_id: int,
    event_id: int,
    device_id: int,
    body: DoorShiftApprove,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "admin", "super_admin")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        access_url, door_name = await _issue_handover(
            cur,
            venue_id=venue_id,
            event_id=event_id,
            old_device_id=device_id,
            target_user_id=body.user_id,
            phone=body.phone,
            actor_id=user["id"],
        )
        await _notify(
            cur, body.user_id, venue_id, "door_shift_changed",
            "Nuevo turno en Puerta",
            f"Te asignaron el puesto {door_name or 'de Puerta'}. Abre el link nuevo.",
            f"/bouncer?evento={event_id}",
        )
        await db.commit()
    return {"access_url": access_url, "door_name": door_name}


# ---------------------------------------------------------------------------
# Incidencias compartidas
# ---------------------------------------------------------------------------
@router.get("/events/{event_id}/door-incidents", response_model=list[DoorIncidentOut])
async def list_incidents(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    incident_status: Annotated[str | None, Query(alias="status")] = None,
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        roles = user["roles"].get(venue_id, [])
        params: list = [event_id, venue_id]
        where = "i.event_id=%s AND i.venue_id=%s"
        if "admin" not in roles and "super_admin" not in roles:
            if "bouncer" in roles:
                where += " AND i.created_by=%s"
                params.append(user["id"])
            else:
                where += " AND (i.promoter_id=%s OR i.promoter_access)"
                params.append(user["id"])
        if incident_status:
            where += " AND i.status=%s"
            params.append(incident_status)
        await cur.execute(
            f"""SELECT i.*, e.name AS event_name, e.status AS event_status,
                       creator.full_name AS created_by_name,
                       changer.full_name AS status_changed_by_name,
                       admin.full_name AS assigned_admin_name,
                       promoter.full_name AS promoter_name,
                       tt.name AS ticket_type_name
                  FROM door_incidents i
                  JOIN events e ON e.id=i.event_id
                  JOIN users creator ON creator.id=i.created_by
                  LEFT JOIN users changer ON changer.id=i.status_changed_by
                  LEFT JOIN users admin ON admin.id=i.assigned_admin_id
                  LEFT JOIN users promoter ON promoter.id=i.promoter_id
                  LEFT JOIN tickets t ON t.id=i.ticket_id
                  LEFT JOIN ticket_types tt ON tt.id=t.ticket_type_id
                 WHERE {where}
                 ORDER BY (i.status='resolved'), i.created_at DESC""",
            params,
        )
        return [_incident_out(r, user, venue_id) for r in await cur.fetchall()]


@router.get(
    "/events/{event_id}/door-incidents/{incident_id}",
    response_model=DoorIncidentDetailOut,
)
async def incident_detail(
    venue_id: int,
    event_id: int,
    incident_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        row = await _assert_incident_access(cur, incident_id, venue_id, user)
        base = _incident_out(row, user, venue_id)
        return DoorIncidentDetailOut(
            **base.model_dump(), comments=await _comments(cur, incident_id)
        )


@router.post(
    "/events/{event_id}/door-incidents",
    response_model=DoorIncidentOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_incident(
    venue_id: int,
    event_id: int,
    body: DoorIncidentCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    x_door_device: Annotated[str | None, Header(alias="X-Door-Device")] = None,
):
    ensure_roles(user, venue_id, "super_admin", "admin", "bouncer")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        device = await _device_only(
            cur, event_id=event_id, venue_id=venue_id, user=user, raw=x_door_device
        )
        ticket = None
        if body.ticket_id is not None:
            await cur.execute(
                """SELECT t.id, t.ticket_type_id, t.sold_by_user_id,
                          tt.name AS type_name
                     FROM tickets t LEFT JOIN ticket_types tt ON tt.id=t.ticket_type_id
                    WHERE t.id=%s AND t.event_id=%s""",
                (body.ticket_id, event_id),
            )
            ticket = await cur.fetchone()
            if not ticket:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Esa boleta no pertenece al evento.",
                )
        ticket_ref = body.ticket_ref or (f"#{ticket['id']}" if ticket else None)
        door_name = (device or {}).get("door_name") or (body.door_name or "").strip() or None
        promoter_id = ticket["sold_by_user_id"] if ticket else None
        try:
            await cur.execute(
                """INSERT INTO door_incidents
                       (venue_id, event_id, device_id, created_by, ticket_id,
                        ticket_ref, door_name, reason, note, promoter_id,
                        client_request_id)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   RETURNING id""",
                (
                    venue_id, event_id, device["id"] if device else None,
                    user["id"], ticket["id"] if ticket else None, ticket_ref,
                    door_name, body.reason, body.note, promoter_id,
                    body.client_request_id,
                ),
            )
            row_id = (await cur.fetchone())["id"]
        except psycopg.errors.UniqueViolation:
            await db.rollback()
            if not body.client_request_id:
                raise
            await cur.execute(
                """SELECT id FROM door_incidents
                    WHERE created_by=%s AND client_request_id=%s""",
                (user["id"], body.client_request_id),
            )
            row_id = (await cur.fetchone())["id"]
        row = await _incident_row(cur, row_id, venue_id)
        await _notify_incident(
            cur, row, kind="door_incident_opened",
            title="Nueva incidencia en Puerta",
            body=(
                f"{body.reason} · {door_name or 'Puerta'}"
                f"{' · ' + ticket_ref if ticket_ref else ''}. "
                f"Reportada por {user['full_name']}."
            ),
            actor_id=user["id"],
        )
        await db.commit()
    return _incident_out(row, user, venue_id)


@router.post(
    "/events/{event_id}/door-incidents/{incident_id}/comments",
    response_model=DoorIncidentDetailOut,
)
async def comment_incident(
    venue_id: int,
    event_id: int,
    incident_id: int,
    body: DoorIncidentCommentCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        row = await _assert_incident_access(cur, incident_id, venue_id, user)
        roles = user["roles"].get(venue_id, [])
        role = _role_label(roles)
        await cur.execute(
            """INSERT INTO door_incident_comments
                   (incident_id, author_id, author_role, body, channel)
               VALUES (%s, %s, %s, %s, %s)""",
            (incident_id, user["id"], role, body.body, body.channel),
        )
        await cur.execute(
            "UPDATE door_incidents SET updated_at=now() WHERE id=%s",
            (incident_id,),
        )
        title = (
            "Resultado de contacto en incidencia"
            if body.channel in ("call", "whatsapp")
            else "Respuesta en incidencia"
        )
        await _notify_incident(
            cur, row, kind="door_incident_updated", title=title,
            body=f"{user['full_name']}: {body.body[:160]}",
            actor_id=user["id"],
        )
        row = await _incident_row(cur, incident_id, venue_id)
        out = DoorIncidentDetailOut(
            **_incident_out(row, user, venue_id).model_dump(),
            comments=await _comments(cur, incident_id),
        )
        await db.commit()
    return out


@router.post(
    "/events/{event_id}/door-incidents/{incident_id}/status",
    response_model=DoorIncidentDetailOut,
)
async def update_incident_status(
    venue_id: int,
    event_id: int,
    incident_id: int,
    body: DoorIncidentStatusUpdate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "admin", "super_admin")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        row = await _assert_incident_access(cur, incident_id, venue_id, user)
        if body.status == "resolved" and not (body.guidance or "").strip():
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Para resolver, escribe la indicación concreta para Puerta.",
            )
        guidance = (body.guidance or "").strip() or None
        if body.status == "resolved":
            await cur.execute(
                """UPDATE door_incidents
                      SET status=%s, resolution_guidance=%s,
                          resolved_at=now(), resolved_by=%s,
                          status_changed_by=%s, status_changed_at=now(),
                          assigned_admin_id=COALESCE(assigned_admin_id, %s),
                          updated_at=now()
                    WHERE id=%s""",
                (body.status, guidance, user["id"], user["id"], user["id"], incident_id),
            )
        elif body.status == "reviewing":
            await cur.execute(
                """UPDATE door_incidents
                      SET status=%s, assigned_admin_id=COALESCE(assigned_admin_id, %s),
                          status_changed_by=%s, status_changed_at=now(),
                          updated_at=now()
                    WHERE id=%s""",
                (body.status, user["id"], user["id"], incident_id),
            )
        else:
            await cur.execute(
                """UPDATE door_incidents
                      SET status='open', resolution_guidance=NULL,
                          resolved_at=NULL, resolved_by=NULL,
                          status_changed_by=%s, status_changed_at=now(),
                          updated_at=now()
                    WHERE id=%s""",
                (user["id"], incident_id),
            )
        status_body = body.note or guidance or f"Estado: {body.status}"
        await cur.execute(
            """INSERT INTO door_incident_comments
                   (incident_id, author_id, author_role, body, channel)
               VALUES (%s, %s, 'admin', %s, 'status')""",
            (incident_id, user["id"], status_body),
        )
        row = await _incident_row(cur, incident_id, venue_id)
        kind = "door_incident_resolved" if body.status == "resolved" else "door_incident_updated"
        await _notify_incident(
            cur, row, kind=kind,
            title=(
                "Incidencia resuelta"
                if body.status == "resolved"
                else "Incidencia actualizada"
            ),
            body=(
                (guidance or status_body)[:220]
            ),
            actor_id=user["id"],
        )
        out = DoorIncidentDetailOut(
            **_incident_out(row, user, venue_id).model_dump(),
            comments=await _comments(cur, incident_id),
        )
        await db.commit()
    return out


@router.post(
    "/events/{event_id}/door-incidents/{incident_id}/request-promoter",
    response_model=DoorIncidentDetailOut,
)
async def request_promoter_support(
    venue_id: int,
    event_id: int,
    incident_id: int,
    body: DoorIncidentPromoterRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "admin", "super_admin")
    async with db.cursor() as cur:
        await _event_or_404(cur, venue_id, event_id)
        row = await _assert_incident_access(cur, incident_id, venue_id, user)
        promoter_id = body.promoter_id or row["promoter_id"]
        if not promoter_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Elige el promotor que debe aportar contexto.",
            )
        await cur.execute(
            """SELECT 1 FROM venue_user_roles
                WHERE venue_id=%s AND user_id=%s AND role='promotor'""",
            (venue_id, promoter_id),
        )
        if not await cur.fetchone():
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Esa persona no es promotor de la organización.",
            )
        await cur.execute(
            """UPDATE door_incidents
                  SET promoter_id=%s, promoter_access=true, status='reviewing',
                      assigned_admin_id=COALESCE(assigned_admin_id, %s),
                      status_changed_by=%s, status_changed_at=now(),
                      updated_at=now()
                WHERE id=%s""",
            (promoter_id, user["id"], user["id"], incident_id),
        )
        if body.note:
            await cur.execute(
                """INSERT INTO door_incident_comments
                       (incident_id, author_id, author_role, body, channel)
                   VALUES (%s, %s, 'admin', %s, 'note')""",
                (incident_id, user["id"], body.note),
            )
        row = await _incident_row(cur, incident_id, venue_id)
        await _notify(
            cur, promoter_id, venue_id, "door_incident_updated",
            "Administración te pidió apoyo",
            f"Caso {row['ticket_ref'] or '#' + str(row['id'])}: {row['reason']}.",
            _incident_link(row, "promotor"),
        )
        out = DoorIncidentDetailOut(
            **_incident_out(row, user, venue_id).model_dump(),
            comments=await _comments(cur, incident_id),
        )
        await db.commit()
    return out
