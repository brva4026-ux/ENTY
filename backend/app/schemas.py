import re
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator

from app.core.password_policy import PasswordStr, check_password_strength
from app.core.urlguard import validate_flyer_url, validate_public_http_url

# Regex de email pragmática: acepta tlds de prueba (.test, .local) y hosts reales.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------
class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")
    # max_length=128: sin cota, el cuerpo del login era un vector de DoS barato
    # (bcrypt de un string de megabytes consume CPU real por request).
    password: str = Field(max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserSummary"


class UserSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: str
    full_name: str
    venues: list["VenueSummary"] = []
    roles: dict[str, list[str]] = {}  # {"<venue_id>": ["admin", ...]}


class VenueSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    slug: str
    logo_url: str | None = None
    primary_color: str | None = None
    commission_pct: float = 0


# --------------------------------------------------------------------------
# Venues (multi-tenant)
# --------------------------------------------------------------------------
class VenueCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    slug: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9-]+$")
    legal_name: str | None = None
    tax_id: str | None = None
    currency: str = "COP"
    logo_url: str | None = None
    primary_color: str | None = None
    commission_pct: float = 0


class EventCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    # El flyer puede ser un enlace http(s) público O una imagen subida que
    # vive en /media/{id} (misma página, tabla `media`). str + guardia: HttpUrl
    # rechazaría la ruta relativa y la guardia SSRF no aplica a ella (no hay
    # fetch de red posible: el <img> pinta del propio origen).
    flyer_url: str | None = Field(default=None, max_length=2000)

    @field_validator("flyer_url")
    @classmethod
    def _flyer_public(cls, v):
        return validate_flyer_url(v) if v else v
    # Lugar del evento (texto libre): viaja a la boleta del invitado y al
    # og:image de WhatsApp. Opcional: no todos los eventos tienen dirección.
    location: str | None = Field(default=None, max_length=200)
    starts_at: datetime
    ends_at: datetime | None = None
    event_timezone: str = "America/Bogota"
    capacity: int = Field(gt=0)
    # Ventana de activación del QR del invitado (patrón DICE): minutos antes
    # de la apertura en que el QR se dibuja. 0 = siempre visible. Default 60,
    # el estándar del rubio.
    qr_unlock_minutes: int = Field(default=60, ge=0, le=10080)

    @model_validator(mode="after")
    def _check_window(self) -> "EventCreate":
        """El cierre no puede ser anterior a la apertura.

        Se exige que ambas fechas usen el mismo formato de zona horaria: mezclar
        una aware con una naive revienta al comparar (TypeError -> 500).
        """
        if self.ends_at is None:
            return self
        if (self.starts_at.tzinfo is None) != (self.ends_at.tzinfo is None):
            raise ValueError("starts_at y ends_at deben usar el mismo formato de zona horaria")
        if self.ends_at <= self.starts_at:
            raise ValueError("ends_at debe ser posterior a starts_at")
        return self


class EventUpdate(BaseModel):
    """Edición parcial del evento. Solo se aplican los campos enviados.

    La validación que importa vive en la DB (`update_event` + trigger de
    transiciones): aforo >= boletas activas, ventana coherente y fechas no en
    el pasado para draft/published. Aquí solo se valida el shape.
    """
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    flyer_url: str | None = Field(default=None, max_length=2000)

    @field_validator("flyer_url")
    @classmethod
    def _flyer_public(cls, v):
        return validate_flyer_url(v) if v else v

    location: str | None = Field(default=None, max_length=200)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    event_timezone: str | None = Field(default=None, max_length=60)
    capacity: int | None = Field(default=None, gt=0)
    qr_unlock_minutes: int | None = Field(default=None, ge=0, le=10080)

    @model_validator(mode="after")
    def _check_window(self) -> "EventUpdate":
        """Si llegan ambas fechas, el cierre debe ser posterior a la apertura.

        No se exige el mismo formato aware/naive entre sí cuando solo llega una:
        esa combinación se valida en la DB contra el valor vigente del otro
        campo.
        """
        if self.starts_at is not None and self.ends_at is not None:
            if (self.starts_at.tzinfo is None) != (self.ends_at.tzinfo is None):
                raise ValueError("starts_at y ends_at deben usar el mismo formato de zona horaria")
            if self.ends_at <= self.starts_at:
                raise ValueError("ends_at debe ser posterior a starts_at")
        return self


class EventOut(BaseModel):
    """Shape completo del evento.

    `event_timezone` es obligatorio (en la DB es NOT NULL): asi una consulta a la
    que se le olvide seleccionarlo falla fuerte en vez de devolver null.
    """
    model_config = ConfigDict(from_attributes=True)
    id: int
    venue_id: int
    name: str
    description: str | None = None
    flyer_url: str | None = None
    # Lugar del evento (mig 014): el formulario lo edita y la boleta del
    # invitado lo muestra.
    location: str | None = None
    starts_at: datetime
    ends_at: datetime | None = None
    event_timezone: str
    capacity: int
    qr_unlock_minutes: int = 60
    status: str


class TicketTypeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    price_cents: int = Field(ge=0)
    quantity: int = Field(gt=0)
    is_courtesy: bool = False


class TicketTypeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_id: int
    name: str
    price_cents: int
    quantity: int
    is_courtesy: bool
    # FALSE = archivado: sigue visible para el admin (con su historial) pero ya
    # no se puede emitir contra él.
    is_active: bool = True


class TicketTypeUpdate(BaseModel):
    """Edición parcial de un tipo de boleta. Solo se aplican los campos enviados.

    `quantity` no puede quedar por debajo de lo ya emitido de ese tipo
    (lo valida `update_ticket_type` en la DB).
    """
    name: str | None = Field(default=None, min_length=1, max_length=60)
    price_cents: int | None = Field(default=None, ge=0)
    quantity: int | None = Field(default=None, gt=0)
    is_courtesy: bool | None = None
    is_active: bool | None = None


class AllocationCreate(BaseModel):
    ticket_type_id: int
    promoter_id: int
    capacity: int = Field(ge=0)


class AllocationUpdate(BaseModel):
    """Edición parcial de un cupo. La capacidad no puede quedar por debajo de
    las boletas ya emitidas contra ese cupo (lo valida la DB)."""
    capacity: int | None = Field(default=None, ge=0)
    is_active: bool | None = None


class DeleteOut(BaseModel):
    """Resultado de eliminar un tipo/cupo.

    `archived=True` significa que tenía historial y solo se archivó (el registro
    se conserva); `False` que la fila se borró de verdad.
    """
    id: int
    archived: bool
    detail: str


class AllocationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_id: int
    ticket_type_id: int
    promoter_id: int
    capacity: int
    is_active: bool
    # Boletas activas (no anuladas ni reembolsadas) del cupo. Mismo criterio que
    # usa emit_ticket() para rechazar sobreventa, para que la UI nunca mienta.
    issued: int = 0


class TicketEmitRequest(BaseModel):
    ticket_type_id: int
    allocation_id: int | None = None
    customer_name: str = Field(min_length=1, max_length=200)
    customer_phone: str = Field(min_length=5, max_length=30)
    customer_email: str | None = Field(default=None, max_length=200)


class TicketEmitResponse(BaseModel):
    ticket_id: int
    raw_token: str
    status: str


class TicketReissueRequest(BaseModel):
    """Motivo opcional de la reemisión (queda en la auditoría)."""

    reason: str | None = Field(default=None, max_length=200)


class TicketReissueResponse(BaseModel):
    """Token nuevo para volver a mostrar/reenviar el QR de una boleta viva.

    El token viejo deja de funcionar en el acto: en la DB solo hay un hash por
    boleta, asi que rotarlo invalida el anterior.
    """

    ticket_id: int
    raw_token: str
    customer_name: str
    customer_phone: str | None = None
    status: str


class TicketContactEditRequest(BaseModel):
    """Corrección de contacto del asistente.

    Nombre y teléfono son opcionales pero AL MENOS uno debe venir (la DB lo
    valida con `nothing_to_update`). La auditoría de la mig 015 guarda los
    valores anteriores.
    """

    customer_name: str | None = Field(default=None, min_length=1, max_length=200)
    customer_phone: str | None = Field(default=None, min_length=5, max_length=30)
    reason: str | None = Field(default=None, max_length=200)


class TicketContactEditResponse(BaseModel):
    """Boleta con el contacto ya corregido (sirve para actualizar la fila)."""

    ticket_id: int
    customer_name: str
    customer_phone: str | None = None
    status: str


class TicketContactEditOut(BaseModel):
    """Fila de auditoría de correcciones de contacto (mig 015).

    `old_*`/`new_*` traen ambos valores (igual si el campo no cambió en esa
    edición): el cliente muestra solo los que difieren. `edited_by_name` viene
    del JOIN con users y puede ser NULL si el usuario fue borrado.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    old_name: str | None = None
    new_name: str | None = None
    old_phone: str | None = None
    new_phone: str | None = None
    reason: str | None = None
    created_at: datetime
    edited_by_name: str | None = None


class TicketRedeemRequest(BaseModel):
    raw_token: str = Field(min_length=8)
    # Mig 013 (patrón DICE): cuando el escaneo devuelve NOT_ACTIVE, la puerta
    # pide `force` para dejar pasar a alguien cuya boleta aún no se activa
    # (lista, cortesía del dueño, QR en papel). Con force, el router consulta
    # la ventana sin exigirla: la decisión (y el registro) es del portero.
    force: bool = False
    # Filtro de fila en puerta (mig 008): si viene, una boleta válida del
    # evento pero de OTRO tipo se rechaza con code=WRONG_TYPE sin consumirla.
    ticket_type_id: int | None = None


class TicketHistoryItem(BaseModel):
    ticket_id: int
    customer_name: str
    customer_phone: str | None = None
    ticket_type: str
    is_courtesy: bool = False
    status: str
    issued_at: datetime


class TicketHistoryOut(BaseModel):
    tickets: list[TicketHistoryItem]


class UpdateVenueUser(BaseModel):
    """Edición parcial de un miembro del equipo (PATCH: solo campos enviados)."""
    full_name: str | None = Field(default=None, min_length=2, max_length=120)
    role: str | None = None
    is_active: bool | None = None

    @model_validator(mode="after")
    def _role_allowed(self):
        if self.role is not None and self.role not in {"admin", "promotor", "bouncer"}:
            raise ValueError("rol inválido")
        return self


class ResetPassword(BaseModel):
    """Reset operado por el admin: misma política que el self-service."""
    new_password: PasswordStr

    @field_validator("new_password")
    @classmethod
    def _strong_new(cls, v: str) -> str:
        return check_password_strength(v)


class RegisterRequest(BaseModel):
    """Self-service: crea la venue del negocio + la cuenta de su administrador."""
    venue_name: str = Field(min_length=2, max_length=120)
    full_name: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=5, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")
    password: PasswordStr

    @field_validator("password")
    @classmethod
    def _strong_reg(cls, v: str) -> str:
        return check_password_strength(v)


class ForgotPasswordRequest(BaseModel):
    email: str = Field(min_length=3, max_length=200)


class ResetPasswordRequest(BaseModel):
    """Canje del token del correo: self-service, sin sesión previa."""
    token: str = Field(min_length=16, max_length=256)
    new_password: PasswordStr

    @field_validator("new_password")
    @classmethod
    def _strong_new(cls, v: str) -> str:
        return check_password_strength(v)


class ChangePasswordRequest(BaseModel):
    """Cambio de contraseña propia: exige la vigente."""
    current_password: str = Field(max_length=128)
    new_password: PasswordStr

    @field_validator("new_password")
    @classmethod
    def _strong_change(cls, v: str) -> str:
        return check_password_strength(v)


class UpdateProfileRequest(BaseModel):
    """Datos propios editables por el usuario (nombre visible en la app)."""
    full_name: str = Field(min_length=2, max_length=120)


class UpdateVenueRequest(BaseModel):
    """Edición del negocio por su admin: nombre y logo (URL http(s));
    logo_url="" limpia el logo."""
    name: str | None = Field(default=None, min_length=2, max_length=120)
    logo_url: str | None = Field(default=None, max_length=500)
    # Comision del promotor (0-100): base del calculo de liquidaciones.
    commission_pct: float | None = Field(default=None, ge=0, le=100)

    @model_validator(mode="after")
    def _logo_url_shape(self):
        if self.logo_url:
            u = self.logo_url.strip()
            # Igual que el flyer: enlace http(s) público o imagen subida a
            # /media/{id} (misma página, sin fetch de red posible).
            if u.startswith("/media/"):
                if not re.match(r"^/media/[0-9]{1,12}$", u):
                    raise ValueError("logo_url interna inválida")
            else:
                if not (u.startswith("http://") or u.startswith("https://")):
                    raise ValueError("logo_url debe ser una URL http(s)")
                # Guardia SSRF: hosts que resuelven a IPs internas se rechazan
                # (defensa en profundidad para descargas server-side futuras).
                validate_public_http_url(u)
            self.logo_url = u
        return self


class DeleteAccountRequest(BaseModel):
    """Borrado definitivo de la propia cuenta (requiere confirmar password)."""
    password: str


class PurgeUserRequest(BaseModel):
    """Eliminación definitiva de un usuario de la venue por el admin.

    `confirm` debe ser el email del usuario: protección contra borrar a
    alguien por error (la acción no tiene deshacer)."""
    confirm: str


class DeleteEventRequest(BaseModel):
    """Borrado definitivo de un evento: `confirm` = nombre exacto del evento."""
    confirm: str


# --------------------------------------------------------------------------
# Web Push (suscripción de dispositivos)
# --------------------------------------------------------------------------
class PushKeys(BaseModel):
    """Claves criptográficas que entrega pushManager.subscribe() (RFC 8291)."""
    p256dh: str = Field(min_length=20, max_length=200)
    auth: str = Field(min_length=8, max_length=100)


class PushSubscribeRequest(BaseModel):
    """Suscripción tal cual llega de pushManager.subscribe(), + la venue.

    `endpoint` debe ser https: los push services reales solo usan https y
    así se evita guardar URLs malformadas."""
    venue_id: int
    endpoint: str = Field(min_length=20, max_length=1000, pattern=r"^https://")
    keys: PushKeys


class PushUnsubscribeRequest(BaseModel):
    endpoint: str = Field(min_length=20, max_length=1000)


class TicketLookupRequest(BaseModel):
    """Identifica una boleta por su token crudo (el contenido del QR).

    El token es la credencial: ~192 bits, no adivinable. Quien lo tiene puede
    ver la boleta, por eso no se expone telefono ni correo en la respuesta.
    """

    raw_token: str = Field(min_length=8, max_length=200)


class TicketReturnRequest(BaseModel):
    """Devolucion del invitado (E1): token crudo + id de la boleta.

    El id va JUNTO al token para que la DB verifique que ese token sigue
    siendo la credencial vigente de esa boleta (hash esperado): cierra la
    carrera con reissue sin exponer nada nuevo.
    """

    ticket_id: int
    raw_token: str = Field(min_length=8, max_length=200)


class PublicTicketOut(BaseModel):
    """Datos minimos para pintar la boleta del invitado. Sin PII de contacto."""

    ticket_id: int
    customer_name: str
    event_name: str
    venue_name: str
    # Lugar del evento (mig 014): la boleta del invitado dice DÓNDE es.
    location: str | None = None
    starts_at: str
    status: str
    # Activación del QR (mig 013, patrón DICE): visible solo dentro de la
    # ventana; `qr_message` explica cuándo se activa si aún no es hora.
    qr_active: bool = True
    qr_message: str | None = None
    # Devolución (E1, "No puedo ir"): el botón se ofrece solo mientras la
    # ventana está abierta (antes del unlock del QR); `return_until` es la
    # fecha límite formateada para que el invitado vea hasta CUÁNDO puede.
    can_return: bool = False
    return_until: str | None = None
    # La boleta anulada puede ser una DEVOLUCIÓN del invitado (copa distinta
    # en la página) o una anulación de staff: ticket_returns lo distingue.
    was_returned: bool = False


class TicketReturnOut(BaseModel):
    """Resultado de una devolucion (E1): la boleta queda anulada y auditada."""

    ticket_id: int
    status: str = "returned"


class PaymentCreateRequest(BaseModel):
    """El admin cobra una boleta de pago online (E3, Wompi).

    El monto lo define el admin en el momento del cobro (precio negociado,
    descuento a ojo): la boleta se emite con price_cents_snapshot = este
    monto. El comprador ya existe en el flujo del bar: nombre + telefono,
    email opcional.
    """

    ticket_type_id: int
    amount_in_cents: int = Field(gt=0, le=500_000_000)  # tope de sanidad
    customer_name: str = Field(min_length=1, max_length=200)
    customer_phone: str = Field(min_length=5, max_length=30)
    customer_email: str | None = Field(default=None, max_length=200)


class PaymentCreateOut(BaseModel):
    """Cobro creado: la URL de Wompi se manda al cliente por WhatsApp.

    `reference` es la llave interna del ciclo (webhook -> cobro -> boleta).
    """

    payment_id: int
    reference: str
    payment_url: str
    amount_in_cents: int
    status: str = "pending"


class PaymentOut(BaseModel):
    """Cobro para el listado del dashboard (con la boleta emitida, si la hay)."""

    id: int
    reference: str
    status: str
    amount_in_cents: int
    customer_name: str
    customer_phone: str
    customer_email: str | None = None
    payment_url: str | None = None
    ticket_id: int | None = None
    transaction_id: str | None = None
    approved_at: datetime | None = None
    created_at: datetime


class PaymentsListOut(BaseModel):
    total: int
    items: list[PaymentOut]


class WaitlistJoinRequest(BaseModel):
    """El fan entra a la fila de un evento agotado (E2). Sin cuentas: el
    telefono es la identidad (UNIQUE por evento) y el token crudo que
    devuelve el join es su credencial para reclamar o salir."""

    name: str = Field(min_length=2, max_length=120)
    phone: str = Field(min_length=5, max_length=30)


class WaitlistJoinOut(BaseModel):
    """Respuesta del join: el token crudo viaja UNA sola vez (hash en DB)."""

    token: str
    position: int
    status: str = "waiting"


class WaitlistStatusOut(BaseModel):
    """Estado de la fila para la pagina del fan (sin PII de contacto)."""

    status: str
    position: int | None = None
    event_name: str
    venue_name: str
    starts_at: str
    # Ventana de reclamo cuando status == 'offered': hasta cuando puede
    # reclamar y cuantos segundos le quedan (para el countdown de la UI).
    offer_expires_at: str | None = None
    offer_seconds_left: int | None = None


class WaitlistTokenRequest(BaseModel):
    """Credencial del fan en la fila: el token crudo del join, en el cuerpo
    (nunca en la URL) igual que el token de la boleta."""

    token: str = Field(min_length=8, max_length=200)


class WaitlistClaimOut(BaseModel):
    """Reclamo exitoso: boleta NUEVA con su token crudo de una sola vez."""

    ticket_id: int
    raw_token: str
    status: str = "claimed"


class RedeemOut(BaseModel):
    code: str = ""  # GRANTED | ALREADY_REDEEMED | NOT_FOUND | INVALID_EVENT | EVENT_NOT_LIVE | NOT_VALID | WRONG_TYPE
    ticket_id: int | None = None
    customer_name: str | None = None
    redeemed: bool = False
    # Detalle opcional para la puerta (p.ej. WRONG_TYPE: "Boleta de General").
    detail: str | None = None


class DoorSnapshotEntry(BaseModel):
    """Fila del snapshot de puerta (modo offline del escáner).

    SOLO lleva el hash del token: el crudo nunca sale de la DB ni siquiera
    en forma derivada, y un hash no sirve para emitir ni reemitir.
    """

    h: str  # SHA-256 hex del token crudo (tickets.token_hash)
    s: str  # status: issued | redeemed | voided | refunded
    t: int | None = None  # ticket_type_id (para el filtro de fila)
    n: str | None = None  # nombre del asistente (para el log de puerta)


class DoorSnapshotOut(BaseModel):
    """Snapshot completo de las boletas VIVAS de un evento.

    Lo descarga el escáner al abrir la puerta; mientras no haya red, valida
    localmente contra esta lista (comparando SHA-256 del token escaneado).
    Las redenciones hechas offline se sincronizan después contra la DB,
    que sigue siendo el árbitro final.
    """

    event_id: int
    generated_at: datetime
    count: int
    live_event: bool  # status del evento == live (la puerta está abierta)
    entries: list[DoorSnapshotEntry]


class DoorSyncItem(BaseModel):
    """Una redención hecha offline, enviada cuando vuelve la red."""

    raw_token: str = Field(min_length=8)
    scanned_at: datetime | None = None  # cuándo se validó en la puerta
    ticket_type_id: int | None = None


class DoorSyncOut(BaseModel):
    """Resultado de reconciliar la cola offline de un bouncer.

    La DB re-evalúa CADA token con redeem_ticket: el snapshot puede estar
    viejo (boleta anulada después de descargarlo) y la DB manda.
    """

    processed: int
    granted: int
    already_redeemed: int
    rejected: int  # not_found / not_valid / wrong_type / invalid_event


# --------------------------------------------------------------------------
# Ciclo de vida / anulación / usuarios de la venue
# --------------------------------------------------------------------------
class VoidRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


class VenueUserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: str
    full_name: str
    roles: list[str] = []
    is_active: bool = True


# --------------------------------------------------------------------------
# Módulo Equipo: métricas de productividad por persona
# --------------------------------------------------------------------------
class MemberQuota(BaseModel):
    """Ventas del miembro contra su cupo (promotores)."""
    capacity: int = 0
    issued: int = 0
    redeemed: int = 0
    revenue_cents: int = 0
    allocations: int = 0


class MemberDoor(BaseModel):
    """Trabajo en puerta (porteros): escaneos buenos, bloqueados y totales."""
    granted: int = 0
    rejected: int = 0
    total: int = 0


class TeamMemberOut(BaseModel):
    id: int
    email: str
    full_name: str
    roles: list[str] = []
    is_active: bool = True
    last_login_at: datetime | None = None
    member_since: datetime | None = None
    quota: MemberQuota = MemberQuota()
    door: MemberDoor = MemberDoor()


class TeamStatsOut(BaseModel):
    """Resumen ejecutivo del equipo: KPIs + detalle por miembro."""
    total_members: int
    active_members: int
    promoters_active: int
    bouncers_active: int
    # Personal operativo que entró a trabajar dentro de la ventana (last_login).
    active_in_window: int
    days_window: int
    members: list[TeamMemberOut]
    by_role: dict[str, list[int]]


class CreateVenueUser(BaseModel):
    """Alta de personal de la venue (equipo) desde la UI del admin.

    super_admin NO se admite aqui: es un rol de plataforma, se asigna por DB.
    Si el email ya existe (ej. promotor de otro evento), solo se le agrega el
    rol en esta venue (idempotente).
    """
    email: str = Field(min_length=5, max_length=200, pattern=_EMAIL_RE.pattern)
    full_name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=8, max_length=128)
    role: str = Field(pattern=r"^(admin|promotor|bouncer)$")


class TicketOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    customer_name: str
    customer_phone: str | None = None
    customer_email: str | None = None
    status: str
    issued_at: datetime
    price_cents_snapshot: int
    type_name: str | None = None
    sold_by_name: str | None = None
    from_allocation: bool = False


class TicketListOut(BaseModel):
    """Respuesta paginada del listado de boletas.

    `total` (con filtros, sin paginar) permite a la UI pintar "128 boletas ·
    página 2 de 3" sin una segunda llamada.
    """
    total: int
    items: list[TicketOut]


# --------------------------------------------------------------------------
# Reporte en vivo
# --------------------------------------------------------------------------
class ReportByType(BaseModel):
    """Fila del desglose por tipo de boleta.

    `issued` cuenta solo boletas ACTIVAS (no anuladas ni reembolsadas): es el
    mismo criterio que usa emit_ticket() para rechazar sobreventa, y el que
    hace que issued x price_cents sea el recaudo real del tipo.
    """
    ticket_type_id: int
    name: str
    price_cents: int
    quantity: int
    is_courtesy: bool
    is_active: bool = True
    issued: int = 0
    redeemed: int = 0
    revenue_cents: int = 0


class ReportByPromoter(BaseModel):
    """Fila del desglose por promotor (boletas emitidas contra su cupo)."""
    promoter_id: int
    full_name: str
    capacity: int
    issued: int = 0
    redeemed: int = 0


class EventReport(BaseModel):
    event_id: int
    event_name: str
    capacity: int
    issued: int
    redeemed: int
    pending: int
    voided: int
    occupancy_pct: float
    # Recaudo vivo: suma de price_cents_snapshot de las boletas activas.
    # (Anular/reembolsar lo baja; emitir lo sube. NO es "lo vendido histórico".)
    revenue_cents: int = 0
    by_type: list[ReportByType]
    by_promoter: list[ReportByPromoter]


class DoorScanStats(BaseModel):
    """Integridad de la puerta: cuanto paso y cuanto no cuadro."""

    granted: int = 0
    already_redeemed: int = 0
    not_found: int = 0
    other_failed: int = 0
    failed: int = 0
    total: int = 0
    last_scan_at: datetime | None = None
    last_granted_at: datetime | None = None
    scanned_by: list[dict] = []


class ReportSummary(BaseModel):
    """KPIs de caja del evento. `revenue_cents` cuenta boletas vivas
    (issued + redeemed); anuladas y reembolsadas no facturan.
    """

    event_id: int
    event_name: str
    capacity: int
    issued: int
    redeemed: int
    pending: int
    voided: int
    occupancy_pct: float
    revenue_cents: int
    avg_ticket_cents: int
    paid_tickets: int
    courtesy_tickets: int
    door: DoorScanStats
    by_type: list[dict]
    by_promoter: list[dict]


class VenueOverview(BaseModel):
    """Vista agregada del negocio ENTRE eventos (la que faltaba).

    Todo el criterio es idéntico al reporte por evento: boletas vivas
    (issued + redeemed) facturan; anuladas/reembolsadas no. `month` es
    'YYYY-MM' en la zona del venue (event_timezone del primer evento del mes
    es demasiado; se usa la hora del servidor con la zona pedida).
    """

    month: str
    # Mes seleccionado
    events_count: int
    tickets_issued: int
    tickets_redeemed: int
    revenue_cents: int
    courtesy_tickets: int
    avg_ticket_cents: int
    # Tendencia: mismo agregado del mes anterior (la UI calcula el delta)
    prev_revenue_cents: int
    prev_tickets_issued: int
    prev_events_count: int
    # Rankings del mes
    top_promoters: list[dict]   # [{name, tickets, revenue_cents}]
    top_events: list[dict]      # [{id, name, starts_at, status, tickets, revenue_cents}]


class MessageOut(BaseModel):
    detail: str

# --------------------------------------------------------------------------
# Liquidaciones de promotores (mig 010)
# --------------------------------------------------------------------------
class PayoutGenerateRequest(BaseModel):
    """Cierre de liquidacion de un promotor por rango de fechas."""
    promoter_id: int
    period_start: date
    period_end: date


class PayoutReviewRequest(BaseModel):
    """Resolucion del admin sobre una liquidacion."""
    action: str = Field(pattern="^(pay|reject)$")
    paid_cents: int | None = Field(default=None, ge=0)
    note: str | None = Field(default=None, max_length=500)


class PayoutDisputeRequest(BaseModel):
    """Disputa del promotor: por que considera que la liquidacion no cuadra."""
    reason: str = Field(min_length=10, max_length=500)


class PayoutOut(BaseModel):
    id: int
    promoter_id: int
    promoter_name: str = ""
    period_start: date
    period_end: date
    tickets_count: int
    revenue_cents: int
    commission_pct: float
    commission_cents: int
    status: str
    paid_cents: int | None = None
    paid_at: datetime | None = None
    disputed_reason: str | None = None
    review_note: str | None = None
    reviewed_at: datetime | None = None
    created_at: datetime


# --------------------------------------------------------------------------
# Invitaciones de staff (alta de personal por enlace de un solo uso)
# --------------------------------------------------------------------------
class StaffInvitationCreate(BaseModel):
    """El admin invita a una persona a su equipo sin inventar contraseñas."""
    full_name: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=5, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")
    role: Literal["promotor", "bouncer", "admin"] = "promotor"
    expires_hours: int = Field(default=72, ge=1, le=336)


class StaffInvitationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    role: str
    full_name: str
    email: str
    expires_at: datetime
    created_at: datetime
    accepted_at: datetime | None = None
    revoked_at: datetime | None = None


class StaffInvitationCreated(StaffInvitationOut):
    """El token en claro viaja SOLO en esta respuesta de creación."""
    invite_url: str


class AcceptInvitationRequest(BaseModel):
    token: str = Field(min_length=32, max_length=128)
    password: str = Field(min_length=8, max_length=128)


class InvitationPreview(BaseModel):
    """Lo único que ve el invitado antes de aceptar (sin datos sensibles)."""
    role: str
    full_name: str
    venue_name: str
    expires_at: datetime


# --------------------------------------------------------------------------
# Notificaciones in-app (mig 012, transplante de unicall-blue)
# --------------------------------------------------------------------------
class NotificationOut(BaseModel):
    """Fila del feed de notificaciones del usuario autenticado.

    `kind` permite al frontend elegir icono y color por tipo sin parsear el
    texto; `link` es la ruta interna a la que lleva el tap (opcional).
    """
    id: int
    kind: str
    title: str
    body: str
    link: str | None = None
    read_at: datetime | None = None
    created_at: datetime


class NotificationReadRequest(BaseModel):
    """ids vacío = marcar todas; con ids = solo esas (ajenas se ignoran)."""
    ids: list[int] = Field(default_factory=list, max_length=200)


# --------------------------------------------------------------------------
# Personal por evento (mig 025): "quién trabaja esta noche" + link de puerta
# --------------------------------------------------------------------------
class EventStaffOut(BaseModel):
    """Una persona del roster de una noche."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    user_id: int
    full_name: str
    email: str
    # Rol DENTRO de la noche: "bouncer" (puerta) o "promotor" (venta).
    role: Literal["bouncer", "promotor"]
    shift_start: datetime | None = None
    shift_end: datetime | None = None
    created_at: datetime
    # Si tiene un link de puerta vigente (para saber si hay que emitirlo).
    has_link: bool = False


class EventStaffCreate(BaseModel):
    """Asigna (o reasigna) a alguien a una noche."""
    user_id: int
    role: Literal["bouncer", "promotor"] = "bouncer"
    # Turno opcional: sin esto el link vale para la noche entera.
    shift_start: datetime | None = None
    shift_end: datetime | None = None


class EventAccessOut(BaseModel):
    """El link de puerta emitido. El token en claro viaja SOLO acá."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_id: int
    event_name: str
    user_id: int
    access_url: str
    expires_at: datetime
    created_at: datetime


class EventAccessPreview(BaseModel):
    """Lo que ve el bouncer al abrir el link, antes de canjearlo."""
    event_id: int
    event_name: str
    event_status: str
    starts_at: datetime
    full_name: str
    expires_at: datetime
    used: bool = False
    revoked: bool = False


class EventAccessGranted(BaseModel):
    """Respuesta del canje: a qué noche quedó atada esta persona."""
    event_id: int
