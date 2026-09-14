"""Auth: login y perfil del usuario autenticado.

El login incluye:
- Igualacion de timing: cuando el email no existe se verifica contra un hash
  dummy, para que un atacante no distinga "email inexistente" de "password
  incorrecta" por tiempo de respuesta.
- Rate limit en memoria por IP+email: tras varios fallos consecutivos responde
  429 durante una ventana. Es best-effort en serverless (por instancia); la
  medida fuerte seria un contador en la DB.
"""
from collections import defaultdict, deque
from time import monotonic
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.core.db import get_db
from app.core.security import create_access_token, hash_password, verify_password
from app.deps import get_current_user
from app.schemas import LoginRequest, TokenResponse, UserSummary, VenueSummary

router = APIRouter(prefix="/auth", tags=["auth"])

# ---------------------------------------------------------------------------
# Rate limit de login (en memoria, best-effort)
# ---------------------------------------------------------------------------
_MAX_FAILURES = 8
_WINDOW_SECONDS = 300.0
_FAILURES: dict[str, deque[float]] = defaultdict(deque)

# Hash dummy (bcrypt real) para igualar el tiempo de respuesta cuando el
# email no existe; se calcula una sola vez al importar.
_DUMMY_HASH = hash_password("equalizer-password-not-a-real-account")


def _client_ip(request: Request) -> str:
    # En Vercel la IP real llega en x-real-ip / x-forwarded-for
    fwd = request.headers.get("x-forwarded-for", "")
    return (
        request.headers.get("x-real-ip")
        or (fwd.split(",")[0].strip() if fwd else "")
        or "unknown"
    )


def _login_blocked(key: str) -> bool:
    q = _FAILURES[key]
    now = monotonic()
    while q and now - q[0] > _WINDOW_SECONDS:
        q.popleft()
    return len(q) >= _MAX_FAILURES


def _register_failure(key: str) -> None:
    q = _FAILURES[key]
    q.append(monotonic())
    # limpiar claves viejas para no crecer sin limite
    if len(_FAILURES) > 10_000:
        now = monotonic()
        for k in [k for k, v in _FAILURES.items() if not v or now - v[-1] > _WINDOW_SECONDS]:
            _FAILURES.pop(k, None)


async def _build_user_summary(db: psycopg.AsyncConnection, user_id: int) -> UserSummary:
    """Carga datos del usuario + venues a las que pertenece + sus roles."""
    roles_rows: list[dict] = []
    user: dict | None = None
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, email, full_name FROM users WHERE id=%s", (user_id,)
        )
        user = await cur.fetchone()

        await cur.execute(
            """
            SELECT v.id AS venue_id, v.name, v.slug, v.logo_url, v.primary_color,
                   vr.role
            FROM venue_user_roles vr
            JOIN venues v ON v.id = vr.venue_id
            WHERE vr.user_id = %s
            """,
            (user_id,),
        )
        roles_rows = await cur.fetchall()

    venues: dict[int, VenueSummary] = {}
    roles_by_venue: dict[str, list[str]] = {}
    for row in roles_rows:
        venue_id = row["venue_id"]
        if venue_id not in venues:
            venues[venue_id] = VenueSummary(
                id=venue_id, name=row["name"], slug=row["slug"],
                logo_url=row["logo_url"], primary_color=row["primary_color"],
            )
        roles_by_venue[str(venue_id)] = roles_by_venue.get(str(venue_id), []) + [row["role"]]

    return UserSummary(
        id=user["id"],
        email=user["email"],
        full_name=user["full_name"],
        venues=list(venues.values()),
        roles=roles_by_venue,
    )


@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    key = f"{_client_ip(request)}:{body.email.lower()}"
    if _login_blocked(key):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Demasiados intentos fallidos. Espera unos minutos.",
        )

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, email, full_name, password_hash, is_active FROM users WHERE lower(email)=lower(%s)",
            (body.email,),
        )
        user = await cur.fetchone()

    if not user:
        # igualar timing del bcrypt antes de rechazar
        verify_password(body.password, _DUMMY_HASH)
        _register_failure(key)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Credenciales invalidas")
    if not verify_password(body.password, user["password_hash"]):
        _register_failure(key)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Credenciales invalidas")
    if not user["is_active"]:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuario inactivo")

    _FAILURES.pop(key, None)  # exito limpia el contador

    # venues + roles del usuario para el JWT
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT venue_id, role FROM venue_user_roles WHERE user_id=%s", (user["id"],)
        )
        rows = await cur.fetchall()
    venue_ids = [r["venue_id"] for r in rows]
    roles = {str(r["venue_id"]): [] for r in rows}
    for r in rows:
        roles[str(r["venue_id"])].append(r["role"])

    token = create_access_token(user["id"], venue_ids, roles)
    summary = await _build_user_summary(db, user["id"])
    return TokenResponse(access_token=token, user=summary)


@router.get("/me", response_model=UserSummary)
async def me(
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    return await _build_user_summary(db, user["id"])