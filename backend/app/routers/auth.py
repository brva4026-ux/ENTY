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
from fastapi import APIRouter, Depends, HTTPException, Request, status
from starlette.concurrency import run_in_threadpool

from app.core.config import get_settings
from app.core.db import get_db
from app.core.mailer import Mailer
from app.core.security import create_access_token, hash_password, verify_password
from app.deps import ensure_roles, get_current_user
# El catalogo y el registro de aceptaciones legales (mig 026) viven en el
# router legal: se importan las funciones, no se duplica el SQL.
from app.routers.legal import (
    current_documents,
    record_acceptances,
    terms_fingerprint,
)
from app.schemas import (
    ChangePasswordRequest,
    CloseOtherSessionsRequest,
    DeleteAccountRequest,
    ForgotPasswordRequest,
    LoginRequest,
    MessageOut,
    PreferenceKey,
    PreferenceOut,
    PreferencesOut,
    RegisterRequest,
    ResetPasswordRequest,
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
            "SELECT id, email, full_name, username, created_at, last_login_at "
            "FROM users WHERE id=%s",
            (user_id,),
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
        username=user.get("username"),
        venues=list(venues.values()),
        roles=roles_by_venue,
        created_at=user["created_at"],
        last_login_at=user["last_login_at"],
    )


@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    ip = _client_ip(request)
    # El identificador puede ser un correo o un nombre de usuario (mig 035).
    # Se usa tal cual como clave del lockout, en minusculas: el par
    # (identificador, IP) es lo que cuenta, y asi "Admin" y "admin" no abren
    # dos cubos distintos de intentos.
    ident = (body.identifier or body.email or "").strip()
    email_norm = ident.lower()
    if await _login_locked(db, email_norm, ip):
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
            "WHERE lower(email) = lower(%s) "
            "   OR (position('@' in %s) = 0 AND lower(username) = lower(%s))",
            (ident, ident, ident),
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

    token = create_access_token(user["id"], venue_ids, roles, user["token_version"])
    summary = await _build_user_summary(db, user["id"])
    return TokenResponse(access_token=token, user=summary)


@router.get("/me", response_model=UserSummary)
async def me(
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
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

        # Documentos que exigen aceptación HOY. Se leen de la DB y no del
        # request: el cliente no elige qué versión aceptó.
        legal_docs = await current_documents(cur)
        fingerprint = terms_fingerprint(legal_docs)
        if body.terms_version and body.terms_version != fingerprint:
            # Los términos cambiaron mientras se llenaba el formulario: es
            # mejor pedir que recargue que guardar la aceptación de un texto
            # que nunca vio.
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Los Términos y Condiciones se actualizaron. Recarga la página "
                "y vuelve a aceptarlos.",
            )
        if not body.accepted_terms:
            # Sin aceptación explícita no se crea la cuenta: publicar los
            # términos sin poder probar quién los aceptó es lo mismo que no
            # tenerlos.
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Debes aceptar los Términos y la Política de Datos para crear la cuenta.",
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

        # Prueba del consentimiento: quién, cuándo, qué versión, desde qué IP.
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
        await db.commit()

    roles = {str(venue_id): ["admin"]}
    token = create_access_token(user_id, [venue_id], roles, 1)
    summary = await _build_user_summary(db, user_id)
    return TokenResponse(access_token=token, user=summary)


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
            """SELECT id, full_name, is_active FROM users
               WHERE lower(email) = %s LIMIT 1""",
            (email_norm,),
        )
        user = await cur.fetchone()

    # El texto NO depende de si el email existe (anti-enumeración).
    generic = (
        "Si el correo está registrado, te enviamos un enlace para "
        "restablecer la contraseña. Revisa también tu carpeta de spam."
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
        settings = get_settings()
        mailer = Mailer(
            api_key=settings.resend_api_key,
            from_email=settings.email_from_address,
            from_name="Enty",
            app_url=settings.app_public_url,
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
    async with db.cursor() as cur:
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
            "UPDATE users SET password_hash = %s, token_version = token_version + 1 WHERE id = %s",
            (hash_password(body.new_password), row["user_id"]),
        )
        await db.commit()

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
    """Actualiza el nombre visible y, si se pide, el nombre de usuario.

    `username=None` deja el valor actual; `""` lo libera (la cuenta vuelve a
    entrar solo con correo). Un usuario ya tomado por otra cuenta responde 409
    en vez de un 500 por violacion de constraint: el mensaje importa.
    """
    async with db.cursor() as cur:
        if body.username is None:
            await cur.execute(
                "UPDATE users SET full_name=%s WHERE id=%s",
                (body.full_name.strip(), user["id"]),
            )
        else:
            nuevo = body.username or None  # "" -> NULL
            try:
                await cur.execute(
                    "UPDATE users SET full_name=%s, username=%s WHERE id=%s",
                    (body.full_name.strip(), nuevo, user["id"]),
                )
            except psycopg.errors.UniqueViolation:
                await db.rollback()
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Ese nombre de usuario ya esta en uso. Elige otro.",
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
        if body.primary_color is not None:
            await cur.execute(
                "UPDATE venues SET primary_color=%s WHERE id=%s",
                (body.primary_color or None, venue_id),
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
        # Bump de token_version (mig 019): el resto de las sesiones abiertas
        # (otro teléfono, un navegador público) muere al cambiar la clave.
        await cur.execute(
            "UPDATE users SET password_hash=%s, token_version = token_version + 1 WHERE id=%s",
            (hash_password(body.new_password), user["id"]),
        )
        await db.commit()
    return MessageOut(detail="Contraseña actualizada.")


@router.post("/close-other-sessions", response_model=TokenResponse)
async def close_other_sessions(
    body: CloseOtherSessionsRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Cierra las demás sesiones del usuario y deja viva la actual.

    Bump de `token_version` (mig 019): todo JWT emitido antes queda muerto.
    El problema es que el token de ESTA sesión también lo está, así que se
    emite uno nuevo y se devuelve en la respuesta: el cliente lo guarda y
    sigue trabajando, mientras el resto de dispositivos cae al login.

    Exige la contraseña: sin ella, un token robado serviría para expulsar al
    dueño de su propia cuenta en lugar de para defenderse.
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
        await db.commit()

    token = create_access_token(
        user["id"], user["venue_ids"], user["roles"], new_version
    )
    summary = await _build_user_summary(db, user["id"])
    return TokenResponse(access_token=token, user=summary)


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

        for vid in venue_ids:
            # La guarda es para el ADMIN que se va y deja el negocio acéfalo.
            # A un promotor no le aplica: su salida no deja a nadie a cargo.
            if "admin" not in user["roles"].get(vid, []):
                continue
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
# Exportación de los propios datos (portabilidad)
# ---------------------------------------------------------------------------
@router.get("/export")
async def export_own_data(
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
        await cur.execute(
            "SELECT id, email, phone, full_name, is_active, created_at, "
            "updated_at, last_login_at FROM users WHERE id=%s",
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

    return {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "format_version": 1,
        "account": {
            "id": profile["id"],
            "email": profile["email"],
            "phone": profile["phone"],
            "full_name": profile["full_name"],
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
    }


# ---------------------------------------------------------------------------
# NOTA: la purga definitiva de un usuario vive en lifecycle.py (rutas de
# gestión del equipo, prefijo /venues/{venue_id}).
# ---------------------------------------------------------------------------