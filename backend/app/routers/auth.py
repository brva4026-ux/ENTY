"""Auth: login y perfil del usuario autenticado.

El login incluye:
- Igualacion de timing: cuando el email no existe se verifica contra un hash
  dummy, para que un atacante no distinga "email inexistente" de "password
  incorrecta" por tiempo de respuesta.
- Lockout real en la DB (mig 016): 8 fallos en 15 min bloquean 15 min, con
  cubos independientes por email y por IP. Vive en Postgres porque en
  serverless la memoria de cada instancia lambda cuenta por su lado y muere
  en cada cold start: el estado compartido solo puede vivir en la DB.
- Reset self-service (mig 017): forgot-password crea un token de un solo uso
  (hash en DB, crudo solo en el correo) y reset-password lo canjea.
"""
import hashlib
from datetime import datetime, timezone
from secrets import token_hex
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from starlette.concurrency import run_in_threadpool

from app.core.config import get_settings
from app.core.db import get_db
from app.core.mailer import Mailer
from app.core.observability import log_security_event
from app.core.security import create_access_token, hash_password, verify_password
from app.core.session import (
    COOKIE_NAME,
    check_session_origin,
    session_response,
    set_session_cookie,
)
from app.core.usernames import (
    is_valid_username,
    normalize_username,
    username_base,
    username_candidates,
)
from app.deps import ensure_roles, get_current_user

# El catalogo y el registro de aceptaciones legales (mig 026) viven en el
# router legal: se importan las funciones, no se duplica el SQL.
from app.routers.legal import (
    current_documents,
    record_acceptances,
    terms_fingerprint,
)

# El almacenamiento de imagenes ya vive en media (mig 018): el avatar reusa la
# validacion y la tabla en vez de duplicar el limite de 600 KB y los mime.
from app.routers.media import store_image
from app.schemas import (
    AvatarUpload,
    ChangeEmailRequest,
    ChangePasswordRequest,
    CloseOtherSessionsRequest,
    DeleteAccountRequest,
    DeletionBlocker,
    DeletionCheckOut,
    EmailChangeConfirmRequest,
    EmailChangeRequestOut,
    ExportDataRequest,
    ForgotPasswordRequest,
    LoginRequest,
    MessageOut,
    PreferenceKey,
    PreferenceOut,
    PreferencesOut,
    RegisterRequest,
    ResetPasswordRequest,
    RevokeSessionRequest,
    SecurityEventOut,
    SessionOut,
    SetActiveVenueRequest,
    TokenResponse,
    UpdatePreferenceRequest,
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


def _request_token(request: Request) -> str | None:
    """Token crudo de la petición: Bearer o cookie HttpOnly."""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return request.cookies.get(COOKIE_NAME)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _device_label(user_agent: str | None) -> str:
    """Etiqueta legible y honesta: navegador + sistema, sin inventar modelo."""
    ua = (user_agent or "").strip()
    if not ua:
        return "Dispositivo desconocido"
    low = ua.lower()
    browser = next(
        (
            name
            for needle, name in (
                ("edg/", "Edge"),
                ("opr/", "Opera"),
                ("chrome/", "Chrome"),
                ("firefox/", "Firefox"),
                ("safari/", "Safari"),
            )
            if needle in low
        ),
        "Navegador",
    )
    system = next(
        (
            name
            for needle, name in (
                ("iphone", "iPhone"),
                ("ipad", "iPad"),
                ("android", "Android"),
                ("windows", "Windows"),
                ("mac os", "macOS"),
                ("linux", "Linux"),
            )
            if needle in low
        ),
        "",
    )
    return f"{browser} · {system}" if system else browser


async def _register_session(
    db: psycopg.AsyncConnection,
    token: str,
    user_id: int,
    request: Request,
    ip: str | None = None,
) -> None:
    """Anota la sesión individual sin bloquear el login si la migración falta.

    El token crudo nunca se guarda: solo su SHA-256. Si la tabla aún no
    existe, el login sigue funcionando (las sesiones son una mejora del
    perfil, no la autenticación).
    """
    try:
        async with db.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO user_sessions (token_hash, user_id, user_agent, ip)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (token_hash)
                DO UPDATE SET last_seen_at = now(),
                              user_agent = EXCLUDED.user_agent
                """,
                (
                    _token_hash(token),
                    user_id,
                    (request.headers.get("user-agent") or "")[:250],
                    ip or _client_ip(request),
                ),
            )
    except psycopg.Error:
        await db.rollback()


async def _log_security(
    db: psycopg.AsyncConnection,
    user_id: int,
    kind: str,
    *,
    detail: str | None = None,
    ip: str | None = None,
) -> None:
    """Actividad de seguridad real. Best-effort: no rompe la acción principal."""
    try:
        async with db.cursor() as cur:
            await cur.execute(
                "INSERT INTO security_events (user_id, kind, detail, ip) "
                "VALUES (%s, %s, %s, %s)",
                (user_id, kind, detail, ip),
            )
    except psycopg.Error:
        await db.rollback()


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
            # `password_changed_at` (mig 037), `avatar_url` (mig 038) y
            # `active_venue_id` (mig 040) se leen como texto del jsonb de la
            # fila, no como columnas: si el codigo llega a produccion antes que
            # la migracion, `->>` devuelve NULL en vez de reventar con
            # UndefinedColumn. Un SELECT explicito de esas columnas no rompia el
            # perfil: rompia el LOGIN entero, porque todo inicio de sesion
            # termina construyendo este resumen.
            """
            SELECT u.id, u.email, u.full_name, u.username, u.phone,
                   u.created_at, u.last_login_at,
                   (to_jsonb(u) ->> 'password_changed_at') AS password_changed_at,
                   (to_jsonb(u) ->> 'avatar_url') AS avatar_url,
                   (to_jsonb(u) ->> 'active_venue_id') AS active_venue_id,
                   (to_jsonb(u) ->> 'welcome_seen_at') AS welcome_seen_at,
                   (to_jsonb(u) ->> 'contact_email') AS contact_email,
                   coalesce(
                     (to_jsonb(u) ->> 'share_contact_with_team')::boolean, false
                   ) AS share_contact_with_team,
                   (SELECT t.new_email
                      FROM email_change_tokens t
                     WHERE t.user_id = u.id
                       AND t.used_at IS NULL
                       AND t.expires_at > now()
                     ORDER BY t.created_at DESC
                     LIMIT 1) AS pending_email
              FROM users u
             WHERE u.id = %s
            """,
            (user_id,),
        )
        user = await cur.fetchone()

        await cur.execute(
            """
            SELECT v.id AS venue_id, v.name, v.slug, v.logo_url, v.primary_color,
                   v.commission_pct, v.contact_name, v.contact_phone,
                   (to_jsonb(v) ->> 'contact_email') AS contact_email,
                   coalesce(
                     (to_jsonb(v) ->> 'is_placeholder')::boolean, false
                   ) AS is_placeholder,
                   coalesce(
                     (to_jsonb(v) ->> 'contact_team_visible')::boolean, true
                   ) AS contact_team_visible,
                   coalesce(
                     (to_jsonb(v) ->> 'public_contact_enabled')::boolean, false
                   ) AS public_contact_enabled,
                   coalesce(
                     (to_jsonb(v) -> 'public_contact_channels'),
                     '[]'::jsonb
                   ) AS public_contact_channels,
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
                commission_pct=float(row["commission_pct"] or 0),
                contact_name=row["contact_name"], contact_phone=row["contact_phone"],
                contact_email=row["contact_email"],
                contact_team_visible=bool(row["contact_team_visible"]),
                public_contact_enabled=bool(row["public_contact_enabled"]),
                public_contact_channels=list(row["public_contact_channels"] or []),
                is_placeholder=bool(row["is_placeholder"]),
            )
        roles_by_venue[str(venue_id)] = [
            *roles_by_venue.get(str(venue_id), []),
            row["role"],
        ]

    return UserSummary(
        id=user["id"],
        email=user["email"],
        full_name=user["full_name"],
        username=user.get("username"),
        phone=user.get("phone"),
        contact_email=user.get("contact_email"),
        share_contact_with_team=bool(user.get("share_contact_with_team")),
        venues=list(venues.values()),
        roles=roles_by_venue,
        created_at=user["created_at"],
        last_login_at=user["last_login_at"],
        password_changed_at=user.get("password_changed_at"),
        avatar_url=user.get("avatar_url"),
        active_venue_id=user.get("active_venue_id"),
        pending_email=user.get("pending_email"),
        welcome_seen_at=user.get("welcome_seen_at"),
    )


@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    check_session_origin(request)
    ip = _client_ip(request)
    # El identificador puede ser un correo o un nombre de usuario (mig 035).
    # El @ inicial del usuario es decorativo ("@ana" == "ana"); las tildes y
    # mayusculas se normalizan igual que al crear la cuenta. La clave del
    # lockout usa la misma forma normalizada, para que "Admin", "@admin" y
    # "ADMIN" no abran cubos distintos de intentos.
    raw_ident = (body.identifier or body.email or "").strip()
    ident = raw_ident[1:] if raw_ident.startswith("@") else raw_ident
    username_ident = normalize_username(raw_ident)
    email_ident = ident.lower()
    is_email = "@" in ident
    lock_key = email_ident if is_email else username_ident
    if await _login_locked(db, lock_key, ip):
        log_security_event("login_locked", ident=lock_key, ip=ip)
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo.",
        )

    async with db.cursor() as cur:
        await cur.execute(
            # Un solo query resuelve ambos casos. La rama de username solo aplica
            # si el valor NO tiene "@": asi un correo nunca matchea un username
            # (que por formato no puede tener arroba) ni al reves.
            "SELECT id, email, full_name, password_hash, is_active, last_login_at, token_version "
            "FROM users "
            "WHERE lower(email) = %s "
            "   OR (position('@' in %s) = 0 AND username = %s)",
            (email_ident, ident, username_ident),
        )
        user = await cur.fetchone()

    if not user:
        # igualar timing del bcrypt antes de rechazar
        verify_password(body.password, _DUMMY_HASH)
        await _register_failure(db, lock_key, ip)
        log_security_event("login_failed", ident=lock_key, ip=ip, reason="no_user")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Credenciales invalidas")
    if not verify_password(body.password, user["password_hash"]):
        await _register_failure(db, lock_key, ip)
        log_security_event(
            "login_failed", ident=lock_key, ip=ip, user_id=user["id"],
            reason="bad_password",
        )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Credenciales invalidas")
    if not user["is_active"]:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuario inactivo")

    await _clear_failures(db, lock_key, ip)  # éxito limpia solo este par

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

    token = create_access_token(user["id"], venue_ids, roles, user["token_version"])
    await _register_session(db, token, user["id"], request, ip)
    summary = await _build_user_summary(db, user["id"])
    return session_response(token, summary, remember=body.remember)


@router.get("/me", response_model=UserSummary)
async def me(
    request: Request,
    response: Response,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    # Migra una sesion anterior a cookie sin pedir login otra vez.
    authorization = request.headers.get("authorization", "")
    if authorization.lower().startswith("bearer "):
        set_session_cookie(response, authorization.split(" ", 1)[1].strip())
    response.headers["Cache-Control"] = "no-store"
    return await _build_user_summary(db, user["id"])


@router.get("/username-available")
async def username_available(
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
    username: str = Query(min_length=1, max_length=64),
):
    """Disponibilidad para el editor de perfil (autenticado).

    No es un buscador público de cuentas: solo confirma si el nombre que la
    persona está eligiendo puede usarse. Devuelve también la forma normalizada
    para que la UI muestre exactamente lo que se guardaría.
    """
    candidate = normalize_username(username)
    if not is_valid_username(candidate):
        return {
            "username": candidate,
            "available": False,
            "detail": (
                "El usuario debe tener entre 3 y 32 caracteres: "
                "letras, numeros, punto, guion o guion bajo."
            ),
        }
    async with db.cursor() as cur:
        available = await _username_free(cur, candidate, user["id"])
    return {"username": candidate, "available": available}


@router.post("/welcome-seen", response_model=UserSummary)
async def mark_welcome_seen(
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Marca que la persona ya vio la bienvenida de la primera entrada.

    Best-effort respecto de la migración: si la columna aún no existe, no se
    rompe el panel; el frontend oculta la tarjeta en la sesión actual.
    """
    try:
        await db.execute(
            "UPDATE users SET welcome_seen_at = now() WHERE id=%s", (user["id"],)
        )
        await db.commit()
    except psycopg.errors.UndefinedColumn:
        await db.rollback()
    return await _build_user_summary(db, user["id"])


# ---------------------------------------------------------------------------
# Preferencias por usuario y negocio (mig 032)
# ---------------------------------------------------------------------------
# Antes vivian en localStorage, que es por NAVEGADOR: la guia rechazada en la
# laptop reaparecia en el celular, y el preview de Vercel (otro origen) no veia
# la decision de produccion. En la DB la decision es de la persona, no del
# dispositivo.
_PREFERENCE_KEYS = ("onboarding", "tutorial")


@router.get("/me/preferences", response_model=PreferencesOut)
async def get_my_preferences(
    venue_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Preferencias del usuario en un negocio.

    Devuelve SIEMPRE las claves conocidas, en `pending` cuando no hay fila: el
    panel no distingue "no existe" de "sin decidir", que para el usuario son lo
    mismo. Cualquier rol de la venue puede leer las SUYAS (son personales)."""
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT key, value, step, updated_at FROM user_preferences "
            "WHERE user_id=%s AND venue_id=%s",
            (user["id"], venue_id),
        )
        rows = {r["key"]: r for r in await cur.fetchall()}
    return PreferencesOut(
        venue_id=venue_id,
        preferences=[
            PreferenceOut(
                key=key,
                value=rows[key]["value"],
                step=rows[key]["step"] or 0,
                updated_at=rows[key]["updated_at"],
            )
            if key in rows
            else PreferenceOut(key=key)
            for key in _PREFERENCE_KEYS
        ],
    )


@router.put("/me/preferences/{key}", response_model=PreferenceOut)
async def set_my_preference(
    key: PreferenceKey,
    venue_id: int,
    body: UpdatePreferenceRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Guarda la decision (y el paso, si es el tutorial) del usuario.

    UPSERT: la primera escritura crea la fila y las siguientes la actualizan.
    La preferencia es del usuario autenticado, nunca de otro: el `user_id` sale
    del token, no del cuerpo."""
    ensure_roles(user, venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO user_preferences (user_id, venue_id, key, value, step)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (user_id, venue_id, key) DO UPDATE
               SET value = EXCLUDED.value,
                   -- El paso solo lo manda el tutorial; en las demas claves un
                   -- None del cliente NO debe borrar el progreso guardado.
                   step = COALESCE(EXCLUDED.step, user_preferences.step),
                   updated_at = now()
            RETURNING key, value, step, updated_at
            """,
            (user["id"], venue_id, key, body.value, body.step),
        )
        row = await cur.fetchone()
        await db.commit()
    return PreferenceOut(
        key=row["key"],
        value=row["value"],
        step=row["step"] or 0,
        updated_at=row["updated_at"],
    )


@router.put("/me/active-venue", response_model=UserSummary)
async def set_active_venue(
    body: SetActiveVenueRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Guarda con cuál negocio abren los paneles del staff (mig 040).

    Es una preferencia GLOBAL del usuario (no por venue): antes vivía solo en
    localStorage y el mismo admin elegía su bar en la laptop y lo perdía en el
    celular. El backend valida que el usuario tenga algún rol en ese negocio
    antes de guardarlo: un id ajeno sería un 403 en cada panel (id fantasma),
    así que no se permite escribir uno. Devuelve el resumen completo para que
    el cliente actualice su estado sin otra lectura.
    """
    ensure_roles(user, body.venue_id, "super_admin", "admin", "promotor", "bouncer")
    async with db.cursor() as cur:
        await cur.execute(
            "UPDATE users SET active_venue_id=%s WHERE id=%s",
            (body.venue_id, user["id"]),
        )
        await db.commit()
    return await _build_user_summary(db, user["id"])


# ---------------------------------------------------------------------------
# Registro self-service: la persona crea su cuenta y su espacio de trabajo
# ---------------------------------------------------------------------------
def _slugify(name: str) -> str:
    import re
    import unicodedata

    s = unicodedata.normalize("NFKD", name.lower()).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "venue"


async def _unique_venue_slug(cur: psycopg.AsyncCursor, base_slug: str) -> str:
    slug = base_slug
    for _ in range(5):
        await cur.execute("SELECT id FROM venues WHERE slug=%s", (slug,))
        if not await cur.fetchone():
            return slug
        slug = f"{base_slug}-{token_hex(2)}"
    return f"{base_slug}-{token_hex(4)}"


async def _username_free(
    cur: psycopg.AsyncCursor, candidate: str, exclude_user_id: int | None = None
) -> bool:
    await cur.execute(
        "SELECT 1 FROM users WHERE lower(username)=lower(%s) "
        "AND (%s::bigint IS NULL OR id<>%s)",
        (candidate, exclude_user_id, exclude_user_id),
    )
    return await cur.fetchone() is None


async def _next_username(
    cur: psycopg.AsyncCursor,
    base: str,
    exclude_user_id: int | None = None,
) -> str:
    """Primera variante libre para flujos que crean/reutilizan una cuenta."""
    for candidate in username_candidates(base):
        if await _username_free(cur, candidate, exclude_user_id):
            return candidate
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        "No pudimos asignar un nombre de usuario. Intenta con otro nombre.",
    )


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Crea una cuenta, su espacio de trabajo y su primer administrador.

    El nombre de negocio es opcional. Si no viene, el espacio se crea con el
    nombre interno "Mi organización" y queda marcado como no publicado; la
    persona puede configurarlo después sin que cambie su usuario.

    El usuario se genera en el servidor a partir del nombre del negocio o del
    nombre de la persona. Nunca del correo. La colisión se resuelve con
    variantes acotadas y, si dos altas compiten, la transacción completa se
    reintenta para no dejar una cuenta a medias.

    Rate-limited con el lockout en DB (mig 016, cubo por IP con email
    sentinel): es un endpoint público que crea filas, sin límite sería un
    vector de basura en la DB."""
    check_session_origin(request)
    ip = _client_ip(request)
    if await _login_locked(db, "__register__", ip):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Demasiados intentos. Espera unos minutos.",
        )
    await _register_failure(db, "__register__", ip)  # el éxito lo deja así

    venue_name = body.venue_name
    workspace_name = venue_name or "Mi organización"
    is_placeholder = venue_name is None
    username_source = venue_name or body.full_name
    base = username_base(username_source)

    created: dict | None = None
    for candidate in username_candidates(base):
        async with db.cursor() as cur:
            if not await _username_free(cur, candidate):
                continue

        # Todo-o-nada: la conexión es autocommit (core/db.py), así que sin este
        # bloque un fallo a mitad (p. ej. al registrar la aceptación legal)
        # dejaba la venue huérfana. `db.transaction()` abre una transacción
        # real; por eso NO hay `db.commit()` dentro (sería un commit explícito
        # prohibido).
        try:
            async with db.transaction(), db.cursor() as cur:
                await cur.execute(
                    "SELECT id FROM users WHERE lower(email)=lower(%s)", (body.email,)
                )
                if await cur.fetchone():
                    await _register_failure(db, "__register__", ip)
                    raise HTTPException(
                        status.HTTP_409_CONFLICT,
                        "Ese email ya tiene una cuenta. Inicia sesión o usa otro.",
                    )

                # Documentos que exigen aceptación HOY. Se leen de la DB y no
                # del request: el cliente no elige qué versión aceptó.
                legal_docs = await current_documents(cur)
                fingerprint = terms_fingerprint(legal_docs)
                if body.terms_version and body.terms_version != fingerprint:
                    # Los términos cambiaron mientras se llenaba el formulario:
                    # es mejor pedir que recargue que guardar la aceptación de
                    # un texto que nunca vio.
                    raise HTTPException(
                        status.HTTP_409_CONFLICT,
                        "Los Términos y Condiciones se actualizaron. Recarga la página "
                        "y vuelve a aceptarlos.",
                    )
                if not body.accepted_terms:
                    # Sin aceptación explícita no se crea la cuenta: publicar los
                    # términos sin poder probar quién los aceptó es lo mismo que
                    # no tenerlos.
                    raise HTTPException(
                        status.HTTP_422_UNPROCESSABLE_CONTENT,
                        "Debes aceptar los Términos y la Política de Datos para crear la cuenta.",
                    )

                slug = await _unique_venue_slug(cur, _slugify(workspace_name))
                await cur.execute(
                    """INSERT INTO venues (name, slug, is_placeholder)
                       VALUES (%s, %s, %s) RETURNING id""",
                    (workspace_name, slug, is_placeholder),
                )
                venue_id = (await cur.fetchone())["id"]

                await cur.execute(
                    """INSERT INTO users (email, password_hash, full_name, username)
                       VALUES (%s, %s, %s, %s) RETURNING id""",
                    (body.email, hash_password(body.password), body.full_name, candidate),
                )
                user_id = (await cur.fetchone())["id"]

                await cur.execute(
                    "INSERT INTO venue_user_roles (venue_id, user_id, role) "
                    "VALUES (%s, %s, 'admin')",
                    (venue_id, user_id),
                )

                # Prueba del consentimiento: quién, cuándo, qué versión, desde
                # qué IP.
                await record_acceptances(
                    cur,
                    docs=legal_docs,
                    user_id=user_id,
                    venue_id=venue_id,
                    email=body.email,
                    phone=None,
                    ip=ip,
                    user_agent=(request.headers.get("user-agent") or "")[:400] or None,
                )
                created = {
                    "venue_id": venue_id,
                    "user_id": user_id,
                    "username": candidate,
                }
                # Sin `db.commit()`: el bloque `db.transaction()` confirma al salir.
            break
        except psycopg.errors.UniqueViolation as e:
            constraint = getattr(getattr(e, "diag", None), "constraint_name", "") or ""
            if constraint == "users_username_lower_key":
                continue
            if constraint == "users_email_key":
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Ese email ya tiene una cuenta. Inicia sesión o usa otro.",
                ) from e
            if constraint == "venues_slug_key":
                continue
            raise

    if created is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "No pudimos asignar un nombre de usuario. Intenta con otro nombre.",
        )

    roles = {str(created["venue_id"]): ["admin"]}
    token = create_access_token(created["user_id"], [created["venue_id"]], roles, 1)
    await _register_session(db, token, created["user_id"], request, ip)
    summary = await _build_user_summary(db, created["user_id"])
    return session_response(token, summary, status_code=201)


# ---------------------------------------------------------------------------
# Recuperación de contraseña (sin proveedor de email aún)
# ---------------------------------------------------------------------------
@router.post("/forgot-password", response_model=MessageOut)
async def forgot_password(
    body: ForgotPasswordRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Punto de entrada del reset self-service.

    Responde SIEMPRE el mismo texto, exista o no el email (la enumeración de
    cuentas se niega por diseño). Con email configurado: crea el token
    (hash en DB, crudo solo en el correo) y lo envía. Sin email configurado
    orienta al flujo operado por admin — mismo texto de respuesta.

    Rate-limited con el lockout en DB (cubo por IP con email sentinel):
    pedir resets en volumen es basura y un vector de enumeración.
    """
    ip = _client_ip(request)
    if await _login_locked(db, "__forgot__", ip):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Demasiadas consultas. Espera unos minutos e intenta de nuevo.",
        )
    await _register_failure(db, "__forgot__", ip)

    email_norm = body.email.strip().lower()
    async with db.cursor() as cur:
        await cur.execute(
            """SELECT id, full_name, email, is_active FROM users
               WHERE lower(email) = %s LIMIT 1""",
            (email_norm,),
        )
        user = await cur.fetchone()

    settings = get_settings()
    mailer = Mailer(
        api_key=settings.resend_api_key,
        from_email=settings.email_from_address,
        from_name="Enty",
        app_url=settings.app_public_url,
    )

    # El texto NO depende de si el email existe (anti-enumeración). SÍ depende
    # de si el correo está configurado: eso es estado del SISTEMA, no de la
    # cuenta, así que no filtra nada. Sin proveedor de email el mailer es
    # no-op: prometer un enlace que nunca llega deja al usuario esperando en
    # vano, así que se orienta al reset operado por admin (ya existe:
    # TeamManager -> POST /venues/{id}/users/{id}/reset-password).
    if mailer.enabled:
        generic = (
            "Si el correo está registrado, te enviamos un enlace para "
            "restablecer la contraseña. Revisa también tu carpeta de spam."
        )
    else:
        generic = (
            "El envío de correos todavía no está activo. Pídele a un "
            "administrador de tu negocio que restablezca tu contraseña desde "
            "el panel de equipo."
        )

    if user and user["is_active"]:
        raw_token = token_hex(32)  # 256 bits, de un solo uso
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        async with db.cursor() as cur:
            # Un pedido nuevo invalida los anteriores del usuario (lógicos:
            # el canje solo acepta tokens sin usar y del hash más reciente).
            await cur.execute(
                """INSERT INTO password_reset_tokens
                   (user_id, token_hash, expires_at, request_ip)
                   VALUES (%s, %s, now() + interval '60 minutes', %s)""",
                (user["id"], token_hash, ip),
            )
        if mailer.enabled:
            await run_in_threadpool(
                mailer.send_password_reset,
                to=user["email"],
                full_name=user["full_name"],
                token=raw_token,
            )

    return MessageOut(detail=generic)


@router.post("/reset-password", response_model=MessageOut)
async def reset_password(
    body: ResetPasswordRequest,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Consuma el token del correo y fija la nueva contraseña.

    Canje de un solo uso con compare-and-swap (WHERE used_at IS NULL): dos
    clicks simultáneos al mismo correo, solo uno gana. Al cambiar la
    contraseña se limpia el cubo de lockout del email (quien recuperó el
    acceso no se queda bloqueado por sus propios intentos fallidos).
    """
    token_hash = hashlib.sha256(body.token.encode()).hexdigest()
    # Consumo del token + cambio de contraseña en una sola unidad: la conexión
    # es autocommit, así que sin el bloque un fallo tras marcar el token usado
    # dejaba el enlace quemado y la contraseña sin cambiar (el usuario quedaba
    # obligado a pedir otro enlace).
    async with db.transaction(), db.cursor() as cur:
        await cur.execute(
            """SELECT pr.id AS pr_id, pr.expires_at, pr.used_at,
                      u.id AS user_id, u.email
               FROM password_reset_tokens pr
               JOIN users u ON u.id = pr.user_id
               WHERE pr.token_hash = %s
               ORDER BY pr.created_at DESC
               LIMIT 1""",
            (token_hash,),
        )
        row = await cur.fetchone()
        # Mismo mensaje para token inexistente, usado o vencido: no se
        # revela cuál de los tres fue.
        if not row or row["used_at"] is not None or row["expires_at"] < datetime.now(timezone.utc):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "El enlace no es válido o ya expiró. Pide uno nuevo.",
            )

        # Compare-and-swap: consumo atómico del token.
        await cur.execute(
            """UPDATE password_reset_tokens SET used_at = now()
               WHERE id = %s AND used_at IS NULL""",
            (row["pr_id"],),
        )
        if not cur.rowcount:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "El enlace no es válido o ya expiró. Pide uno nuevo.",
            )

        # Bump de token_version (mig 019): cualquier JWT viejo del usuario
        # queda muerto al instante — la recuperación no deja sesiones vivas.
        await cur.execute(
            "UPDATE users SET password_hash = %s, token_version = token_version + 1 "
            "WHERE id = %s",
            (hash_password(body.new_password), row["user_id"]),
        )
        # Sin `db.commit()`: el bloque `db.transaction()` confirma al salir.

    # La fecha del cambio (mig 037) va aparte y best-effort: no puede impedir
    # que alguien recupere su cuenta si la migracion aun no llego.
    await _marcar_cambio_password(db, row["user_id"])

    # Éxito: limpiar el lockout de ese email (cualquier IP).
    try:
        async with db.cursor() as cur:
            await cur.execute(
                "DELETE FROM login_attempts WHERE email_norm = %s",
                (row["email"].lower(),),
            )
    except psycopg.Error:
        pass

    return MessageOut(detail="Contraseña actualizada. Ya puedes iniciar sesión.")


# ---------------------------------------------------------------------------
# Edición del perfil propio y del negocio (venue)
# ---------------------------------------------------------------------------
@router.patch("/profile", response_model=UserSummary)
async def update_profile(
    body: UpdateProfileRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Actualiza el nombre visible y, si se piden, el usuario y el telefono.

    `username`/`phone` en None dejan el valor actual. El usuario no se puede
    vaciar: toda cuenta conserva un identificador de acceso. Un usuario ya
    tomado por otra cuenta responde 409 en vez de un 500 por violacion de
    constraint, y el valor anterior queda intacto.
    """
    # SET dinamico en vez de una rama por combinacion: con tres campos
    # opcionales, las ramas se multiplicaban y un PATCH que solo cambiaba el
    # nombre podia borrar el telefono. Los fragmentos de columna son literales
    # de este codigo, nunca texto del cliente; los valores van parametrizados.
    columnas = ["full_name=%s"]
    valores: list = [body.full_name.strip()]
    if body.username is not None:
        columnas.append("username=%s")
        valores.append(body.username)
    if body.phone is not None:
        columnas.append("phone=%s")
        valores.append(body.phone or None)  # "" -> NULL
    if body.contact_email is not None:
        columnas.append("contact_email=%s")
        valores.append(body.contact_email or None)
    if body.share_contact_with_team is not None:
        columnas.append("share_contact_with_team=%s")
        valores.append(body.share_contact_with_team)
    valores.append(user["id"])

    async with db.cursor() as cur:
        try:
            await cur.execute(
                f"UPDATE users SET {', '.join(columnas)} WHERE id=%s",
                tuple(valores),
            )
        except psycopg.errors.UniqueViolation as e:
            await db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Ese nombre de usuario ya esta en uso. Elige otro.",
            ) from e
        await db.commit()
    return await _build_user_summary(db, user["id"])


async def _marcar_cambio_password(
    db: psycopg.AsyncConnection, user_id: int
) -> None:
    """Anota cuando se cambio la contrasena (mig 037).

    Best-effort a proposito, y siempre DESPUES de confirmar el cambio: si la
    columna todavia no existe en la base (codigo desplegado antes que la
    migracion), se ignora en vez de devolverle un 500 a alguien que acaba de
    cambiar su clave correctamente. Lo unico que se pierde es la linea del
    perfil.
    """
    try:
        async with db.cursor() as cur:
            await cur.execute(
                "UPDATE users SET password_changed_at = now() WHERE id=%s", (user_id,)
            )
        await db.commit()
    except psycopg.errors.UndefinedColumn:
        await db.rollback()


async def _avatar_listo(cur: psycopg.AsyncCursor) -> bool:
    """¿Estan las columnas de la mig 038?

    Sin ellas la foto de perfil no puede funcionar: `media.venue_id` sigue
    siendo NOT NULL y `users.avatar_url` no existe. Se responde 503 con un
    mensaje claro en vez de un 500: es una funcion esperando a la migracion, no
    un fallo del usuario.
    """
    await cur.execute(
        """
        SELECT count(*) AS n
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND (
                (table_name = 'media' AND column_name = 'venue_id'
                 AND is_nullable = 'YES')
             OR (table_name = 'users' AND column_name = 'avatar_url')
           )
        """
    )
    return (await cur.fetchone())["n"] == 2


def _media_id_from_url(url: str | None) -> int | None:
    """Id de una URL /media/{id}, o None si no es una imagen de las nuestras.

    `avatar_url` solo lo escribe el endpoint de subida, pero conviene no
    fiarse: si alguna vez apunta a un host externo, el borrado no toca `media`
    en vez de intentar borrar un id que no existe.
    """
    if not url or not url.startswith("/media/"):
        return None
    try:
        return int(url.removeprefix("/media/").split("?")[0])
    except ValueError:
        return None


@router.post("/avatar", response_model=UserSummary)
async def set_avatar(
    body: AvatarUpload,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Sube la foto de perfil y devuelve el resumen completo.

    La imagen vive en `media` sin venue (mig 038): es de la persona, no del
    negocio. La fila anterior se borra en la misma transaccion para no dejar
    bytes muertos; el filtro por created_by impide tocar imagenes ajenas.
    """
    async with db.cursor() as cur:
        if not await _avatar_listo(cur):
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "La foto de perfil aún no está disponible. Inténtalo más tarde.",
            )
        await cur.execute("SELECT avatar_url FROM users WHERE id=%s", (user["id"],))
        previa = _media_id_from_url((await cur.fetchone() or {}).get("avatar_url"))

    media = await store_image(
        db, data_url=body.data_url, venue_id=None, user_id=user["id"]
    )
    async with db.cursor() as cur:
        await cur.execute(
            "UPDATE users SET avatar_url=%s WHERE id=%s",
            (f"/media/{media['id']}", user["id"]),
        )
        if previa is not None:
            await cur.execute(
                "DELETE FROM media WHERE id=%s AND created_by=%s "
                "AND venue_id IS NULL",
                (previa, user["id"]),
            )
        await db.commit()
    return await _build_user_summary(db, user["id"])


@router.delete("/avatar", response_model=UserSummary)
async def clear_avatar(
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Quita la foto de perfil y libera los bytes de `media`."""
    async with db.cursor() as cur:
        if not await _avatar_listo(cur):
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "La foto de perfil aún no está disponible. Inténtalo más tarde.",
            )
        await cur.execute("SELECT avatar_url FROM users WHERE id=%s", (user["id"],))
        previa = _media_id_from_url((await cur.fetchone() or {}).get("avatar_url"))
        await cur.execute("UPDATE users SET avatar_url=NULL WHERE id=%s", (user["id"],))
        if previa is not None:
            await cur.execute(
                "DELETE FROM media WHERE id=%s AND created_by=%s "
                "AND venue_id IS NULL",
                (previa, user["id"]),
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
    """Nombre, logo, marca y contacto del negocio (solo admin de la venue).

    PATCH parcial: solo aplica los campos enviados. logo_url="" limpia el
    logo (queda NULL). `logo_data_url` guarda un archivo en `media` y gana
    sobre logo_url; la imagen anterior se borra en la misma transacción."""
    ensure_roles(user, venue_id, "super_admin", "admin")
    async with db.cursor() as cur:
        await cur.execute(
            """SELECT id, logo_url, contact_phone,
                      (to_jsonb(venues) ->> 'contact_email') AS contact_email,
                      coalesce(
                        (to_jsonb(venues) ->> 'public_contact_enabled')::boolean,
                        false
                      ) AS public_contact_enabled,
                      coalesce(
                        to_jsonb(venues) -> 'public_contact_channels', '[]'::jsonb
                      ) AS public_contact_channels
                 FROM venues WHERE id=%s""",
            (venue_id,),
        )
        prev = await cur.fetchone()
        if not prev:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Venue no encontrada")

        # Publicar contacto es una autorización con consecuencias: el canal
        # elegido tiene que tener un dato real. Se valida aquí, con el estado
        # final (body + lo ya guardado), porque un PATCH parcial puede activar
        # WhatsApp sin reenviar el teléfono.
        public_enabled = (
            body.public_contact_enabled
            if body.public_contact_enabled is not None
            else bool(prev["public_contact_enabled"])
        )
        channels = (
            body.public_contact_channels
            if body.public_contact_channels is not None
            else list(prev["public_contact_channels"] or [])
        )
        phone = (
            body.contact_phone
            if body.contact_phone is not None
            else (prev["contact_phone"] or "")
        )
        email = (
            body.contact_email
            if body.contact_email is not None
            else (prev["contact_email"] or "")
        )
        if public_enabled:
            if not channels:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Elige al menos un canal para publicar el contacto.",
                )
            if "whatsapp" in channels and not (phone or "").strip():
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Elegiste WhatsApp pero no hay un teléfono de contacto.",
                )
            if "email" in channels and not (email or "").strip():
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Elegiste correo pero no hay un correo de contacto.",
                )

        if body.name is not None:
            # Configurar el nombre es configurar la identidad publica: el
            # espacio deja de ser el marcador interno "Mi organización".
            await cur.execute(
                "UPDATE venues SET name=%s, is_placeholder=false WHERE id=%s",
                (body.name.strip(), venue_id),
            )

        logo_nuevo = body.logo_url
        if body.logo_data_url:
            media = await store_image(
                db,
                data_url=body.logo_data_url,
                venue_id=venue_id,
                user_id=user["id"],
            )
            logo_nuevo = f"/media/{media['id']}"
            prev_id = _media_id_from_url(prev["logo_url"])
            if prev_id is not None:
                await cur.execute(
                    "DELETE FROM media WHERE id=%s AND venue_id=%s",
                    (prev_id, venue_id),
                )
        if logo_nuevo is not None:
            await cur.execute(
                "UPDATE venues SET logo_url=%s WHERE id=%s",
                (logo_nuevo.strip() or None, venue_id),
            )
        if body.commission_pct is not None:
            await cur.execute(
                "UPDATE venues SET commission_pct=%s WHERE id=%s",
                (body.commission_pct, venue_id),
            )
        if body.primary_color is not None:
            await cur.execute(
                "UPDATE venues SET primary_color=%s WHERE id=%s",
                (body.primary_color or None, venue_id),
            )
        # Contacto del organizador (mig 036). "" limpia (NULL): el bloque
        # publico de "encarga tu boleta" desaparece sin dejar un telefono vacio.
        if body.contact_name is not None:
            await cur.execute(
                "UPDATE venues SET contact_name=%s WHERE id=%s",
                (body.contact_name.strip() or None, venue_id),
            )
        if body.contact_phone is not None:
            await cur.execute(
                "UPDATE venues SET contact_phone=%s WHERE id=%s",
                (body.contact_phone.strip() or None, venue_id),
            )
        if body.contact_email is not None:
            await cur.execute(
                "UPDATE venues SET contact_email=%s WHERE id=%s",
                (body.contact_email or None, venue_id),
            )
        if body.contact_team_visible is not None:
            await cur.execute(
                "UPDATE venues SET contact_team_visible=%s WHERE id=%s",
                (body.contact_team_visible, venue_id),
            )
        if body.public_contact_enabled is not None:
            await cur.execute(
                "UPDATE venues SET public_contact_enabled=%s WHERE id=%s",
                (body.public_contact_enabled, venue_id),
            )
        if body.public_contact_channels is not None:
            await cur.execute(
                "UPDATE venues SET public_contact_channels=%s WHERE id=%s",
                (body.public_contact_channels, venue_id),
            )
        await db.commit()

        await cur.execute(
            """SELECT id, name, slug, logo_url, primary_color, commission_pct,
                      contact_name, contact_phone,
                      (to_jsonb(venues) ->> 'contact_email') AS contact_email,
                      coalesce(
                        (to_jsonb(venues) ->> 'is_placeholder')::boolean, false
                      ) AS is_placeholder,
                      coalesce(
                        (to_jsonb(venues) ->> 'contact_team_visible')::boolean, true
                      ) AS contact_team_visible,
                      coalesce(
                        (to_jsonb(venues) ->> 'public_contact_enabled')::boolean, false
                      ) AS public_contact_enabled,
                      coalesce(
                        to_jsonb(venues) -> 'public_contact_channels',
                        '[]'::jsonb
                      ) AS public_contact_channels
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
        contact_name=row["contact_name"],
        contact_phone=row["contact_phone"],
        contact_email=row["contact_email"],
        contact_team_visible=bool(row["contact_team_visible"]),
        public_contact_enabled=bool(row["public_contact_enabled"]),
        public_contact_channels=list(row["public_contact_channels"] or []),
        is_placeholder=bool(row["is_placeholder"]),
    )


# ---------------------------------------------------------------------------
# Cambio de contraseña propia (autenticado)
# ---------------------------------------------------------------------------
@router.post("/change-password", response_model=MessageOut)
async def change_password(
    body: ChangePasswordRequest,
    request: Request,
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
        # Bump de token_version (mig 019): el resto de las sesiones abiertas
        # (otro teléfono, un navegador público) muere al cambiar la clave.
        await cur.execute(
            "UPDATE users SET password_hash=%s, token_version = token_version + 1 "
            "WHERE id=%s",
            (hash_password(body.new_password), user["id"]),
        )
        try:
            await cur.execute("DELETE FROM user_sessions WHERE user_id=%s", (user["id"],))
        except psycopg.errors.UndefinedTable:
            pass
        await db.commit()
    await _marcar_cambio_password(db, user["id"])
    await _log_security(
        db,
        user["id"],
        "password_changed",
        detail="Contraseña actualizada; las demás sesiones se cerraron.",
        ip=_client_ip(request),
    )
    return MessageOut(detail="Contraseña actualizada.")


@router.post("/change-email", response_model=EmailChangeRequestOut)
async def change_email(
    body: ChangeEmailRequest,
    request: Request,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Solicita el cambio de correo, sin aplicarlo todavía.

    Pide la contraseña vigente (el correo es la llave de recuperación) y envía
    un enlace de un solo uso al buzón NUEVO. Hasta que ese enlace se canjea, la
    cuenta conserva su correo actual, su id, roles, eventos y asignaciones.
    También se avisa al correo anterior para que una sesión robada no pueda
    desviar la cuenta en silencio.
    """
    nuevo = body.new_email.strip().lower()
    actual = (user.get("email") or "").strip().lower()
    if nuevo == actual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Ese ya es el correo de tu cuenta."
        )

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT password_hash, full_name FROM users WHERE id=%s", (user["id"],)
        )
        row = await cur.fetchone()
        if not row or not verify_password(
            body.current_password, row["password_hash"]
        ):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "La contraseña actual no es correcta.",
            )

        await cur.execute(
            "SELECT 1 FROM users WHERE lower(email)=lower(%s) AND id<>%s",
            (nuevo, user["id"]),
        )
        if await cur.fetchone():
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Ese correo ya tiene una cuenta."
            )

    raw_token = token_hex(32)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    async with db.cursor() as cur:
        # Un pedido nuevo invalida los anteriores del usuario.
        await cur.execute(
            "UPDATE email_change_tokens SET used_at=now() "
            "WHERE user_id=%s AND used_at IS NULL",
            (user["id"],),
        )
        await cur.execute(
            """INSERT INTO email_change_tokens
               (user_id, new_email, token_hash, expires_at)
               VALUES (%s, %s, %s, now() + interval '24 hours')""",
            (user["id"], nuevo, token_hash),
        )
        await db.commit()

    settings = get_settings()
    mailer = Mailer(
        api_key=settings.resend_api_key,
        from_email=settings.email_from_address,
        from_name="Enty",
        app_url=settings.app_public_url,
    )
    sent = False
    if mailer.enabled:
        sent = await run_in_threadpool(
            mailer.send_email_change_verification,
            to=nuevo,
            full_name=row["full_name"] or "",
            token=raw_token,
        )
        # Aviso al buzón anterior: si no fuiste tú, todavía hay tiempo de
        # reaccionar. El enlace de confirmación NO viaja a este correo.
        await run_in_threadpool(
            mailer.send_email_change_notice,
            to=user["email"],
            new_email=nuevo,
        )
    await _log_security(
        db,
        user["id"],
        "email_change_requested",
        detail=f"Verificación solicitada para {nuevo}.",
        ip=_client_ip(request),
    )

    if not sent:
        return EmailChangeRequestOut(
            detail=(
                "El envío de correos no está activo, así que no pudimos "
                "verificar el correo nuevo. Tu cuenta sigue con el correo actual."
            ),
            verification_sent=False,
            pending_email=nuevo,
        )
    return EmailChangeRequestOut(
        detail=(
            "Te enviamos un enlace de verificación al correo nuevo. Tu cuenta "
            "seguirá con el correo actual hasta que lo confirmes. También "
            "avisamos al correo anterior."
        ),
        verification_sent=True,
        pending_email=nuevo,
    )


@router.post("/change-email/confirm", response_model=UserSummary)
async def confirm_email_change(
    body: EmailChangeConfirmRequest,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Canjea el enlace de un solo uso y activa el correo nuevo.

    No exige sesión: la prueba de posesión del buzón nuevo es el token. La
    cuenta conserva su id y sus accesos; solo cambia el identificador de
    entrada y recuperación.
    """
    token_hash = hashlib.sha256(body.token.encode()).hexdigest()
    async with db.transaction(), db.cursor() as cur:
        await cur.execute(
            """SELECT t.id, t.user_id, t.new_email, t.expires_at, t.used_at,
                      u.email AS old_email, u.full_name
               FROM email_change_tokens t
               JOIN users u ON u.id = t.user_id
               WHERE t.token_hash = %s
               ORDER BY t.created_at DESC
               LIMIT 1""",
            (token_hash,),
        )
        row = await cur.fetchone()
        if (
            not row
            or row["used_at"] is not None
            or row["expires_at"] < datetime.now(timezone.utc)
        ):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "El enlace no es válido o ya expiró. Pide uno nuevo.",
            )
        await cur.execute(
            """SELECT 1 FROM users
               WHERE lower(email)=lower(%s) AND id<>%s""",
            (row["new_email"], row["user_id"]),
        )
        if await cur.fetchone():
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Ese correo ya tiene una cuenta."
            )
        await cur.execute(
            "UPDATE email_change_tokens SET used_at=now() WHERE id=%s AND used_at IS NULL",
            (row["id"],),
        )
        if not cur.rowcount:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "El enlace no es válido o ya expiró. Pide uno nuevo.",
            )
        try:
            await cur.execute(
                "UPDATE users SET email=%s WHERE id=%s",
                (row["new_email"], row["user_id"]),
            )
        except psycopg.errors.UniqueViolation as e:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Ese correo ya tiene una cuenta."
            ) from e
        # Otras solicitudes pendientes quedan invalidadas.
        await cur.execute(
            "UPDATE email_change_tokens SET used_at=now() "
            "WHERE user_id=%s AND used_at IS NULL",
            (row["user_id"],),
        )
    await _log_security(
        db,
        row["user_id"],
        "email_changed",
        detail=f"Correo actualizado a {row['new_email']}.",
    )
    settings = get_settings()
    mailer = Mailer(
        api_key=settings.resend_api_key,
        from_email=settings.email_from_address,
        from_name="Enty",
        app_url=settings.app_public_url,
    )
    if mailer.enabled:
        await run_in_threadpool(
            mailer.send_email_change_notice,
            to=row["old_email"],
            new_email=row["new_email"],
            confirmed=True,
        )
    return await _build_user_summary(db, row["user_id"])


@router.get("/sessions", response_model=list[SessionOut])
async def list_sessions(
    request: Request,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Sesiones activas del usuario, con la actual marcada.

    No se inventa ubicación: solo se muestra el navegador/sistema que el
    user-agent declara y la última actividad real registrada.
    """
    current_hash = _token_hash(_request_token(request) or "")
    async with db.cursor() as cur:
        try:
            await cur.execute(
                """SELECT id, token_hash, user_agent, created_at, last_seen_at
                   FROM user_sessions
                   WHERE user_id=%s AND revoked_at IS NULL
                   ORDER BY last_seen_at DESC, id DESC""",
                (user["id"],),
            )
            rows = await cur.fetchall()
        except psycopg.errors.UndefinedTable:
            await db.rollback()
            rows = []
    return [
        SessionOut(
            id=r["id"],
            device=_device_label(r["user_agent"]),
            created_at=r["created_at"],
            last_seen_at=r["last_seen_at"],
            current=r["token_hash"] == current_hash,
        )
        for r in rows
    ]


@router.delete("/sessions/current", status_code=status.HTTP_204_NO_CONTENT)
async def close_current_session(
    request: Request,
    response: Response,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Cierra SOLO esta sesión. La cookie se borra y el token queda revocado."""
    token = _request_token(request)
    if token:
        try:
            async with db.cursor() as cur:
                await cur.execute(
                    "UPDATE user_sessions SET revoked_at=now() "
                    "WHERE user_id=%s AND token_hash=%s AND revoked_at IS NULL",
                    (user["id"], _token_hash(token)),
                )
        except psycopg.errors.UndefinedTable:
            await db.rollback()
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="lax")
    await _log_security(
        db,
        user["id"],
        "session_revoked",
        detail="Sesión actual cerrada desde este dispositivo.",
        ip=_client_ip(request),
    )
    return None


@router.delete("/sessions/{session_id}", response_model=MessageOut)
async def revoke_session(
    session_id: int,
    body: RevokeSessionRequest,
    request: Request,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Revoca una sesión concreta, con reautenticación por contraseña."""
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT password_hash FROM users WHERE id=%s", (user["id"],)
        )
        row = await cur.fetchone()
        if not row or not verify_password(body.password, row["password_hash"]):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "La contraseña no es correcta."
            )
        await cur.execute(
            """UPDATE user_sessions SET revoked_at=now()
               WHERE id=%s AND user_id=%s AND revoked_at IS NULL""",
            (session_id, user["id"]),
        )
        if not cur.rowcount:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Sesión no encontrada")
        await db.commit()
    await _log_security(
        db,
        user["id"],
        "session_revoked",
        detail=f"Sesión {session_id} cerrada.",
        ip=_client_ip(request),
    )
    return MessageOut(detail="Sesión cerrada. Ese dispositivo perdió el acceso.")


@router.post("/close-other-sessions", response_model=TokenResponse)
async def close_other_sessions(
    body: CloseOtherSessionsRequest,
    request: Request,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Cierra las demás sesiones del usuario y deja viva la actual.

    Bump de `token_version` (mig 019): todo JWT emitido antes queda muerto.
    El token de ESTA sesión también, así que se emite uno nuevo y se devuelve.
    Además se marcan revocadas las filas de `user_sessions`: el listado del
    perfil refleja la verdad inmediatamente, sin esperar a que expiren.
    """
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT password_hash FROM users WHERE id=%s", (user["id"],)
        )
        row = await cur.fetchone()
        if not row or not verify_password(body.password, row["password_hash"]):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "La contraseña no es correcta."
            )
        await cur.execute(
            "UPDATE users SET token_version = token_version + 1 WHERE id=%s "
            "RETURNING token_version",
            (user["id"],),
        )
        new_version = (await cur.fetchone())["token_version"]
        try:
            await cur.execute(
                "UPDATE user_sessions SET revoked_at=now() "
                "WHERE user_id=%s AND revoked_at IS NULL",
                (user["id"],),
            )
        except psycopg.errors.UndefinedTable:
            pass
        await db.commit()

    token = create_access_token(
        user["id"], user["venue_ids"], user["roles"], new_version
    )
    await _register_session(db, token, user["id"], request)
    summary = await _build_user_summary(db, user["id"])
    await _log_security(
        db,
        user["id"],
        "sessions_revoked",
        detail="Se cerraron las demás sesiones.",
        ip=_client_ip(request),
    )
    return session_response(token, summary)


@router.get("/security/activity", response_model=list[SecurityEventOut])
async def security_activity(
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Historial breve y real de cambios sensibles de la cuenta."""
    async with db.cursor() as cur:
        try:
            await cur.execute(
                """SELECT id, kind, detail, created_at
                   FROM security_events
                   WHERE user_id=%s
                   ORDER BY created_at DESC, id DESC
                   LIMIT 20""",
                (user["id"],),
            )
            rows = await cur.fetchall()
        except psycopg.errors.UndefinedTable:
            await db.rollback()
            rows = []
    return [SecurityEventOut(**r) for r in rows]


async def _deletion_blockers(
    db: psycopg.AsyncConnection, user: dict
) -> list[DeletionBlocker]:
    """Negocios que impiden borrar la cuenta sin transferir la administración.

    La regla es deliberadamente conservadora: si eres el único admin y el
    negocio tiene equipo o eventos, borrar la cuenta dejaría datos de terceros
    sin dueño. Un negocio vacío sí se puede llevar con la cuenta.
    """
    venue_ids = [
        int(vid)
        for vid, roles in (user.get("roles") or {}).items()
        if "admin" in roles
    ]
    if not venue_ids:
        return []
    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT v.id, v.name,
                   (SELECT count(*)::int FROM venue_user_roles r
                     WHERE r.venue_id = v.id) AS members,
                   (SELECT count(*)::int FROM venue_user_roles r
                     WHERE r.venue_id = v.id AND r.role = 'admin') AS admins,
                   (SELECT count(*)::int FROM events e
                     WHERE e.venue_id = v.id) AS events
              FROM venues v
             WHERE v.id = ANY(%s)
            """,
            (venue_ids,),
        )
        rows = await cur.fetchall()
    blockers: list[DeletionBlocker] = []
    for row in rows:
        if row["admins"] != 1:
            continue
        if row["members"] > 1:
            blockers.append(
                DeletionBlocker(
                    venue_id=row["id"],
                    venue_name=row["name"],
                    reason="unique_admin_team",
                    detail=(
                        f"Eres el único administrador de {row['name']} y hay "
                        "personas en el equipo. Asigna otro admin antes de "
                        "borrar tu cuenta."
                    ),
                )
            )
        elif row["events"] > 0:
            blockers.append(
                DeletionBlocker(
                    venue_id=row["id"],
                    venue_name=row["name"],
                    reason="unique_admin_events",
                    detail=(
                        f"Eres el único administrador de {row['name']} y el "
                        "negocio tiene eventos. Asigna otro admin antes de "
                        "borrar tu cuenta para no perder el acceso a esos "
                        "eventos y sus boletas."
                    ),
                )
            )
    return blockers


@router.get("/account/deletion-check", response_model=DeletionCheckOut)
async def check_account_deletion(
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Adelanta el estado que la UI puede mostrar sin adivinar."""
    blockers = await _deletion_blockers(db, user)
    return DeletionCheckOut(can_delete=not blockers, blockers=blockers)


@router.delete("/account", response_model=MessageOut)
async def delete_own_account(
    body: DeleteAccountRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Elimina la cuenta y sus membresías. Sola, o con toda la venue si es
    admin único. Pide la contraseña Y el email escrito a mano: confirmación
    fuerte e irrevocable, proporcional a lo que se lleva por delante."""
    async with db.cursor() as cur:
        await cur.execute(
            "SELECT password_hash FROM users WHERE id=%s", (user["id"],)
        )
        row = await cur.fetchone()
        if not row or not verify_password(body.password, row["password_hash"]):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Contraseña incorrecta")
        # Confirmación mecanografiada: el email del usuario, tal cual. Un
        # borrado irreversible no puede dispararse con un clic distraído.
        if body.confirm.strip().lower() != user["email"].strip().lower():
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Para confirmar, escribe tu correo exactamente como aparece.",
            )

        await cur.execute(
            "SELECT venue_id FROM venue_user_roles WHERE user_id=%s",
            (user["id"],),
        )
        venue_ids = [r["venue_id"] for r in await cur.fetchall()]

        blockers = await _deletion_blockers(db, user)
        if blockers:
            raise HTTPException(status.HTTP_409_CONFLICT, blockers[0].detail)

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
# Exportación de los propios datos (portabilidad)
# ---------------------------------------------------------------------------
@router.post("/export")
async def export_own_data(
    body: ExportDataRequest,
    request: Request,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Devuelve un JSON con todo lo que la plataforma sabe de esta cuenta.

    Portabilidad y transparencia: la persona puede ver y llevarse sus datos
    sin pedírselos a nadie. NO incluye el hash de la contraseña (ni tiene por
    qué: no es un dato del usuario, es un secreto del sistema) ni tokens.
    Los datos de terceros (los compradores de una venue) tampoco viajan: esto
    es lo del usuario autenticado, no la base de clientes de su negocio.
    """
    uid = user["id"]
    async with db.cursor() as cur:
        await cur.execute("SELECT password_hash FROM users WHERE id=%s", (uid,))
        auth_row = await cur.fetchone()
        if not auth_row or not verify_password(
            body.password, auth_row["password_hash"]
        ):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "La contraseña no es correcta. No descargamos tus datos.",
            )
        await cur.execute(
            """SELECT id, email, phone, full_name, is_active, created_at,
                      updated_at, last_login_at,
                      (to_jsonb(users) ->> 'username') AS username,
                      (to_jsonb(users) ->> 'contact_email') AS contact_email,
                      coalesce(
                        (to_jsonb(users) ->> 'share_contact_with_team')::boolean,
                        false
                      ) AS share_contact_with_team,
                      (to_jsonb(users) ->> 'avatar_url') AS avatar_url,
                      (to_jsonb(users) ->> 'active_venue_id') AS active_venue_id
                 FROM users WHERE id=%s""",
            (uid,),
        )
        profile = await cur.fetchone()
        if not profile:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Usuario no encontrado")

        await cur.execute(
            """SELECT v.id, v.name, v.slug, vr.role
               FROM venue_user_roles vr
               JOIN venues v ON v.id = vr.venue_id
               WHERE vr.user_id = %s
               ORDER BY v.name""",
            (uid,),
        )
        memberships = await cur.fetchall()

        # Aceptaciones legales: qué documentos y versiones aceptó esta cuenta.
        await cur.execute(
            """SELECT document_slug, document_version, accepted_at
               FROM legal_acceptances
               WHERE user_id = %s
               ORDER BY accepted_at""",
            (uid,),
        )
        acceptances = await cur.fetchall()

        await cur.execute(
            """SELECT venue_id, key, value, step, updated_at
               FROM user_preferences
               WHERE user_id = %s
               ORDER BY venue_id, key""",
            (uid,),
        )
        preferences = await cur.fetchall()

    await _log_security(
        db,
        uid,
        "data_exported",
        detail="Descarga de datos personales.",
        ip=_client_ip(request),
    )
    return {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "format_version": 1,
        "account": {
            "id": profile["id"],
            "email": profile["email"],
            "phone": profile["phone"],
            "full_name": profile["full_name"],
            "username": profile.get("username"),
            "contact_email": profile.get("contact_email"),
            "share_contact_with_team": bool(
                profile.get("share_contact_with_team")
            ),
            "avatar_url": profile.get("avatar_url"),
            "active_venue_id": profile.get("active_venue_id"),
            "is_active": profile["is_active"],
            "created_at": profile["created_at"].isoformat()
            if profile["created_at"]
            else None,
            "updated_at": profile["updated_at"].isoformat()
            if profile["updated_at"]
            else None,
            "last_login_at": profile["last_login_at"].isoformat()
            if profile["last_login_at"]
            else None,
        },
        "memberships": [
            {
                "venue_id": m["id"],
                "venue_name": m["name"],
                "venue_slug": m["slug"],
                "role": m["role"],
            }
            for m in memberships
        ],
        "legal_acceptances": [
            {
                "document": a["document_slug"],
                "version": a["document_version"],
                "accepted_at": a["accepted_at"].isoformat()
                if a["accepted_at"]
                else None,
            }
            for a in acceptances
        ],
        "preferences": [
            {
                "venue_id": p["venue_id"],
                "key": p["key"],
                "value": p["value"],
                "step": p["step"],
                "updated_at": p["updated_at"].isoformat()
                if p["updated_at"]
                else None,
            }
            for p in preferences
        ],
    }


# ---------------------------------------------------------------------------
# NOTA: la purga definitiva de un usuario vive en lifecycle.py (rutas de
# gestión del equipo, prefijo /venues/{venue_id}).
# ---------------------------------------------------------------------------

@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Cierra la sesión de ESTE dispositivo.

    Además de borrar la cookie, marca la fila de `user_sessions` como
    revocada: una copia del token tomada antes del logout deja de servir. El
    cierre de las demás sesiones sigue siendo explícito en Seguridad.
    """
    check_session_origin(request, required=bool(request.cookies.get(COOKIE_NAME)))
    token = _request_token(request)
    if token:
        try:
            async with db.cursor() as cur:
                await cur.execute(
                    "UPDATE user_sessions SET revoked_at=now() "
                    "WHERE token_hash=%s AND revoked_at IS NULL",
                    (_token_hash(token),),
                )
            await db.commit()
        except psycopg.errors.UndefinedTable:
            await db.rollback()
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="lax")
    response.headers["Cache-Control"] = "no-store"
    return {"message": "Sesion cerrada"}
