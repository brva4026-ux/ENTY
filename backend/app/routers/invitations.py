"""Invitaciones de personal por enlace de un solo uso (patrón unicall-blue).

El admin genera un enlace para una persona concreta; el invitado abre la
página, define SU contraseña y queda dentro. El admin nunca conoce (ni
inventa) la contraseña del equipo.

Disciplina de seguridad, adaptada de unicall-blue a nuestra API única:
- El token en claro se muestra UNA vez (respuesta de creación) y se envía
  por el canal que el admin prefiera; en la DB solo vive su hash SHA-256,
  así que un volcado de base de datos no produce enlaces válidos.
- Canje atómico de un solo uso: UPDATE ... WHERE token_hash=%s AND
  accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now(). Dos
  pestañas compiten por el mismo UPDATE; solo una gana.
- El email va ligado: el token no sirve con otro correo (evita que un
  enlace reenviado registre a alguien distinto).
- Rate-limit público en el canje (reutiliza el mecanismo de /auth/register):
  es un endpoint anónimo que crea filas.
- Reutilización de email existente (recontratación): se agrega el rol, se
  reactiva la cuenta y se fija la contraseña elegida en el formulario (quien
  controla el email invitado demostró identidad -> equivale a reset por
  enlace). Nada de cuentas duplicadas.
"""
import hashlib
from datetime import timedelta
from secrets import token_urlsafe
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.core.db import get_db
from app.core.security import create_access_token, hash_password
from app.deps import ensure_roles, get_current_user
from app.routers.auth import _client_ip, _login_locked, _register_failure
from app.schemas import (
    AcceptInvitationRequest,
    InvitationPreview,
    StaffInvitationCreated,
    StaffInvitationCreate,
    StaffInvitationOut,
    TokenResponse,
)

router = APIRouter(prefix="/auth", tags=["invitaciones"])

_TOKEN_BYTES = 32  # 256 bits de entropía -> impossible de adivinar


def _hash_token(raw: str) -> str:
    """Hash del token para la DB (SHA-256: rápido, no es un secreto largo)."""
    return hashlib.sha256(raw.encode()).hexdigest()


def _expired_cond() -> str:
    return "revoked_at IS NULL AND accepted_at IS NULL AND expires_at > now()"


# ---------------------------------------------------------------------------
# Admin: crear invitación (devuelve el enlace UNA vez)
# ---------------------------------------------------------------------------
@router.post(
    "/venues/{venue_id}/invitations",
    response_model=StaffInvitationCreated,
    status_code=status.HTTP_201_CREATED,
)
async def create_invitation(
    venue_id: int,
    body: StaffInvitationCreate,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    if venue_id not in user["venue_ids"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No perteneces a esta venue")

    email = body.email.strip()
    raw_token = token_urlsafe(_TOKEN_BYTES)
    expires = timedelta(hours=body.expires_hours)

    async with db.cursor() as cur:
        # Email de un miembro activo del equipo: no tiene sentido invitarlo.
        await cur.execute(
            """
            SELECT 1
            FROM users u
            JOIN venue_user_roles r ON r.user_id = u.id
            WHERE lower(u.email) = lower(%s) AND r.venue_id = %s AND u.is_active
            LIMIT 1
            """,
            (email, venue_id),
        )
        if await cur.fetchone():
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Esa persona ya es parte de tu equipo.",
            )

        await cur.execute(
            """
            INSERT INTO staff_invitations
                (venue_id, role, full_name, email, token_hash, expires_at, created_by)
            VALUES (%s, %s, %s, %s, %s, now() + %s, %s)
            RETURNING id, role, full_name, email, expires_at, created_at
            """,
            (venue_id, body.role, body.full_name.strip(), email,
             _hash_token(raw_token), expires, user["id"]),
        )
        row = await cur.fetchone()
        await db.commit()

    return StaffInvitationCreated(
        invite_url=f"/invitacion?token={raw_token}",
        **row,
    )


# ---------------------------------------------------------------------------
# Admin: listar invitaciones (para ver vigentes/canjeadas y copiar estado)
# ---------------------------------------------------------------------------
@router.get(
    "/venues/{venue_id}/invitations",
    response_model=list[StaffInvitationOut],
)
async def list_invitations(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    if venue_id not in user["venue_ids"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No perteneces a esta venue")
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT id, role, full_name, email, expires_at, created_at,
                   accepted_at, revoked_at
            FROM staff_invitations
            WHERE venue_id = %s
            ORDER BY created_at DESC
            LIMIT 100
            """,
            (venue_id,),
        )
        return await cur.fetchall()


# ---------------------------------------------------------------------------
# Admin: revocar (un enlace filtrado deja de servir con un clic)
# ---------------------------------------------------------------------------
@router.delete(
    "/venues/{venue_id}/invitations/{invitation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def revoke_invitation(
    venue_id: int,
    invitation_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ensure_roles(user, venue_id, "super_admin", "admin")
    if venue_id not in user["venue_ids"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No perteneces a esta venue")
    async with db.cursor() as cur:
        await cur.execute(
            """
            UPDATE staff_invitations
            SET revoked_at = now()
            WHERE id = %s AND venue_id = %s AND accepted_at IS NULL
              AND revoked_at IS NULL
            """,
            (invitation_id, venue_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "La invitación ya fue canjeada, revocada o no existe.",
            )
        await db.commit()


# ---------------------------------------------------------------------------
# Público: previsualizar (lo mínimo para confiar en el enlace)
# ---------------------------------------------------------------------------
@router.get("/invitations/preview", response_model=InvitationPreview)
async def invitation_preview(
    token: str,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    async with db.cursor() as cur:
        await cur.execute(
            f"""
            SELECT i.role, i.full_name, i.expires_at, v.name AS venue_name
            FROM staff_invitations i
            JOIN venues v ON v.id = i.venue_id
            WHERE i.token_hash = %s AND {_expired_cond()}
            """,
            (_hash_token(token),),
        )
        row = await cur.fetchone()
    if not row:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Este enlace no es válido: expiró, fue revocado o ya se usó.",
        )
    return row


# ---------------------------------------------------------------------------
# Público: canje (un solo uso, atómico). Crea la sesión igual que /register.
# ---------------------------------------------------------------------------
@router.post("/invitations/accept", response_model=TokenResponse)
async def accept_invitation(
    body: AcceptInvitationRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    # Lockout en DB (mig 016): cubo por IP con email sentinel. Cada intento
    # de canje cuenta como fallo; el éxito está en el UPDATE que sigue (el
    # token válido canjea aunque el cubo tenga entradas, no hay login que
    # "limpiar" — la ventana de 15 min se agota sola).
    ip = _client_ip(request)
    if await _login_locked(db, "__invite__", ip):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Demasiados intentos. Espera unos minutos.",
        )
    await _register_failure(db, "__invite__", ip)

    async with db.cursor() as cur:
        # Concurrencia segura: el UPDATE solo gana una vez por token. Sin
        # SELECT previo: la condición WHERE es la fuente de verdad.
        await cur.execute(
            f"""
            UPDATE staff_invitations
            SET accepted_at = now()
            WHERE token_hash = %s AND {_expired_cond()}
            RETURNING id, venue_id, role, email, full_name
            """,
            (_hash_token(body.token),),
        )
        inv = await cur.fetchone()
        if not inv:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Este enlace no es válido: expiró, fue revocado o ya se usó.",
            )

        # El enlace pertenece a un email concreto: no se canjea con otro.
        await cur.execute(
            "SELECT id, is_active FROM users WHERE lower(email) = lower(%s)",
            (inv["email"],),
        )
        existing = await cur.fetchone()
        if existing:
            user_id = existing["id"]
            # Recontratación: la persona demostró control del enlace que
            # llegó a SU email -> fija la contraseña que acaba de elegir
            # (equivale a un reset por enlace) y recupera el acceso.
            await cur.execute(
                """UPDATE users SET password_hash = %s, is_active = true,
                   last_login_at = now() WHERE id = %s""",
                (hash_password(body.password), user_id),
            )
        else:
            await cur.execute(
                """
                INSERT INTO users (email, password_hash, full_name, last_login_at)
                VALUES (%s, %s, %s, now()) RETURNING id
                """,
                (inv["email"], hash_password(body.password), inv["full_name"]),
            )
            user_id = (await cur.fetchone())["id"]

        await cur.execute(
            """
            INSERT INTO venue_user_roles (venue_id, user_id, role)
            VALUES (%s, %s, %s)
            ON CONFLICT DO NOTHING
            """,
            (inv["venue_id"], user_id, inv["role"]),
        )
        # Registrar QUIEN acepto (la columna quedaba NULL siempre): el trigger
        # de notificaciones (mig 012) dispara sobre este UPDATE y el historial
        # de invitaciones queda trazable por usuario, no solo por email.
        await cur.execute(
            "UPDATE staff_invitations SET accepted_user_id = %s WHERE id = %s",
            (user_id, inv["id"]),
        )
        await db.commit()

    from app.routers.auth import _build_user_summary

    roles = {str(inv["venue_id"]): [inv["role"]]}
    token = create_access_token(user_id, [inv["venue_id"]], roles)
    summary = await _build_user_summary(db, user_id)
    return TokenResponse(access_token=token, user=summary)
