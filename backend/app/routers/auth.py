"""Auth: login y perfil del usuario autenticado.

El login incluye:
- Igualacion de timing: cuando el email no existe se verifica contra un hash
  dummy, para que un atacante no distinga "email inexistente" de "password
  incorrecta" por tiempo de respuesta.
- Lockout real en la DB (mig 016): 8 fallos en 15 min bloquean 15 min, con
  cubos independientes por email y por IP. Vive en Postgres porque en
  serverless la memoria de cada instancia lambda cuenta por su lado y muere
  en cada cold start: el estado compartido solo puede vivir en la DB.
"""
from secrets import token_hex
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.core.db import get_db
from app.core.security import create_access_token, hash_password, verify_password
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    ChangePasswordRequest,
    DeleteAccountRequest,
    ForgotPasswordRequest,
    LoginRequest,
    MessageOut,
    RegisterRequest,
    TokenResponse,
    UpdateProfileRequest,
    UpdateVenueRequest,
    UserSummary,
    VenueSummary,
)

router = APIRouter(prefix="/auth", tags=["auth"])

# ---------------------------------------------------------------------------
# Lockout de login (mig 016): cubos por email e IP en la DB.
# ---------------------------------------------------------------------------
_MAX_FAILURES = 8
_WINDOW_MINUTES = 15

# Hash dummy (bcrypt real) para igualar el tiempo de respuesta cuando el
# email no existe; se calcula una sola vez al importar.
_DUMMY_HASH = hash_password("equalizer-password-not-a-real-account")


async def _clear_failures(db: psycopg.AsyncConnection, email: str, ip: str) -> None:
    """El éxito limpia SOLO el par (email, ip): nadie desbloquea a otro."""
    try:
        async with db.cursor() as cur:
            await cur.execute("SELECT clear_login_failures(%s, %s)", (email, ip))
    except psycopg.Error:
        pass


def _client_ip(request: Request) -> str:
    # En Vercel la IP real llega en x-real-ip / x-forwarded-for
    fwd = request.headers.get("x-forwarded-for", "")
    return (
        request.headers.get("x-real-ip")
        or (fwd.split(",")[0].strip() if fwd else "")
        or "unknown"
    )


async def _login_locked(db: psycopg.AsyncConnection, email: str, ip: str) -> bool:
    """¿Este intento está bloqueado? Consulta en la DB (compartida entre
    instancias serverless). Si la DB falla, se permite el intento: el lockout
    es defensa en profundidad, nunca una llave que deje fuera a los usuarios
    legitimos por un incidente de infraestructura."""
    try:
        async with db.cursor() as cur:
            await cur.execute(
                "SELECT login_locked(%s, %s, %s, %s) AS locked",
                (email, ip, _MAX_FAILURES, _WINDOW_MINUTES),
            )
            return (await cur.fetchone())["locked"]
    except psycopg.Error:
        return False


async def _register_failure(db: psycopg.AsyncConnection, email: str, ip: str) -> None:
    """Registra el fallo y poda la ventana vieja (mismo statement de poda en
    cada fallo: sin cron en serverless, la tabla se autolimite)."""
    try:
        async with db.cursor() as cur:
            await cur.execute("SELECT register_login_failure(%s, %s)", (email, ip))
            await cur.execute("SELECT prune_login_attempts(60)")
    except psycopg.Error:
        pass  # un fallo de auditoría no debe ocultar el 401 real


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
                   v.commission_pct, vr.role
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
                commission_pct=float(row["commission_pct"] or 0),
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
    ip = _client_ip(request)
    email_norm = body.email.strip().lower()
    if await _login_locked(db, email_norm, ip):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo.",
        )

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id, email, full_name, password_hash, is_active, last_login_at FROM users WHERE lower(email)=lower(%s)",
            (body.email,),
        )
        user = await cur.fetchone()

    if not user:
        # igualar timing del bcrypt antes de rechazar
        verify_password(body.password, _DUMMY_HASH)
        await _register_failure(db, email_norm, ip)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Credenciales invalidas")
    if not verify_password(body.password, user["password_hash"]):
        await _register_failure(db, email_norm, ip)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Credenciales invalidas")
    if not user["is_active"]:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuario inactivo")

    await _clear_failures(db, email_norm, ip)  # éxito limpia solo este par

    # Último acceso exitoso (mig 009): alimenta la actividad del módulo Equipo.
    await db.execute(
        "UPDATE users SET last_login_at = now() WHERE id = %s", (user["id"],)
    )

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


# ---------------------------------------------------------------------------
# Registro self-service: el dueño crea su negocio y su cuenta de admin
# ---------------------------------------------------------------------------
def _slugify(name: str) -> str:
    import re
    import unicodedata

    s = unicodedata.normalize("NFKD", name.lower()).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "venue"


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Crea una venue nueva con su administrador y devuelve la sesión.

    Rate-limited con el lockout en DB (mig 016, cubo por IP con email
    sentinel): es un endpoint público que crea filas, sin límite sería un
    vector de basura en la DB."""
    ip = _client_ip(request)
    if await _login_locked(db, "__register__", ip):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Demasiados intentos. Espera unos minutos.",
        )
    await _register_failure(db, "__register__", ip)  # el éxito lo deja así

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT id FROM users WHERE lower(email)=lower(%s)", (body.email,)
        )
        if await cur.fetchone():
            await _register_failure(db, "__register__", ip)
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Ese email ya tiene una cuenta. Inicia sesión o usa otro.",
            )

        # Venue con slug único (colisión -> sufijo corto aleatorio)
        base_slug = _slugify(body.venue_name)
        slug = base_slug
        for _ in range(5):
            await cur.execute("SELECT id FROM venues WHERE slug=%s", (slug,))
            if not await cur.fetchone():
                break
            slug = f"{base_slug}-{token_hex(2)}"
        await cur.execute(
            """INSERT INTO venues (name, slug) VALUES (%s, %s) RETURNING id""",
            (body.venue_name.strip(), slug),
        )
        venue_id = (await cur.fetchone())["id"]

        await cur.execute(
            """INSERT INTO users (email, password_hash, full_name)
               VALUES (%s, %s, %s) RETURNING id""",
            (body.email, hash_password(body.password), body.full_name.strip()),
        )
        user_id = (await cur.fetchone())["id"]

        await cur.execute(
            "INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (%s, %s, 'admin')",
            (venue_id, user_id),
        )
        await db.commit()

    roles = {str(venue_id): ["admin"]}
    token = create_access_token(user_id, [venue_id], roles)
    summary = await _build_user_summary(db, user_id)
    return TokenResponse(access_token=token, user=summary)


# ---------------------------------------------------------------------------
# Recuperación de contraseña (sin proveedor de email aún)
# ---------------------------------------------------------------------------
@router.post("/forgot-password", response_model=MessageOut)
async def forgot_password(
    body: ForgotPasswordRequest,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Responde SIEMPRE lo mismo (no revela qué emails existen).

    Sin proveedor de email configurado, orienta al usuario: self-service de
    venue (registro) o reset operado por un admin de su venue.
    """
    async with db.cursor() as cur:
        await cur.execute(
            """SELECT u.is_active
               FROM users u
               JOIN venue_user_roles vr ON vr.user_id = u.id
               WHERE lower(u.email)=lower(%s)
               LIMIT 1""",
            (body.email,),
        )
        row = await cur.fetchone()
    hint = (
        "Tu cuenta está desactivada: pide a un administrador de tu negocio "
        "que la reactive."
        if row and not row["is_active"]
        else "Si el email existe, un administrador puede reestablecer tu "
        "contraseña desde Equipo, o crea un negocio nuevo desde 'Crear cuenta'."
    )
    return MessageOut(detail=hint)


# ---------------------------------------------------------------------------
# Edición del perfil propio y del negocio (venue)
# ---------------------------------------------------------------------------
@router.patch("/profile", response_model=UserSummary)
async def update_profile(
    body: UpdateProfileRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Actualiza el nombre visible del usuario autenticado."""
    async with db.cursor() as cur:
        await cur.execute(
            "UPDATE users SET full_name=%s WHERE id=%s",
            (body.full_name.strip(), user["id"]),
        )
        await db.commit()
    return await _build_user_summary(db, user["id"])


@router.patch("/venues/{venue_id}", response_model=VenueSummary)
async def update_venue_settings(
    venue_id: int,
    body: UpdateVenueRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Nombre y logo del negocio (solo admin de la venue).

    PATCH parcial: solo aplica los campos enviados. logo_url="" limpia el
    logo (queda NULL). El logo se referencía por URL (http/s); no hay
    almacenamiento de archivos propio todavía."""
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute("SELECT id FROM venues WHERE id=%s", (venue_id,))
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Venue no encontrada")

        if body.name is not None:
            await cur.execute(
                "UPDATE venues SET name=%s WHERE id=%s",
                (body.name.strip(), venue_id),
            )
        if body.logo_url is not None:
            await cur.execute(
                "UPDATE venues SET logo_url=%s WHERE id=%s",
                (body.logo_url.strip() or None, venue_id),
            )
        if body.commission_pct is not None:
            await cur.execute(
                "UPDATE venues SET commission_pct=%s WHERE id=%s",
                (body.commission_pct, venue_id),
            )
        await db.commit()

        await cur.execute(
            """SELECT id, name, slug, logo_url, primary_color, commission_pct
               FROM venues WHERE id=%s""",
            (venue_id,),
        )
        row = await cur.fetchone()
    return VenueSummary(
        id=row["id"],
        name=row["name"],
        slug=row["slug"],
        logo_url=row["logo_url"],
        primary_color=row["primary_color"],
        commission_pct=float(row["commission_pct"] or 0),
    )


# ---------------------------------------------------------------------------
# Cambio de contraseña propia (autenticado)
# ---------------------------------------------------------------------------
@router.post("/change-password", response_model=MessageOut)
async def change_password(
    body: ChangePasswordRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Cambia la contraseña del usuario autenticado.

    Exige la contraseña vigente (protege sesiones dejadas abiertas: quien
    solo robaría el token no podría cerrar al dueño de su cuenta). La nueva
    debe ser distinta de la actual."""
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT password_hash FROM users WHERE id=%s", (user["id"],)
        )
        row = await cur.fetchone()
        if not row or not verify_password(
            body.current_password, row["password_hash"]
        ):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "La contraseña actual no es correcta.",
            )
        if verify_password(body.new_password, row["password_hash"]):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "La nueva contraseña debe ser distinta de la actual.",
            )
        await cur.execute(
            "UPDATE users SET password_hash=%s WHERE id=%s",
            (hash_password(body.new_password), user["id"]),
        )
        await db.commit()
    return MessageOut(detail="Contraseña actualizada.")


# ---------------------------------------------------------------------------
# Borrado definitivo de la propia cuenta
# ---------------------------------------------------------------------------
@router.delete("/account", response_model=MessageOut)
async def delete_own_account(
    body: DeleteAccountRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Elimina la cuenta y sus membresías. Sola, o con toda la venue si es
    admin único. Pide la contraseña: confirmación fuerte e irrevocable."""
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT password_hash FROM users WHERE id=%s", (user["id"],)
        )
        row = await cur.fetchone()
        if not row or not verify_password(body.password, row["password_hash"]):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Contraseña incorrecta")

        await cur.execute(
            "SELECT venue_id FROM venue_user_roles WHERE user_id=%s",
            (user["id"],),
        )
        venue_ids = [r["venue_id"] for r in await cur.fetchall()]

        for vid in venue_ids:
            await cur.execute(
                """SELECT count(*)::int AS n FROM venue_user_roles
                   WHERE venue_id=%s AND role='admin'""",
                (vid,),
            )
            admins = (await cur.fetchone())["n"]
            await cur.execute(
                "SELECT count(*)::int AS n FROM venue_user_roles WHERE venue_id=%s",
                (vid,),
            )
            members = (await cur.fetchone())["n"]
            if admins == 1 and members > 1:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Eres el único administrador con miembros activos en tu "
                    "negocio: asígnale otro admin antes de borrar tu cuenta.",
                )

        await cur.execute(
            """SELECT venue_id FROM venue_user_roles
               WHERE venue_id = ANY(%s) AND user_id <> %s""",
            (venue_ids or [0], user["id"]),
        )
        protected = {r["venue_id"] for r in await cur.fetchall()}
        doomed = [v for v in venue_ids if v not in protected]
        if doomed:
            # events/tickets de la venue cascada vía FK ON DELETE CASCADE
            await cur.execute("DELETE FROM venues WHERE id = ANY(%s)", (doomed,))
        await cur.execute("DELETE FROM users WHERE id=%s", (user["id"],))
        await db.commit()
    return MessageOut(detail="Cuenta eliminada definitivamente.")


# ---------------------------------------------------------------------------
# NOTA: la purga definitiva de un usuario vive en lifecycle.py (rutas de
# gestión del equipo, prefijo /venues/{venue_id}).
# ---------------------------------------------------------------------------