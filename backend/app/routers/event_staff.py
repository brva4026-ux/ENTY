"""Personal POR EVENTO: quién trabaja cada noche y el link de su puerta.

Por qué este módulo existe (el problema real, no el imaginado):

Hoy el equipo pertenece a la VENUE (venue_user_roles) y el bouncer abre
/escaner y elige el evento de un selector. De ahí salen dos fallas:

1) "Quién trabaja esta noche" no existe. Cualquier bouncer del bar puede
   escanear cualquier evento, incluidas noches que ya pasaron. No hay forma
   de decir "esta persona solo trabaja la noche del 14".
2) En la puerta, elegir la noche correcta con un dedo sin contexto es un
   touch equivocado esperando: boletas del otro evento.

Qué resuelve este módulo:

- GET/POST/DELETE .../events/{id}/staff — el roster de la noche: quién está
  y con qué rol (bouncer = puerta, promotor = venta). El admin del bar no
  necesita listarse: siempre puede entrar a su evento.
- POST .../events/{id}/staff/{uid}/link — genera el link de puerta con el
  EVENTO YA FIJO. Es la diferencia entre "elegí la noche" y "esta noche es
  esta".
- GET /escaner/acceso?token= — canje del link. El token es de 192 bits y en
  la DB solo vive su SHA-256: un volcado de la base no produce links
  válidos. Es de un solo uso para el PRIMER canje y queda ligado al
  usuario para siempre.

Lo que el link NO es: no es una credencial de administración. No da caja,
ni reportes, ni el roster, ni el catálogo del bar. Autorizar un canje de
boletas sigue dependiendo del rol a nivel venue, igual que antes; lo que
cambia es que la persona queda atada a UNA noche en vez de elegir entre
todas.
"""
import hashlib
from datetime import timedelta
from secrets import token_urlsafe
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.db import get_db
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    EventAccessGranted,
    EventAccessOut,
    EventAccessPreview,
    EventStaffCreate,
    EventStaffOut,
)

router = APIRouter(tags=["personal-por-evento"])

_TOKEN_BYTES = 24  # 192 bits: la misma entropía que el QR de la boleta
_LINK_HOURS = 72  # el link se emite cerca de la noche, no meses antes


def _hash_token(raw: str) -> str:
    """SHA-256 para la DB: el token en claro nunca se persiste."""
    return hashlib.sha256(raw.encode()).hexdigest()


async def _assert_event(venue_id: int, event_id: int, db) -> dict:
    """El evento tiene que ser DE ESTA venue (no confiar en el id solo)."""
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, name, status, starts_at FROM events WHERE id = %s AND venue_id = %s",
            (event_id, venue_id),
        )
        ev = await cur.fetchone()
    if not ev:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ese evento no existe")
    return ev


async def _assert_venue_admin(venue_id: int, user: dict) -> None:
    ensure_roles(user, venue_id, "super_admin", "admin")
    if venue_id not in user["venue_ids"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No perteneces a esta venue")


# ---------------------------------------------------------------------------
# El roster de la noche
# ---------------------------------------------------------------------------
@router.get("/venues/{venue_id}/events/{event_id}/staff", response_model=list[EventStaffOut])
async def list_event_staff(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Quién trabaja esta noche. Admin siempre puede verlo."""
    await _assert_venue_admin(venue_id, user)
    await _assert_event(venue_id, event_id, db)

    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT s.id, s.user_id, u.full_name, u.email, s.role,
                   s.shift_start, s.shift_end, s.created_at,
                   t.id IS NOT NULL AS has_link
            FROM event_staff s
            JOIN users u ON u.id = s.user_id
            LEFT JOIN event_access_tokens t
                   ON t.event_id = s.event_id AND t.user_id = s.user_id
                  AND t.used_at IS NULL AND t.revoked_at IS NULL
            WHERE s.event_id = %s
            ORDER BY s.role, u.full_name
            """,
            (event_id,),
        )
        rows = await cur.fetchall()
    return [EventStaffOut(**r) for r in rows]


@router.post(
    "/venues/{venue_id}/events/{event_id}/staff",
    response_model=EventStaffOut,
    status_code=status.HTTP_201_CREATED,
)
async def assign_event_staff(
    venue_id: int,
    event_id: int,
    body: EventStaffCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Asigna a una persona a ESTA noche con un rol de esta noche."""
    await _assert_venue_admin(venue_id, user)
    ev = await _assert_event(venue_id, event_id, db)
    if ev["status"] == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, "Ese evento está cancelado")

    async with db.cursor() as cur:
        # La persona tiene que ser del bar: asignar a un desconocido dejaría
        # una fila que nadie puede abrir (nadie tiene cuenta).
        await cur.execute(
            """
            SELECT u.id, u.full_name, u.email
            FROM users u
            JOIN venue_user_roles r ON r.user_id = u.id
            WHERE r.venue_id = %s AND u.id = %s AND u.is_active
            """,
            (venue_id, body.user_id),
        )
        member = await cur.fetchone()
        if not member:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Esa persona no es parte de tu equipo. Invítala primero.",
            )

        # Reasignar el rol es la operación normal ("cambió de puesto esta
        # noche"), no un error: se actualiza la fila.
        await cur.execute(
            """
            INSERT INTO event_staff (event_id, user_id, role, shift_start, shift_end, assigned_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (event_id, user_id) DO UPDATE
                SET role = EXCLUDED.role,
                    shift_start = EXCLUDED.shift_start,
                    shift_end = EXCLUDED.shift_end
            RETURNING id, created_at
            """,
            (event_id, body.user_id, body.role, body.shift_start, body.shift_end, user["id"]),
        )
        saved = await cur.fetchone()
        await db.commit()

    return EventStaffOut(
        id=saved["id"],
        user_id=body.user_id,
        full_name=member["full_name"],
        email=member["email"],
        role=body.role,
        shift_start=body.shift_start,
        shift_end=body.shift_end,
        created_at=saved["created_at"],
        has_link=False,
    )


@router.delete(
    "/venues/{venue_id}/events/{event_id}/staff/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_event_staff(
    venue_id: int,
    event_id: int,
    user_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Saca a la persona de la noche. Se lleva sus links con ella.

    Los links se BORRAN en vez de revocarse a mano: si ya no trabaja esa
    noche, un link vivo es una puerta abierta para alguien que el admin
    acaba de sacar del roster.
    """
    await _assert_venue_admin(venue_id, user)
    await _assert_event(venue_id, event_id, db)

    async with db.cursor() as cur:
        await cur.execute(
            "DELETE FROM event_access_tokens WHERE event_id = %s AND user_id = %s",
            (event_id, user_id),
        )
        await cur.execute(
            "DELETE FROM event_staff WHERE event_id = %s AND user_id = %s RETURNING id",
            (event_id, user_id),
        )
        if not await cur.fetchone():
            await db.rollback()
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Esa persona no estaba en la noche")
        await db.commit()
    return None


# ---------------------------------------------------------------------------
# El link de la puerta, con el evento ya fijo
# ---------------------------------------------------------------------------
@router.post(
    "/venues/{venue_id}/events/{event_id}/staff/{user_id}/link",
    response_model=EventAccessOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_event_link(
    venue_id: int,
    event_id: int,
    user_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Emite (o rota) el link de puerta de esa persona para esa noche.

    El token en claro viaja SOLO en esta respuesta. Generarlo de nuevo mata
    el anterior: es la rotación, no un segundo link vivo.
    """
    await _assert_venue_admin(venue_id, user)
    ev = await _assert_event(venue_id, event_id, db)

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM event_staff WHERE event_id = %s AND user_id = %s",
            (event_id, user_id),
        )
        if not await cur.fetchone():
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Asigná esa persona a la noche antes de generar su link.",
            )

        raw = token_urlsafe(_TOKEN_BYTES)
        # El índice único parcial (event_id, user_id) WHERE vigente obliga a
        # revocar el anterior en la misma transacción.
        await cur.execute(
            """
            UPDATE event_access_tokens SET revoked_at = now()
            WHERE event_id = %s AND user_id = %s
              AND used_at IS NULL AND revoked_at IS NULL
            """,
            (event_id, user_id),
        )
        await cur.execute(
            """
            INSERT INTO event_access_tokens (event_id, user_id, token_hash, expires_at, created_by)
            VALUES (%s, %s, %s, now() + %s, %s)
            RETURNING id, expires_at, created_at
            """,
            (event_id, user_id, _hash_token(raw), timedelta(hours=_LINK_HOURS), user["id"]),
        )
        row = await cur.fetchone()
        await db.commit()

    return EventAccessOut(
        id=row["id"],
        event_id=event_id,
        event_name=ev["name"],
        user_id=user_id,
        access_url=f"/puerta?token={raw}",
        expires_at=row["expires_at"],
        created_at=row["created_at"],
    )


@router.get("/escaner/acceso", response_model=EventAccessPreview)
async def preview_event_access(
    token: str,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Mira el link sin canjearlo: "Entrás a la puerta de Noche Electrónica".

    Es el equivalente a la vista previa de la invitación. No consume el
    token: la persona tiene que ver a qué noche entra ANTES de confirmar.
    """
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT t.id, t.event_id, t.user_id, t.expires_at, t.used_at, t.revoked_at,
                   e.name, e.status, e.starts_at, u.full_name
            FROM event_access_tokens t
            JOIN events e ON e.id = t.event_id
            JOIN users  u ON u.id = t.user_id
            WHERE t.token_hash = %s
            """,
            (_hash_token(token),),
        )
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ese link no existe")

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT venue_id FROM venue_user_roles WHERE user_id = %s LIMIT 1",
            (row["user_id"],),
        )
        mine = await cur.fetchone()

    if not mine:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Ese link ya no pertenece a tu equipo")

    return EventAccessPreview(
        event_id=row["event_id"],
        event_name=row["name"],
        event_status=row["status"],
        starts_at=row["starts_at"],
        full_name=row["full_name"],
        expires_at=row["expires_at"],
        used=bool(row["used_at"]),
        revoked=bool(row["revoked_at"]),
    )


@router.post("/escaner/acceso", response_model=EventAccessGranted)
async def redeem_event_access(
    token: str,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Canjea el link: liga a la persona con UNA noche y devuelve el JWT.

    Canje atómico de un solo uso: el UPDATE lleva la condición de "no usado",
    así que dos pestañas compitiendo por el mismo link no lo hacen válido
    dos veces.
    """
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT t.id, t.event_id, t.user_id
            FROM event_access_tokens t
            WHERE t.token_hash = %s
              AND t.user_id = %s
              AND t.used_at IS NULL
              AND t.revoked_at IS NULL
              AND t.expires_at > now()
            """,
            (_hash_token(token), user["id"]),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(
                status.HTTP_410_GONE,
                "Ese link venció, ya se usó o se emitió para otra persona.",
            )

        await cur.execute(
            """
            UPDATE event_access_tokens SET used_at = now()
            WHERE id = %s AND used_at IS NULL RETURNING id
            """,
            (row["id"],),
        )
        if not await cur.fetchone():
            await db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, "Ese link ya se usó")
        await db.commit()

    return EventAccessGranted(event_id=row["event_id"])