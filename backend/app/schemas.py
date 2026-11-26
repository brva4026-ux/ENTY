import re
from datetime import date, datetime
from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from app.core.categories import validate_event_category
from app.core.password_policy import PasswordStr, check_password_strength
from app.core.urlguard import validate_flyer_url, validate_public_http_url
from app.core.usernames import is_valid_username, normalize_username

# Regex de email pragmática: acepta tlds de prueba (.test, .local) y hosts reales.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------
class LoginRequest(BaseModel):
    # `identifier` acepta correo O nombre de usuario (mig 035): la gente de
    # puerta entra desde el celular y escribir "puerta@bar.test" en un teclado
    # tactil es friccion en el momento mas caliente del dia. El campo se llama
    # `identifier` y no `email` porque ya no es solo un correo; se mantiene
    # `email` como alias opcional para no romper a los clientes que ya lo mandan.
    identifier: str | None = Field(default=None, min_length=3, max_length=200)
    email: str | None = Field(default=None, min_length=3, max_length=200)
    # max_length=128: sin cota, el cuerpo del login era un vector de DoS barato
    # (bcrypt de un string de megabytes consume CPU real por request).
    password: str = Field(max_length=128)
    # "Recordarme": marcado (default) la cookie de sesion persiste tras cerrar
    # el navegador; sin marcar es una cookie de sesion. No cambia el token.
    remember: bool = True

    @model_validator(mode="after")
    def _one_identifier(self):
        """Exige exactamente un identificador y normaliza `identifier`."""
        value = (self.identifier or self.email or "").strip()
        if not value:
            raise ValueError("Falta el usuario o el correo.")
        self.identifier = value
        return self


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserSummary"


class UserSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: str
    full_name: str
    # Nombre de usuario para entrar (mig 035). Las cuentas nuevas siempre
    # reciben uno; None solo queda en cuentas legadas que aun no pasaron por la
    # migracion 058. El login por correo sigue funcionando igual.
    username: str | None = None
    # Telefono de contacto de la persona. La columna existe desde el esquema
    # base (`users.phone`) pero nunca se exponia: el perfil solo mostraba el
    # correo. None = sin telefono, que es un estado valido.
    phone: str | None = None
    # Contacto personal alternativo (mig 059). No es el correo de acceso: es
    # el que la persona decide compartir con su equipo.
    contact_email: str | None = None
    share_contact_with_team: bool = False
    venues: list["VenueSummary"] = []
    roles: dict[str, list[str]] = {}  # {"<venue_id>": ["admin", ...]}
    # Contexto de cuenta para el perfil: desde cuándo es parte y cuándo entró
    # por última vez. `last_login_at` es None hasta el primer login.
    created_at: datetime | None = None
    last_login_at: datetime | None = None
    # Fecha del último cambio de contraseña (mig 037). None en las cuentas que
    # nunca la cambiaron desde que existe la columna: no se inventa un valor
    # con created_at, porque es un dato de seguridad.
    password_changed_at: datetime | None = None
    # Foto de perfil (mig 038): URL relativa de `media` (/media/{id}). None =
    # sin foto, y el hero pinta las iniciales con el anillo del rol.
    avatar_url: str | None = None
    # Negocio activo (mig 040): con cuál abren los paneles del staff. Es una
    # preferencia de la PERSONA, no del navegador: el mismo admin que elige su
    # bar en la laptop lo ve elegido en el celular. None = sin elegir, y el
    # frontend cae al primer negocio disponible (mismo default de siempre).
    active_venue_id: int | None = None
    # Cambio de correo pendiente de verificación (mig 059). El correo de acceso
    # sigue siendo `email` hasta que se canjea el enlace del buzón nuevo; este
    # campo permite que la UI lo recuerde tras recargar.
    pending_email: str | None = None
    # Primera entrada al panel (mig 058). Null en una cuenta nueva: el panel le
    # muestra el usuario generado y las dos salidas. Se marca al elegir una.
    welcome_seen_at: datetime | None = None


class VenueSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    slug: str
    logo_url: str | None = None
    primary_color: str | None = None
    commission_pct: float = 0
    # Contacto del organizador (mig 036): el telefono que la pagina publica
    # ofrece para "encarga tu boleta". NULL mientras el negocio no lo publique.
    contact_name: str | None = None
    contact_phone: str | None = None
    contact_email: str | None = None
    # Permisos de contacto (mig 059). Compartir con el equipo y publicar en
    # fichas son decisiones separadas: una no implica la otra.
    contact_team_visible: bool = True
    public_contact_enabled: bool = False
    public_contact_channels: list[str] = []
    # "Mi organización" es un nombre interno mientras la persona no configure
    # su identidad publica (mig 058). No se publica en fichas ni boletas.
    is_placeholder: bool = False


# --------------------------------------------------------------------------
# Preferencias por usuario y negocio (mig 032)
# --------------------------------------------------------------------------
# Los dos estados que el panel puede ESCRIBIR. `pending` es el default de la
# DB y no se escribe nunca desde el cliente: la ausencia de fila ya significa
# "sin decidir", asi que un valor explicito seria redundante.
PreferenceState = Literal["accepted", "dismissed", "completed"]
PreferenceKey = Literal["onboarding", "tutorial"]


class PreferenceOut(BaseModel):
    """Una preferencia tal como la consume el panel."""
    key: PreferenceKey
    value: Literal["pending", "accepted", "dismissed", "completed"] = "pending"
    # Posicion guardada dentro de la guia/tutorial (0 = arrancar de cero).
    step: int = 0
    updated_at: datetime | None = None


class PreferencesOut(BaseModel):
    """Todas las preferencias del usuario en un negocio, en una sola lectura.

    Se devuelven SIEMPRE las dos claves (aunque no haya fila), ya en
    `pending`: el panel no tiene que distinguir "no existe" de "sin decidir",
    que para el usuario son el mismo estado.
    """
    venue_id: int
    preferences: list[PreferenceOut]


class UpdatePreferenceRequest(BaseModel):
    value: PreferenceState
    # Paso actual dentro del tutorial (0 = empezando). Solo lo usa la clave
    # "tutorial"; en "onboarding" se ignora.
    step: int | None = Field(default=None, ge=0, le=999)


class SetActiveVenueRequest(BaseModel):
    """Negocio activo elegido por el staff (mig 040).

    Global del usuario (no por venue): con cuál abren sus paneles. El backend
    verifica que el usuario tenga rol en ese negocio antes de guardarlo.
    """
    venue_id: int


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
    # Identidad pública (mig 057). El video no se sube a `media` (esa tabla es
    # de imágenes y el cuerpo de la función de Vercel es chico): se publica en
    # un hosting y se pega el enlace. `location_url` es el mapa que el
    # organizador CONFIRMA; sin él la ficha no inventa uno.
    video_url: str | None = Field(default=None, max_length=2000)
    location_url: str | None = Field(default=None, max_length=2000)
    contact_name: str | None = Field(default=None, max_length=120)
    contact_phone: str | None = Field(default=None, max_length=40)

    @field_validator("flyer_url")
    @classmethod
    def _flyer_public(cls, v):
        return validate_flyer_url(v) if v else v

    @field_validator("video_url")
    @classmethod
    def _video_public(cls, v):
        return validate_public_http_url(v, label="video") if v else v

    @field_validator("location_url")
    @classmethod
    def _location_public(cls, v):
        return validate_public_http_url(v, label="enlace") if v else v

    @field_validator("contact_name", "contact_phone")
    @classmethod
    def _contact_clean(cls, v):
        if v is None:
            return None
        return v.strip() or None

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, v: str) -> str:
        # min_length=1 deja pasar "   ": hay que exigir contenido real, no solo
        # longitud. El nombre viaja a la boleta y al og:image de WhatsApp.
        if not v.strip():
            raise ValueError("El nombre del evento no puede estar en blanco")
        return v.strip()

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
    # Mig 043: categoría elegida (None = el catálogo la infiere del texto),
    # ficha del invitado y apertura de puertas.
    category: str | None = None

    @field_validator("category")
    @classmethod
    def _category_allowed(cls, v):
        return validate_event_category(v)

    min_age: int | None = Field(default=None, ge=0, le=99)
    dress_code: str | None = Field(default=None, max_length=200)
    doors_open_at: datetime | None = None

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
    # Identidad pública (mig 057). Un string vacío limpia el campo: la ficha
    # vuelve a mostrar solo lo que esté confirmado.
    video_url: str | None = Field(default=None, max_length=2000)
    location_url: str | None = Field(default=None, max_length=2000)
    contact_name: str | None = Field(default=None, max_length=120)
    contact_phone: str | None = Field(default=None, max_length=40)
    # Control de concurrencia optimista (mig 073): el editor envía la versión
    # que cargó. Si otra persona guardó antes, el API responde 409 con la
    # versión actual en vez de pisarla en silencio.
    expected_updated_at: datetime | None = None

    @field_validator("flyer_url")
    @classmethod
    def _flyer_public(cls, v):
        return validate_flyer_url(v) if v else v

    @field_validator("video_url")
    @classmethod
    def _video_public(cls, v):
        return validate_public_http_url(v, label="video") if v else v

    @field_validator("location_url")
    @classmethod
    def _location_public(cls, v):
        return validate_public_http_url(v, label="enlace") if v else v

    @field_validator("contact_name", "contact_phone")
    @classmethod
    def _contact_clean(cls, v):
        if v is None:
            return None
        return v.strip() or None

    location: str | None = Field(default=None, max_length=200)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    event_timezone: str | None = Field(default=None, max_length=60)
    capacity: int | None = Field(default=None, gt=0)
    qr_unlock_minutes: int | None = Field(default=None, ge=0, le=10080)
    # Mig 043: categoría, ficha del invitado y apertura de puertas. Un string
    # vacío en category limpia la elección (vuelve a la heurística).
    category: str | None = None

    @field_validator("category")
    @classmethod
    def _category_allowed(cls, v):
        return validate_event_category(v, allow_blank=True)

    min_age: int | None = Field(default=None, ge=0, le=99)
    dress_code: str | None = Field(default=None, max_length=200)
    doors_open_at: datetime | None = None

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


class LineupItemOut(BaseModel):
    """Un acto del lineup (mig 043). `role` es libre: DJ, telonero, host..."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    role: str | None = None
    sort_order: int = 0
    image_url: str | None = None
    starts_at: datetime | None = None
    description: str | None = None


class LineupItemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("El nombre del acto no puede estar en blanco")
        return v.strip()

    role: str | None = Field(default=None, max_length=60)
    sort_order: int = Field(default=0, ge=0, le=9999)
    image_url: str | None = Field(default=None, max_length=500)
    starts_at: datetime | None = None
    description: str | None = Field(default=None, max_length=500)



class EventChangeNoticeOut(BaseModel):
    """Aviso de cambio de evento que ve un comprador."""

    id: int
    kind: str
    title: str
    message: str
    created_at: datetime
    affected_tickets: int = 0
    affected_buyers: int = 0


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
    # Identidad pública (mig 057): clip opcional, mapa confirmado y contacto
    # del evento (NULL = cae al contacto del local en la ficha pública).
    video_url: str | None = None
    location_url: str | None = None
    contact_name: str | None = None
    contact_phone: str | None = None
    # Lugar del evento (mig 014): el formulario lo edita y la boleta del
    # invitado lo muestra.
    location: str | None = None
    starts_at: datetime
    ends_at: datetime | None = None
    event_timezone: str
    capacity: int
    qr_unlock_minutes: int = 60
    status: str
    # Versión de la fila para el bloqueo optimista del editor (mig 073).
    updated_at: datetime | None = None
    # Mig 043: categoría elegida (NULL = sin elegir -> el catálogo cae a la
    # heurística), ficha del invitado y lineup.
    category: str | None = None
    min_age: int | None = None
    dress_code: str | None = None
    doors_open_at: datetime | None = None
    lineup: list[LineupItemOut] = Field(default_factory=list)
    # Último aviso de cambio (fecha, lugar, cancelación) y su impacto. Solo se
    # llena en las respuestas de edición/transición y en el detalle del evento.
    change_notice: EventChangeNoticeOut | None = None
    affected_tickets: int = 0
    affected_buyers: int = 0
    # Evento hijo: una jornada de un evento con varias fechas. NULL = evento
    # raíz. La UI de sesiones lo usa para agrupar.
    parent_event_id: int | None = None


class ZoneCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    capacity: int = Field(gt=0)
    sort_order: int = 0


class ZoneUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    capacity: int | None = Field(default=None, gt=0)
    sort_order: int | None = None


class ZoneOccupancyOut(BaseModel):
    id: int
    name: str
    capacity: int
    inside: int = 0
    free_seats: int = 0
    status: str = "open"


class ZoneTicketTypeOut(BaseModel):
    id: int
    name: str
    quantity: int
    issued: int = 0


class EventZoneOut(ZoneOccupancyOut):
    event_id: int
    sort_order: int = 0
    ticket_type_count: int = 0
    ticket_type_names: list[str] = Field(default_factory=list)
    issued: int = 0
    ticket_types: list[ZoneTicketTypeOut] = Field(default_factory=list)


class TicketTypeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    price_cents: int = Field(ge=0)
    quantity: int = Field(gt=0)
    is_courtesy: bool = False
    zone_id: int | None = None


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
    # Localidad técnica de un pase: se emite en la jornada pero no se vende
    # suelta. La ficha pública la esconde.
    is_pass_only: bool = False
    # Zona física del recinto (mig 070). NULL = sin zona configurada.
    zone_id: int | None = None
    zone_name: str | None = None


class EventSessionCreate(BaseModel):
    """Una jornada de un evento con varias fechas."""

    name: str = Field(min_length=1, max_length=160)
    starts_at: datetime
    ends_at: datetime | None = None
    capacity: int = Field(gt=0)


class EventSessionOut(BaseModel):
    id: int
    name: str
    starts_at: datetime
    ends_at: datetime | None = None
    capacity: int
    status: str
    pass_ticket_type_id: int | None = None
    issued: int = 0


class PassCreate(BaseModel):
    """Pase que cubre varias sesiones del mismo evento."""

    name: str = Field(min_length=1, max_length=60)
    price_cents: int = Field(ge=0)
    quantity: int = Field(gt=0)
    session_ids: list[int] = Field(min_length=1)


class PassSessionOut(BaseModel):
    session_event_id: int
    session_name: str
    starts_at: datetime
    session_ticket_type_id: int


class PassOut(BaseModel):
    id: int
    name: str
    price_cents: int
    quantity: int
    is_active: bool
    sessions: list[PassSessionOut] = Field(default_factory=list)


class EventCostCreate(BaseModel):
    description: str = Field(min_length=1, max_length=160)
    category: str = Field(default="otro", max_length=40)
    amount_cents: int = Field(ge=0)
    status: Literal["estimated", "committed", "paid"] = "estimated"
    notes: str | None = Field(default=None, max_length=500)


class EventCostUpdate(BaseModel):
    description: str | None = Field(default=None, min_length=1, max_length=160)
    category: str | None = Field(default=None, max_length=40)
    amount_cents: int | None = Field(default=None, ge=0)
    status: Literal["estimated", "committed", "paid"] | None = None
    notes: str | None = Field(default=None, max_length=500)


class EventCostOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    description: str
    category: str
    amount_cents: int
    status: str
    notes: str | None = None
    created_at: datetime
    updated_at: datetime


class BreakEvenOut(BaseModel):
    """Cuánto cuesta la noche y cuánto falta por vender para cubrirlo."""

    event_id: int
    capacity: int
    live_tickets: int
    paid_tickets: int
    avg_ticket_cents: int
    avg_ticket_basis: str
    gross_revenue_cents: int
    refunded_cents: int
    collected_cents: int
    estimated_cents: int
    committed_cents: int
    paid_cents: int
    target_cents: int
    target_basis: str
    remaining_cents: int
    covered_pct: float
    tickets_remaining: int | None = None
    capacity_left: int
    projected_revenue_cents: int
    projected_result_cents: int
    status: str
    costs: list[EventCostOut] = Field(default_factory=list)


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
    zone_id: int | None = None


class AllocationCreate(BaseModel):
    ticket_type_id: int
    promoter_id: int
    capacity: int = Field(ge=0)


class AllocationUpdate(BaseModel):
    """Edición parcial de un cupo. La capacidad no puede quedar por debajo de
    las boletas ya emitidas contra ese cupo (lo valida la DB)."""
    capacity: int | None = Field(default=None, ge=0)
    is_active: bool | None = None


class AllocationBulkCreate(BaseModel):
    """Distribuir el aforo de un tipo entre varios promotores en una sola
    operación (Ley de Tesler: la aritmética es del sistema, la decisión sigue
    siendo del admin).

    `total_capacity` se reparte en partes iguales; el resto de la división va a
    los primeros de la lista, así que la suma siempre es exacta.
    """
    ticket_type_id: int
    promoter_ids: list[int] = Field(min_length=1, max_length=200)
    total_capacity: int = Field(ge=0)


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


class AllocationBulkOut(BaseModel):
    """Resultado de la distribución: los cupos resultantes y cómo se repartió."""
    allocations: list[AllocationOut]
    per_promoter: int
    remainder: int


class TicketEmitRequest(BaseModel):
    ticket_type_id: int
    allocation_id: int | None = None
    customer_name: str = Field(min_length=1, max_length=200)
    customer_phone: str = Field(min_length=5, max_length=30)
    customer_email: str | None = Field(default=None, max_length=200)
    # Fecha de nacimiento (mig 051): el staff la captura en la venta de taquilla
    # cuando el evento tiene edad mínima. Sin ella no hay verificación posible.
    customer_birth_date: date | None = None
    # Medio de pago de la venta directa (taquilla). Es lo que hace que el
    # "Recaudo" del cierre sea un arqueo y no una suma de precios: el admin
    # sabe cuánto efectivo debería haber. En una boleta gratis se ignora
    # (siempre es cortesía); sin especificar, la venta directa asume efectivo.
    payment_method: Literal["efectivo", "transferencia", "online"] | None = None
    # Idempotencia del cliente (mig 063): el mismo intento repetido por doble
    # toque, timeout o reconexión devuelve la MISMA boleta, no una segunda.
    client_request_id: str | None = Field(default=None, min_length=8, max_length=100)


class TicketEmitResponse(BaseModel):
    ticket_id: int
    raw_token: str | None = None
    status: str
    # True = la boleta ya existía para este client_request_id. `raw_token`
    # puede venir vacío: la UI debe recuperar el enlace con una reemisión
    # explícita, no asumir que la entrega ocurrió.
    duplicate: bool = False
    sale_channel: str | None = None


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
    # Puerta de origen (mig 042): "puerta-1", "VIP"... Permite medir el
    # rendimiento de cada acceso y balancear el personal. Sin valor queda NULL.
    door_id: str | None = Field(default=None, max_length=40)


class TicketHistoryItem(BaseModel):
    ticket_id: int
    customer_name: str
    customer_phone: str | None = None
    customer_email: str | None = None
    ticket_type: str
    is_courtesy: bool = False
    status: str
    issued_at: datetime
    price_cents: int = 0
    payment_method: str | None = None
    sale_channel: str = "venue"
    redeemed_at: datetime | None = None


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
    """Self-service: crea la cuenta y su espacio de trabajo.

    ``venue_name`` es opcional: quien organiza un solo evento no tiene que
    inventarse un negocio. En ese caso el servidor crea un espacio interno
    ("Mi organización") y lo marca como no publicado hasta que la persona
    configure su identidad.
    """
    venue_name: str | None = Field(default=None, max_length=120)
    full_name: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=5, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")
    password: PasswordStr
    # Aceptacion de los terminos (mig 026). El default es False a proposito: un
    # cliente viejo que no manda el campo NO registra a nadie sin aceptar. La
    # huella `terms_version` la entrega GET /legal/documents y debe volver tal
    # cual; si no coincide con la vigente, el registro responde 409.
    accepted_terms: bool = False
    terms_version: str | None = Field(default=None, max_length=80)

    @field_validator("venue_name")
    @classmethod
    def _blank_venue_is_none(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if len(v) < 2:
            raise ValueError("El nombre del negocio debe tener al menos 2 caracteres.")
        return v

    @field_validator("full_name")
    @classmethod
    def _full_name_trimmed(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Escribe tu nombre completo.")
        return v

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


class ChangeEmailRequest(BaseModel):
    """Cambio del correo de la cuenta: exige la contraseña vigente.

    Mismo patrón de validación que el correo del registro, y por el mismo
    motivo: el backend no confía en que el cliente ya lo haya comprobado.
    """
    current_password: str = Field(max_length=128)
    new_email: str = Field(
        min_length=5, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$"
    )


class EmailChangeRequestOut(BaseModel):
    """Respuesta al pedir un cambio de correo.

    El correo NO cambia hasta que se canjea el enlace enviado al nuevo
    buzón. `verification_sent=false` significa que el proveedor de email no
    está configurado: no se puede completar el cambio.
    """
    detail: str
    verification_sent: bool
    pending_email: str


class EmailChangeConfirmRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)


class ExportDataRequest(BaseModel):
    """Descarga de datos con reautenticación."""
    password: str = Field(max_length=128)


class SessionOut(BaseModel):
    id: int
    device: str
    created_at: datetime
    last_seen_at: datetime
    current: bool


class SecurityEventOut(BaseModel):
    id: int
    kind: str
    detail: str | None = None
    created_at: datetime


class RevokeSessionRequest(BaseModel):
    password: str = Field(max_length=128)


class ChangePasswordRequest(BaseModel):
    """Cambio de contraseña propia: exige la vigente."""
    current_password: str = Field(max_length=128)
    new_password: PasswordStr

    @field_validator("new_password")
    @classmethod
    def _strong_change(cls, v: str) -> str:
        return check_password_strength(v)


class AvatarUpload(BaseModel):
    """data-URL de la foto de perfil, ya reducida en el navegador.

    Mismo limite que MediaUpload: por encima de eso no llega ni a decodificar.
    """
    data_url: str = Field(max_length=1_200_000)


class UpdateProfileRequest(BaseModel):
    """Datos propios editables por el usuario (nombre visible en la app)."""
    full_name: str = Field(min_length=2, max_length=120)
    # El usuario se puede cambiar desde el perfil. None lo deja como esta; ""
    # se rechaza porque toda cuenta debe conservar un identificador de acceso
    # (si el cambio falla, se conserva el anterior).
    username: str | None = Field(default=None, max_length=32)
    # Misma convencion que `username`: None deja el valor actual, "" lo limpia.
    # Opcional: la cuenta funciona sin telefono.
    phone: str | None = Field(default=None, max_length=30)
    contact_email: str | None = Field(default=None, max_length=200)
    share_contact_with_team: bool | None = None

    @field_validator("full_name")
    @classmethod
    def _full_name_shape(cls, v: str) -> str:
        name = v.strip()
        if len(name) < 2:
            raise ValueError("El nombre debe tener al menos 2 caracteres.")
        return name

    @field_validator("contact_email")
    @classmethod
    def _contact_email_shape(cls, v: str | None) -> str | None:
        if v is None:
            return None
        email = v.strip().lower()
        if not email:
            return ""
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]{2,}", email):
            raise ValueError("Escribe un correo de contacto válido.")
        return email

    @field_validator("phone")
    @classmethod
    def _phone_format(cls, v: str | None) -> str | None:
        """Acepta como la gente escribe un telefono (+57 300 123 4567) pero no
        cualquier cadena. Se guarda tal cual: sin normalizar el pais ni quitar
        el formato, porque el numero sirve para marcar, no para comparar."""
        if v is None:
            return None
        limpio = v.strip()
        if not limpio:
            return ""
        if not re.fullmatch(r"\+?[0-9][0-9 ()\-]{5,29}", limpio):
            raise ValueError("Escribe un telefono valido (ej. +57 300 123 4567).")
        return limpio

    @field_validator("username")
    @classmethod
    def _username_format(cls, v: str | None) -> str | None:
        """Misma normalizacion y formato que el login y la DB (mig 035/058)."""
        if v is None:
            return None
        candidate = normalize_username(v)
        if not candidate:
            raise ValueError("Elige un nombre de usuario.")
        if not is_valid_username(candidate):
            raise ValueError(
                "El usuario debe tener entre 3 y 32 caracteres: "
                "letras, numeros, punto, guion o guion bajo."
            )
        return candidate


class UpdateVenueRequest(BaseModel):
    """Edición del negocio por su admin: nombre, logo (URL http(s)) y color de
    marca; logo_url="" limpia el logo, primary_color="" vuelve al de la marca."""
    name: str | None = Field(default=None, min_length=2, max_length=120)
    logo_url: str | None = Field(default=None, max_length=500)
    # Comision del promotor (0-100): base del calculo de liquidaciones.
    commission_pct: float | None = Field(default=None, ge=0, le=100)
    # Color de marca del negocio (hex #RRGGBB). Se usa para teñir su panel:
    # banner, tile del logo y viga del KPI. "" lo devuelve al violeta de Enty.
    primary_color: str | None = Field(default=None, max_length=7)
    # Contacto del organizador (mig 036): lo que la pagina publica muestra en
    # "encarga tu boleta". "" limpia el dato (vuelve a NULL) y el bloque
    # publico desaparece: un negocio no esta obligado a publicar telefono.
    contact_name: str | None = Field(default=None, max_length=80)
    contact_phone: str | None = Field(default=None, max_length=40)
    contact_email: str | None = Field(default=None, max_length=200)
    contact_team_visible: bool | None = None
    public_contact_enabled: bool | None = None
    public_contact_channels: list[str] | None = None
    # Imagen del logo ya reducida por el navegador. Si viene, gana sobre
    # logo_url: el archivo se guarda en media y la URL se calcula en el server.
    logo_data_url: str | None = Field(default=None, max_length=1_200_000)

    @field_validator("name")
    @classmethod
    def _venue_name_shape(cls, v: str | None) -> str | None:
        if v is None:
            return None
        name = v.strip()
        if len(name) < 2:
            raise ValueError("El nombre del negocio debe tener al menos 2 caracteres.")
        return name

    @field_validator("public_contact_channels")
    @classmethod
    def _channels_allowed(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        allowed = {"whatsapp", "email"}
        clean = sorted({str(c).strip().lower() for c in v if str(c).strip()})
        bad = [c for c in clean if c not in allowed]
        if bad:
            raise ValueError("Canales de contacto no admitidos: " + ", ".join(bad))
        return clean

    @field_validator("contact_email")
    @classmethod
    def _venue_contact_email_shape(cls, v: str | None) -> str | None:
        if v is None:
            return None
        email = v.strip().lower()
        if not email:
            return ""
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]{2,}", email):
            raise ValueError("contact_email debe ser un correo válido")
        return email

    @model_validator(mode="after")
    def _public_contact_requires_channel(self):
        if self.public_contact_enabled and self.public_contact_channels is not None:
            if not self.public_contact_channels:
                raise ValueError(
                    "Elige al menos un canal para publicar el contacto."
                )
        return self

    @model_validator(mode="after")
    def _contact_phone_shape(self):
        """Telefono en formato humano: digitos y separadores, 7..20.

        No se normaliza a solo digitos aqui: se guarda como la persona lo
        escribe ("+57 300 123 4567") para mostrarlo legible. La forma que
        exige wa.me la arma el frontend (lib/whatsapp.js), que es quien tiene
        esa regla. "" limpia el dato.
        """
        if self.contact_phone is None:
            return self
        p = self.contact_phone.strip()
        if p and not re.fullmatch(r"[0-9+ ()-]{7,20}", p):
            raise ValueError("contact_phone solo admite digitos y + ( ) -")
        self.contact_phone = p
        return self

    @model_validator(mode="after")
    def _primary_color_shape(self):
        """Solo #RRGGBB (o "" para limpiarlo).

        El valor termina dentro de un `style` del frontend, así que la
        validación es una lista blanca, no un "escapado": cualquier otra cosa
        (nombres, `url(...)`, `;`, `)` ) se rechaza aquí y nunca llega al CSS.
        """
        if self.primary_color is None:
            return self
        c = self.primary_color.strip()
        if c and not re.fullmatch(r"#[0-9a-fA-F]{6}", c):
            raise ValueError("primary_color debe ser un hex #RRGGBB")
        self.primary_color = c.lower()
        return self

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
    """Borrado definitivo de la propia cuenta.

    Exige la contraseña vigente Y el email escrito a mano: el borrado de la
    propia cuenta es más destructivo que purgar a un tercero (se lleva la
    venue entera si eres admin único), así que no puede ser más fácil de
    disparar. Mismo patrón de confirmación que PurgeUserRequest.
    """
    password: str
    confirm: str


class DeletionBlocker(BaseModel):
    """Organización que impide borrar la cuenta hasta transferirla."""
    venue_id: int
    venue_name: str
    reason: str
    detail: str


class DeletionCheckOut(BaseModel):
    """Estado confirmado por el servidor antes de mostrar el borrado."""
    can_delete: bool
    blockers: list[DeletionBlocker] = []


class CloseOtherSessionsRequest(BaseModel):
    """Cierre de las demás sesiones abiertas: exige la contraseña vigente.

    Quien solo robara un token no puede expulsar al dueño de su propia
    cuenta; el dueño sí (y de paso invalida el token robado).
    """
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


class PushStatusOut(BaseModel):
    """Estado real del push para ESTE dispositivo.

    La preferencia local no acredita recepción: `registered` solo es true si
    el endpoint exacto está guardado para la cuenta y la venue.
    """
    server_enabled: bool
    supported: bool
    permission: str
    subscribed: bool
    registered: bool
    endpoint: str | None = None
    registered_at: datetime | None = None
    device: str | None = None


class PushTestRequest(BaseModel):
    venue_id: int
    endpoint: str = Field(min_length=20, max_length=1000, pattern=r"^https://")


class PushTestOut(BaseModel):
    sent: bool
    status_code: int | None = None
    detail: str


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
    # Último cambio de fecha, lugar o cancelación posterior a la compra.
    change_notice: EventChangeNoticeOut | None = None


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
    # Fecha de nacimiento (mig 051): se valida la edad mínima del evento antes
    # de generar el link de cobro.
    customer_birth_date: date | None = None


# --- App del fan: "mis boletas" (magic link) --------------------------------
#
# El fan no tiene cuenta: su correo o telefono ES la identidad. Con el mismo
# contacto con que le emitieron las boletas, pide el enlace y ve su lista.
# Igual que el token del QR, la respuesta no devuelve PII de contacto.


class FanLookupRequest(BaseModel):
    """Contacto con el que se emitieron las boletas (correo o telefono).

    Ya NO es una credencial: solo pide que se envie el enlace de acceso al
    contacto. La credencial es el token firmado que llega a ese contacto.
    """

    contact: str = Field(min_length=5, max_length=200)


class FanCredentialRequest(BaseModel):
    """Credencial del fan para ver sus boletas o regenerar un QR.

    Dos formas validas, y ninguna es "conozco el correo" (eso era el agujero):
      - `token`: el enlace firmado que se entrega al contacto (viaja en el
        correo), o
      - `raw_token`: el token crudo de OTRA boleta del mismo dueno. La
        posesion es la credencial, igual que en /t: quien ya tiene una entrada
        vigente puede recuperar el QR de otra sin pasar por el correo.
    """

    token: str | None = Field(default=None, max_length=2000)
    raw_token: str | None = Field(default=None, max_length=200)


class FanTicketOut(BaseModel):
    """Una boleta vista por su dueno en la lista, sin exponer el token."""

    ticket_id: int
    event_name: str
    venue_name: str
    location: str | None = None
    starts_at: str
    status: str
    # El token crudo NO viaja en el listado: solo lo entrega `my-ticket-token`
    # para la boleta que el fan reclama. `has_link` indica si aun se puede
    # pedir (boleta viva y evento no cerrado).
    has_link: bool = False
    # Ventana de activacion del QR (mig 013, patron DICE): el QR solo se dibuja
    # desde starts_at - qr_unlock_minutes. Misma regla que la boleta (/t), para
    # que el fan no vea un QR que la puerta aun no honra.
    qr_active: bool = True
    qr_message: str | None = None
    # Cambio de fecha, lugar o cancelación posterior a la compra.
    change_notice: EventChangeNoticeOut | None = None


class FanTicketsOut(BaseModel):
    """Resultado del enlace: si no hay boletas, la UI dice que no encontro nada."""

    contact: str
    count: int
    tickets: list[FanTicketOut] = []


class FanTicketTokenOut(BaseModel):
    """Enlace regenerado de UNA boleta del fan (el token crudo, una sola vez).

    El token anterior queda invalido: la DB guarda solo su hash y se rota con
    `reissue_ticket`, que audita el cambio en `ticket_reissues`.
    """

    ticket_id: int
    raw_token: str



class PaymentCreateOut(BaseModel):
    """Cobro creado: la URL de Wompi se manda al cliente por WhatsApp.

    `reference` es la llave interna del ciclo (webhook -> cobro -> boleta).
    """

    payment_id: int
    reference: str
    payment_url: str
    amount_in_cents: int
    status: str = "pending"


# --- Checkout publico del fan (sin cuenta) ---------------------------------
#
# El fan compra solo: elige localidad, deja su contacto y paga en Wompi. El
# monto NUNCA viene del cliente (se lee de ticket_types); el contacto ES la
# identidad con la que despues reclama su QR en /boletas. La `reference` es la
# capability con la que consulta el estado: por eso tiene 128 bits.


class PublicCheckoutRequest(BaseModel):
    """Compra del fan: localidad + contacto. El nombre es para la puerta.

    El teléfono es obligatorio (el modelo de pago lo exige y es el canal de
    entrega); el correo es opcional.
    """

    ticket_type_id: int
    customer_name: str = Field(min_length=1, max_length=200)
    customer_phone: str = Field(min_length=5, max_length=30)
    customer_email: str | None = Field(default=None, max_length=200)
    # Fecha de nacimiento del comprador (mig 051). Se usa para validar la edad
    # mínima del evento ANTES de cobrar. Opcional para no romper compras de
    # eventos sin restricción; si el evento la exige y falta, el server la
    # rechaza (no aquí: el schema no conoce el evento).
    customer_birth_date: date | None = None
    # Código de descuento (mig 043), opcional. El servidor lo valida contra el
    # evento; un código inválido NO tumba la compra: se ignora (mejor vender
    # sin descuento que perder la venta por un typo).
    coupon_code: str | None = Field(default=None, max_length=40)
    # Pase de la sala de espera (mig 055/056). Solo lo exige el servidor si el
    # evento tiene la sala activa; si está apagada se ignora por completo, así
    # que su ausencia no cambia el checkout de ningún evento existente.
    waiting_pass: str | None = Field(default=None, max_length=200)
    # Link público del promotor (mig 063). Se valida contra el evento y la
    # asignación; si no sirve, la compra sigue como pública sin atribución.
    promoter_ref: str | None = Field(default=None, max_length=80)


class WaitingRoomJoinRequest(BaseModel):
    """Entrar a la fila: el navegador trae su token de sesión (o uno nuevo)."""

    session_token: str = Field(min_length=16, max_length=200)


class WaitingRoomJoinOut(BaseModel):
    """Estado en la sala. `pass_token` solo viene cuando ya puede comprar."""

    status: str
    pass_token: str | None = None
    queue_position: int = 0
    expires_at: datetime | None = None
    session_token: str


class WaitingRoomStatusOut(BaseModel):
    status: str
    queue_position: int | None = None
    expires_at: datetime | None = None


class PublicCheckoutOut(BaseModel):
    """Cobro creado para el fan: a donde ir a pagar + como consultar luego."""

    reference: str
    payment_url: str
    amount_in_cents: int
    event_id: int
    event_name: str
    status: str = "pending"


class PublicCheckoutStatusOut(BaseModel):
    """Estado de un checkout del fan (para el polling tras volver de Wompi).

    Deliberadamente NO expone el token del QR: si el pago quedo aprobado, la
    boleta se reclama por contacto en /boletas (el mismo camino de siempre,
    que ya rota tokens y audita). Aqui solo se dice si el dinero entro.
    """

    reference: str
    status: str  # pending | approved | declined | voided | expired
    event_id: int
    event_name: str
    ticket_id: int | None = None
    approved: bool = False


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
    # Un pago aprobado puede quedar sin boleta (aforo lleno, evento cerrado).
    # Administración necesita ver el motivo exacto para resolverlo.
    fulfillment_error: str | None = None


class PaymentsListOut(BaseModel):
    total: int
    items: list[PaymentOut]


class PaymentFulfillOut(BaseModel):
    """Resultado de resolver un cobro aprobado sin boleta."""

    payment_id: int
    ticket_id: int
    raw_token: str | None = None
    duplicate: bool = False
    status: str = "issued"


class TicketTimelineEntry(BaseModel):
    """Un hecho operativo de una boleta, en orden cronológico.

    El historial no es una copia de tablas: es la historia que el equipo
    necesita contar en puerta ("este QR se reemitió", "este pago llegó sin
    boleta", "esta persona ya entró a las 22:14"). Los hashes de token nunca
    salen: se describen como "QR anterior" y "QR nuevo".
    """

    id: str
    kind: str
    at: datetime
    title: str
    detail: str | None = None
    actor_name: str | None = None
    actor_role: str | None = None
    amount_cents: int | None = None
    status: str | None = None
    channel: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class TicketOperationalHistoryOut(BaseModel):
    """Expediente de una boleta para Administración y su promotor.

    El admin ve dinero y datos completos. El promotor ve solo sus boletas y
    conserva el contacto del asistente (es su venta), pero no puede anular,
    reembolsar ni resolver cobros ajenos.
    """

    ticket_id: int
    event_id: int
    ticket_type: str
    status: str
    issued_at: datetime
    redeemed_at: datetime | None = None
    redeemed_by_name: str | None = None
    customer_name: str
    customer_phone: str | None = None
    customer_email: str | None = None
    price_cents: int = 0
    payment_method: str | None = None
    sale_channel: str = "venue"
    payment: PaymentOut | None = None
    timeline: list[TicketTimelineEntry] = Field(default_factory=list)
    viewer_role: str
    can_reissue: bool = False
    can_refund: bool = False
    can_void: bool = False
    can_retry_fulfillment: bool = False


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
    code: str = ""  # GRANTED | ALREADY_REDEEMED | NOT_FOUND | INVALID_EVENT | EVENT_NOT_LIVE | NOT_VALID | WRONG_TYPE | UNDER_AGE
    ticket_id: int | None = None
    customer_name: str | None = None
    redeemed: bool = False
    # Detalle opcional para la puerta (p.ej. WRONG_TYPE: "Boleta de General").
    detail: str | None = None
    # Tipo de boleta cuando el servidor lo conoce: la puerta lo muestra junto
    # al resultado (General, VIP u otro) sin exponer el token.
    ticket_type: str | None = None


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
    # Puerta de origen (mig 042), igual que en el canje en línea.
    door_id: str | None = Field(default=None, max_length=40)
    # Idempotencia (mig 034): el teléfono genera un uuid por escaneo. Si el
    # sync se reintenta tras un corte de red, la DB reconoce el scan_id y
    # devuelve el resultado ya guardado sin volver a canjear.
    scan_id: str | None = None


class DoorSyncResult(BaseModel):
    """Resultado de UN token de la cola, en el mismo orden en que llegó.

    El cliente lo necesita para borrar de IndexedDB solo los items que el
    server realmente procesó: con un solo contador agregado, un POST cortado a
    mitad obligaba a reenviar todo y los ya canjeados volvían como
    already_redeemed (entradas perdidas en el conteo).
    """

    scan_id: str | None = None
    code: str  # GRANTED / ALREADY_REDEEMED / NOT_FOUND / ...


class DoorSyncOut(BaseModel):
    """Resultado de reconciliar la cola offline de un bouncer.

    La DB re-evalúa CADA token con redeem_ticket: el snapshot puede estar
    viejo (boleta anulada después de descargarlo) y la DB manda.
    """

    processed: int
    granted: int
    already_redeemed: int
    rejected: int  # not_found / not_valid / wrong_type / invalid_event
    results: list[DoorSyncResult] = []


# --------------------------------------------------------------------------
# Ciclo de vida / anulación / usuarios de la venue
# --------------------------------------------------------------------------
class VoidRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


class RefundRequest(BaseModel):
    """Reembolso de una boleta (mig 043). El monto es opcional: por defecto el
    precio que pagó. El motivo es obligatorio (queda en la auditoría)."""
    reason: str = Field(min_length=3, max_length=300)
    amount_in_cents: int | None = Field(default=None, ge=0)


# --------------------------------------------------------------------------
# Cupones (mig 043): descuentos por código, solo venta online
# --------------------------------------------------------------------------
class CouponCreate(BaseModel):
    code: str = Field(min_length=2, max_length=40)

    @field_validator("code")
    @classmethod
    def _code_clean(cls, v: str) -> str:
        # El código viaja en URLs y se dicta por WhatsApp: sin espacios y en
        # mayúsculas para que "temprano20" y "TEMPRANO 20" no diverjan.
        text = v.strip().upper().replace(" ", "")
        if len(text) < 2:
            raise ValueError("El código es demasiado corto")
        return text

    kind: Literal["percent", "fixed"]
    value: int = Field(gt=0)
    max_uses: int | None = Field(default=None, ge=1)
    expires_at: datetime | None = None
    is_active: bool = True
    # NULL = aplica a todas las localidades. Una lista limita el cupón a esas.
    ticket_type_ids: list[int] | None = None

    @model_validator(mode="after")
    def _value_matches_kind(self) -> "CouponCreate":
        if self.kind == "percent" and not (1 <= self.value <= 99):
            raise ValueError("Un cupón de porcentaje debe estar entre 1 y 99")
        return self


class CouponUpdate(BaseModel):
    kind: Literal["percent", "fixed"] | None = None
    value: int | None = Field(default=None, gt=0)
    max_uses: int | None = Field(default=None, ge=1)
    expires_at: datetime | None = None
    is_active: bool | None = None
    ticket_type_ids: list[int] | None = None


class CouponOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_id: int
    code: str
    kind: str
    value: int
    max_uses: int | None = None
    used_count: int = 0
    expires_at: datetime | None = None
    is_active: bool = True
    ticket_type_ids: list[int] | None = None


class CouponQuoteOut(BaseModel):
    """Cotización de un cupón para el fan: cuánto pagaría. No lo consume."""
    code: str
    discount_in_cents: int
    original_in_cents: int
    final_in_cents: int
    valid: bool = False


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
    # Contacto personal visible para el equipo solo si la persona lo autorizó
    # (mig 059). None no significa "no tiene": significa "no lo comparte".
    contact_phone: str | None = None
    contact_email: str | None = None
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
    redeemed_at: datetime | None = None
    redeemed_by_name: str | None = None
    price_cents_snapshot: int
    type_name: str | None = None
    sold_by_name: str | None = None
    from_allocation: bool = False
    # Medio de pago (mig 042). NULL en boletas históricas de venta directa:
    # no se inventa el dato. La UI lo muestra como "sin especificar".
    payment_method: str | None = None
    sale_channel: str = "venue"


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


class ReportBySeller(BaseModel):
    """Arqueo por cajero: quién vendió y con qué medio de pago.

    La taquilla presencial necesita cuadrar el cajón por persona, no solo el
    total del evento. `seller_id` puede ser NULL en boletas históricas sin
    emisor identificado.
    """

    seller_id: int | None = None
    full_name: str
    payment_method: str | None = None
    tickets: int = 0
    revenue_cents: int = 0


class ReportByPaymentMethod(BaseModel):
    """Fila del desglose de caja por medio de pago (mig 042).

    Convierte el "Recaudo" en un arqueo: el efectivo es lo único contable
    contra el cajón; transferencia y online se concilian aparte. Las boletas
    históricas de venta directa sin dato salen con `payment_method=None`
    ("sin especificar"): no se inventa el medio.
    """
    payment_method: str | None = None
    tickets: int = 0
    revenue_cents: int = 0


class ReportByDoor(BaseModel):
    """Fila del desglose de puerta (mig 042): qué hizo cada acceso.

    `door_id=None` agrupa los escaneos sin puerta identificada. `granted` son
    los ingresos; `rejected` todo lo demás que la puerta negó. Sirve para
    balancear el personal y detectar una puerta que rechaza de más.
    """
    door_id: str | None = None
    granted: int = 0
    rejected: int = 0
    total: int = 0


class EventDoorPulse(BaseModel):
    """Una franja del ritmo de puerta: cuantos ingresos cayeron en 10 min.

    `bucket` = minutos desde el inicio de la noche (0, 10, 20, …); `count` =
    ingresos (granted) en esa franja; `label` = hora LOCAL del evento ("21:40"),
    ya formateada en el servidor para no repetir el manejo de husos en el front.
    """

    bucket: int
    count: int = 0
    label: str = ""


class EventReport(BaseModel):
    event_id: int
    event_name: str
    capacity: int
    issued: int
    redeemed: int
    pending: int
    voided: int
    refunded: int = 0
    occupancy_pct: float
    # Recaudo vivo: suma de price_cents_snapshot de las boletas activas.
    # (Anular/reembolsar lo baja; emitir lo sube. NO es "lo vendido histórico".)
    revenue_cents: int = 0
    # Dinero devuelto en el evento. Se muestra aparte del recaudo vigente:
    # "cobré X y devolví Y" no es lo mismo que "me quedan X".
    refunded_cents: int = 0
    by_type: list[ReportByType]
    by_promoter: list[ReportByPromoter]
    # Salud de puerta (redemptions, sin dinero). Solo vista admin: un pico de
    # duplicados es el sintoma de un QR reenviado/clonado y el admin tiene que
    # verlo mientras el evento pasa, no al dia siguiente en el CSV. El promotor
    # no lo ve (no es su trabajo y es dato operativo del negocio).
    door_duplicates: int = 0
    door_rejected: int = 0
    # Desglose de caja por medio de pago (mig 042). Solo vista admin: es
    # dinero. Convierte el recaudo en un arqueo (cuánto efectivo debería
    # haber). El promotor no lo ve.
    by_payment_method: list[ReportByPaymentMethod] = []
    # Arqueo por cajero (taquilla presencial). Solo vista admin: permite
    # cerrar el turno de cada persona contra su cajón.
    by_seller: list[ReportBySeller] = []
    # Desglose de puerta por acceso (mig 042). Solo vista admin: es dato
    # operativo del negocio (cuánto trabajó cada puerta), no del promotor.
    by_door: list[ReportByDoor] = []
    # Ritmo de la puerta: ingresos por franja de 10 min, con la hora LOCAL del
    # evento. `count` por entrada; `bucket` = minutos desde el inicio de la
    # noche. Es la señal que faltaba para OPERAR: el total dice cómo va, pero
    # no si la puerta esta fluyendo o atascada. Solo vista admin.
    door_pulse: list[EventDoorPulse] = []


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


class ReportPayments(BaseModel):
    """Cobros online del evento, separados por lo que el dinero ya es.

    `approved` es dinero cobrado y conciliado con boleta. `unfulfilled` es
    dinero cobrado SIN boleta: no se puede cerrar la noche sin resolverlo.
    `pending` es un cobro que aún no es dinero. Sumarlos todos sería un
    informe mentiroso; por eso van en cubos distintos.
    """

    approved_count: int = 0
    approved_cents: int = 0
    pending_count: int = 0
    pending_cents: int = 0
    unfulfilled_count: int = 0
    unfulfilled_cents: int = 0
    declined_count: int = 0


class ReportRefunds(BaseModel):
    """Devoluciones registradas en el evento (dinero que salió)."""

    count: int = 0
    amount_cents: int = 0


class ReportSummary(BaseModel):
    """KPIs de caja del evento. `revenue_cents` cuenta boletas vivas
    (issued + redeemed); anuladas y reembolsadas no facturan.

    `since`/`until` reflejan la ventana pedida (null = todo el evento): la
    caja de un periodo, no solo "ahora".
    """

    event_id: int
    event_name: str
    capacity: int
    since: datetime | None = None
    until: datetime | None = None
    issued: int
    redeemed: int
    pending: int
    voided: int
    refunded: int = 0
    occupancy_pct: float
    revenue_cents: int
    avg_ticket_cents: int
    paid_tickets: int
    courtesy_tickets: int
    door: DoorScanStats
    payments: ReportPayments = Field(default_factory=ReportPayments)
    refunds: ReportRefunds = Field(default_factory=ReportRefunds)
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
    # Caja del mes: `revenue_cents` es lo VENDIDO (boletas vivas de eventos
    # del mes); `collected_cents` es lo efectivamente COBRADO por Wompi en el
    # mes; `settled_cents` es lo pagado a promotores en el mes. Son tres
    # momentos distintos del dinero y la UI no debe sumarlos como si fueran
    # el mismo saldo.
    collected_cents: int = 0
    pending_collection_cents: int = 0
    settled_cents: int = 0
    courtesy_tickets: int
    avg_ticket_cents: int
    # Tendencia: mismo agregado del mes anterior (la UI calcula el delta)
    prev_revenue_cents: int
    prev_tickets_issued: int
    prev_events_count: int
    # Rankings del mes
    top_promoters: list[dict]   # [{name, tickets, revenue_cents, has_courtesy}]
    top_events: list[dict]      # [{id, name, starts_at, status, tickets, revenue_cents}]
    # Comisiones del mes: liquidaciones de promotores generadas en el mes.
    # NULL (no 0) cuando no hay ninguna: en el MVP la venta de pago es
    # directa (allocation_id NULL) y el promotor solo mueve cortesías, así
    # que "no hay comisión calculable" NO es lo mismo que "la comisión es
    # cero". La UI usa ese null para decidir si mostrar el neto.
    commissions_cents: int | None = None
    # Curva de venta del mes: SIEMPRE los 5 tramos de anticipación (de "30+"
    # a "0-1"), rellenados con 0 donde no hubo venta. El tramo vacío es el
    # dato, no una fila ausente. Mide CUÁNDO se vendió, no cuánto.
    sales_curve: list[dict] = []   # [{bucket, tickets, revenue_cents}]
    # Retención: compradores del mes identificados por teléfono y cuántos ya
    # le compraron a este venue antes. `buyers` excluye a quien no dejó
    # teléfono (no se puede saber si repite; contarlo como nuevo mentiría).
    retention_buyers: int = 0
    retention_returning: int = 0


class VenueDoorEvent(BaseModel):
    """Una noche del venue, con su estado de puerta. Alimenta la vista de
    puerta agregada: el admin que no tiene un evento abierto igual necesita
    saber cuál está en vivo y cuánta gente entró."""

    event_id: int
    name: str
    starts_at: datetime
    status: str
    capacity: int
    issued: int = 0
    redeemed: int = 0


class VenueDoorScan(BaseModel):
    """Un intento de escaneo reciente en la puerta de las noches en vivo.

    Alimenta la cola de "últimos escaneos": el portero necesita ver pasar las
    boletas, no solo el total. `outcome` distingue si pasó o rebotó, y el
    nombre del invitado es el mismo que ya expone /redemptions.
    """

    scanned_at: datetime
    outcome: str
    customer_name: str | None = None
    type_name: str | None = None
    scanned_by: str | None = None


class VenueDoorSlot(BaseModel):
    """Una franja de 30 min del ritmo de entrada. `n` puede ser 0: el silencio
    entre tandas es información, no un hueco que la UI deba saltarse."""

    at: datetime
    n: int = 0


class VenueDoor(BaseModel):
    """La puerta del venue ENTERO, sin abrir un evento.

    Responde la pregunta que hoy no tenía dónde: "¿qué está pasando en mi
    puerta ahora mismo?". El desglose por evento existe (`EventPulse`,
    `EventReport`), pero obliga a entrar a una noche. `live` marca las
    noches en curso para que la UI las destaque.

    Sin dinero: es dato operativo, no caja.
    """

    # Noches en estado 'live' (lo que está pasando AHORA).
    live_events: int = 0
    # Suma de las noches EN VIVO: el aforo de esta noche, no del mes.
    live_capacity: int = 0
    live_issued: int = 0
    live_redeemed: int = 0
    # Integridad de puerta de las noches en vivo.
    duplicates: int = 0
    rejected: int = 0
    # Último escaneo de cualquier noche en vivo (null si no hubo ninguno).
    last_scan_at: datetime | None = None
    # Ritmo de entrada por franja de 30 min (solo granted). Series reales para
    # dibujar el pulso de la noche, no un adorno inventado en el front.
    rhythm: list[VenueDoorSlot] = []
    # Los últimos escaneos, más reciente primero (máx. 12).
    recent_scans: list[VenueDoorScan] = []
    # Todas las noches con puerta abierta o por abrir, más reciente primero.
    events: list[VenueDoorEvent] = []


class VenuePromoter(BaseModel):
    """Un promotor del mes con su cupo y su comisión.

    `capacity` es la suma de cupos asignados a sus boletas del mes; `issued`
    lo efectivamente colocado. `advance_pct` es el avance del cupo — la señal
    que faltaba: `top_promoters` del overview da el ranking en boletas pero
    no contra cuánto cupo, así que no se veía quién va cumpliendo.

    `commission_cents` sale de las liquidaciones (`promoter_payouts`) y es 0
    cuando no hay ninguna generada, no null: el total de comisiones del
    venue ya se expone como null en `VenueOverview` cuando no hay datos.
    """

    promoter_id: int
    name: str
    capacity: int = 0
    issued: int = 0
    redeemed: int = 0
    revenue_cents: int = 0
    commission_cents: int = 0
    advance_pct: float = 0.0
    has_courtesy: bool = False


class VenuePromoters(BaseModel):
    """El equipo de promotores del mes con cupo, avance y comisión."""

    month: str
    promoters: list[VenuePromoter] = []
    # Agregados del mes para la cabecera de la sección. `capacity_total` es
    # suma de CUPOS (boletas), no dinero: el sufijo _cents reservado para
    # importes. `commission_cents` sí es dinero.
    capacity_total: int = 0
    commission_cents: int = 0


class MessageOut(BaseModel):
    detail: str


# --------------------------------------------------------------------------
# Documentos legales y aceptaciones versionadas (mig 026)
# --------------------------------------------------------------------------
class LegalDocumentOut(BaseModel):
    """Un documento legal con su version vigente."""
    slug: str
    version: str
    title: str
    url: str
    requires_acceptance: bool
    effective_date: date


class LegalDocumentsOut(BaseModel):
    """Catalogo vigente + la huella agregada de versiones.

    `terms_version` es la huella de TODAS las versiones vigentes de los
    documentos que exigen aceptacion. El registro la devuelve tal cual: si
    mientras alguien llenaba el formulario se publico una version nueva, el
    registro falla con 409 en vez de guardar la aceptacion de un texto que la
    persona nunca vio.
    """
    terms_version: str
    documents: list[LegalDocumentOut]


class LegalAcceptanceCreate(BaseModel):
    """Aceptacion de un documento concreto.

    El sujeto lo aporta el contexto, no el cuerpo: una cuenta autenticada
    (header Authorization) o un invitado sin cuenta (telefono + token de su
    boleta, que resuelve a que venue pertenece la aceptacion).
    """
    slug: str = Field(min_length=3, max_length=60, pattern=r"^[a-z0-9-]+$")
    version: str = Field(max_length=20, pattern=r"^[0-9]+\.[0-9]+$")
    subject_email: str | None = Field(default=None, max_length=200)
    subject_phone: str | None = Field(default=None, max_length=40)
    # El token crudo de la boleta: viaja en el CUERPO (nunca en la URL), igual
    # que en /tickets/preview. Solo sirve para ubicar la boleta y su venue.
    ticket_token: str | None = Field(default=None, min_length=16, max_length=200)

    @field_validator("subject_email")
    @classmethod
    def _email_ok(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        v = v.strip()
        if not _EMAIL_RE.match(v):
            raise ValueError("Email invalido")
        return v

    @field_validator("subject_phone")
    @classmethod
    def _phone_ok(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        return v.strip()


class LegalAcceptanceOut(BaseModel):
    slug: str
    version: str
    accepted_at: datetime


class LegalStatusOut(BaseModel):
    """Lo que esta persona ya acepto y lo que le falta aceptar hoy."""
    accepted: list[LegalAcceptanceOut]
    pending: list[LegalDocumentOut]


# --------------------------------------------------------------------------
# Liquidaciones de promotores (mig 010)
# --------------------------------------------------------------------------
class PayoutGenerateRequest(BaseModel):
    """Cierre de liquidacion de un promotor por rango de fechas."""
    promoter_id: int
    period_start: date
    period_end: date


class PayoutPreviewOut(BaseModel):
    """Lo que se pagaria si se cerrara el periodo: mismo calculo, sin escribir.

    El cierre es INMUTABLE (una liquidacion pagada/rechazada es historia), asi
    que el admin debe ver el monto y el solape ANTES de comprometerlo. El
    preview corre el mismo agregado que `generate_payout`.
    """
    promoter_id: int
    promoter_name: str = ""
    period_start: date
    period_end: date
    tickets_count: int
    revenue_cents: int
    commission_pct: float
    commission_cents: int
    # Motivo por el que NO se podria cerrar ahora (rango en el pasado, solape,
    # venue sin comision). None = se puede cerrar.
    blocked_reason: str | None = None


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
    venue_id: int
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
    phone: str | None = None
    # Rol DENTRO de la noche: "bouncer" (puerta) o "promotor" (venta).
    role: Literal["bouncer", "promotor"]
    shift_start: datetime | None = None
    shift_end: datetime | None = None
    created_at: datetime
    # Puesto de puerta asignado (mig 064): "Acceso VIP", "General"…
    door_name: str | None = None
    door_ticket_type_id: int | None = None
    # Dispositivo activo del puesto. La UI de Administración lo usa para
    # mostrar el teléfono autorizado y revocarlo.
    device_id: int | None = None
    device_status: str | None = None
    device_phone: str | None = None
    device_expires_at: datetime | None = None
    device_last_seen_at: datetime | None = None
    # Si tiene un link de puerta vigente (para saber si hay que emitirlo).
    has_link: bool = False
    # Estado del último enlace, aunque ya no sea vigente: la puerta necesita
    # distinguir "nunca se emitió", "venció", "se revocó" y "ya se canjeó".
    link_expires_at: datetime | None = None
    link_used_at: datetime | None = None
    link_revoked_at: datetime | None = None


class EventStaffCreate(BaseModel):
    """Asigna (o reasigna) a alguien a una noche."""
    user_id: int
    role: Literal["bouncer", "promotor"] = "bouncer"
    # Turno opcional: sin esto el link vale para la noche entera.
    shift_start: datetime | None = None
    shift_end: datetime | None = None
    # Puesto de puerta (mig 064). Se copia al link y al dispositivo.
    door_name: str | None = Field(default=None, max_length=60)
    door_ticket_type_id: int | None = None


class AccreditationCreate(BaseModel):
    """Alta de una acreditación operativa (prensa, artista, producción…)."""

    holder_name: str = Field(min_length=1, max_length=160)
    holder_email: str | None = Field(default=None, max_length=200)
    holder_phone: str | None = Field(default=None, max_length=40)
    category: Literal[
        "prensa", "artista", "produccion", "patrocinador", "invitado"
    ] = "invitado"
    zone: str | None = Field(default=None, max_length=80)
    valid_from: datetime | None = None
    valid_until: datetime | None = None
    entries_allowed: int = Field(default=1, ge=1, le=50)

    @field_validator("holder_email")
    @classmethod
    def _email_shape(cls, v):
        if v is None or not v.strip():
            return None
        value = v.strip()
        if not _EMAIL_RE.match(value):
            raise ValueError("Correo inválido")
        return value

    @field_validator("holder_name", "zone")
    @classmethod
    def _clean_text(cls, v):
        if v is None:
            return None
        return v.strip() or None


class AccreditationOut(BaseModel):
    """Acreditación visible en Administración. Nunca incluye el token."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: int
    holder_name: str
    holder_email: str | None = None
    holder_phone: str | None = None
    category: str
    zone: str | None = None
    valid_from: datetime
    valid_until: datetime | None = None
    entries_allowed: int
    entries_used: int
    status: str
    created_at: datetime
    revoked_at: datetime | None = None


class AccreditationCreated(AccreditationOut):
    """La respuesta del alta: el token en claro viaja SOLO una vez."""

    raw_token: str


class EventAccessCreate(BaseModel):
    """Puesto y teléfono con los que se emite un link de puerta."""
    door_name: str | None = Field(default=None, max_length=60)
    ticket_type_id: int | None = None
    phone: str | None = Field(default=None, max_length=40)


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
    door_name: str | None = None
    ticket_type_id: int | None = None
    phone: str | None = None


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
    door_name: str | None = None
    ticket_type_id: int | None = None
    phone: str | None = None


class EventAccessGranted(BaseModel):
    """Respuesta del canje: a qué noche y puesto quedó atado el dispositivo.

    `device_token` es el secreto de ESTE teléfono. No se vuelve a mostrar:
    se guarda en el navegador y viaja en cada escaneo. Revocar el dispositivo
    o relevar el puesto lo invalida en el servidor.
    """
    event_id: int
    device_id: int | None = None
    device_token: str | None = None
    door_name: str | None = None
    ticket_type_id: int | None = None
    phone: str | None = None
    expires_at: datetime | None = None


class DoorDeviceOut(BaseModel):
    """Autorización del teléfono de un puesto (mig 064)."""
    id: int
    event_id: int
    user_id: int
    door_name: str | None = None
    ticket_type_id: int | None = None
    phone: str | None = None
    status: str
    activated_at: datetime | None = None
    expires_at: datetime | None = None
    last_seen_at: datetime | None = None


class DoorContextOut(BaseModel):
    """Todo lo que Puerta necesita para decidir antes de escanear."""
    event_id: int
    event_name: str
    event_status: str
    starts_at: datetime
    capacity: int
    allow_reentry: bool = False
    door_open: bool = False
    inside: int = 0
    admitted: int = 0
    exits: int = 0
    reentries: int = 0
    issued: int = 0
    rejected: int = 0
    last_verified_at: datetime | None = None
    assigned_door: str | None = None
    assigned_ticket_type_id: int | None = None
    shift_start: datetime | None = None
    shift_end: datetime | None = None
    open_incidents: int = 0
    zones: list[ZoneOccupancyOut] = Field(default_factory=list)
    assigned_zone: ZoneOccupancyOut | None = None
    device: DoorDeviceOut | None = None
    ops_contact_name: str | None = None
    ops_contact_phone: str | None = None


class NightHealthDeviceOut(BaseModel):
    id: int
    door_name: str | None = None
    user_name: str | None = None
    ticket_type_name: str | None = None
    status: str
    last_seen_at: datetime | None = None
    stale: bool = False


class NightHealthOut(BaseModel):
    """Estado operativo de la noche para Administración."""

    event_id: int
    generated_at: datetime
    active_devices: int = 0
    stale_devices: int = 0
    last_seen_at: datetime | None = None
    pending_payments_count: int = 0
    pending_payments_cents: int = 0
    unfulfilled_payments_count: int = 0
    unfulfilled_payments_cents: int = 0
    open_incidents: int = 0
    devices: list[NightHealthDeviceOut] = []


class DoorShiftRequestCreate(BaseModel):
    reason: str = Field(min_length=3, max_length=300)
    requested_phone: str | None = Field(default=None, max_length=40)


class DoorShiftRequestOut(BaseModel):
    id: int
    event_id: int
    device_id: int | None = None
    requested_by: int
    requested_by_name: str
    requested_phone: str | None = None
    reason: str
    status: str
    reviewed_by_name: str | None = None
    reviewed_at: datetime | None = None
    review_note: str | None = None
    created_at: datetime
    door_name: str | None = None
    access_url: str | None = None


class DoorShiftApprove(BaseModel):
    user_id: int
    phone: str | None = Field(default=None, max_length=40)
    note: str | None = Field(default=None, max_length=300)


class DoorIncidentCreate(BaseModel):
    reason: str = Field(min_length=3, max_length=120)
    note: str | None = Field(default=None, max_length=1000)
    door_name: str | None = Field(default=None, max_length=60)
    ticket_id: int | None = None
    ticket_ref: str | None = Field(default=None, max_length=80)
    client_request_id: str | None = Field(default=None, max_length=80)


class DoorIncidentCommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=2000)
    channel: Literal["note", "call", "whatsapp"] = "note"


class DoorIncidentStatusUpdate(BaseModel):
    status: Literal["open", "reviewing", "resolved"]
    guidance: str | None = Field(default=None, max_length=1000)
    note: str | None = Field(default=None, max_length=1000)


class DoorIncidentPromoterRequest(BaseModel):
    promoter_id: int | None = None
    note: str | None = Field(default=None, max_length=500)


class DoorIncidentCommentOut(BaseModel):
    id: int
    author_id: int
    author_name: str
    author_role: str
    body: str
    channel: str
    created_at: datetime


class DoorIncidentOut(BaseModel):
    id: int
    event_id: int
    status: str
    reason: str
    note: str | None = None
    door_name: str | None = None
    ticket_id: int | None = None
    ticket_ref: str | None = None
    ticket_type_name: str | None = None
    created_by: int
    created_by_name: str
    created_at: datetime
    updated_at: datetime
    status_changed_by_name: str | None = None
    status_changed_at: datetime | None = None
    resolved_at: datetime | None = None
    resolution_guidance: str | None = None
    promoter_id: int | None = None
    promoter_name: str | None = None
    promoter_access: bool = False
    assigned_admin_name: str | None = None
    can_comment: bool = False
    can_manage: bool = False


class DoorIncidentDetailOut(DoorIncidentOut):
    comments: list[DoorIncidentCommentOut] = []


class EventPulse(BaseModel):
    """Pulso del evento SIN dinero (para la puerta y el nudge del promotor).

    Mismo criterio que el reporte: boletas vivas (issued+redeemed) cuentan; lo
    anulado/reembolsado no. El bouncer ve ocupación; promotor+nombre de rol.
    """
    event_id: int
    event_name: str
    status: str
    capacity: int
    issued: int = 0
    redeemed: int = 0


class ScannerStats(BaseModel):
    """Lo que hizo ESTE escáner en esta noche (redemptions.scanned_by_user_id).

    La cabecera de puerta ya muestra el total del evento; esto responde la
    otra pregunta del bouncer: "¿cuánto de esto lo hice yo?". `granted` son
    los ingresos POR SU escáner, no el total. Los rechazos van separados:
    un `already_redeemed` (boleta repetida) es una situación; un `not_found`
    (QR de otra noche) es operativa distinta.
    """
    event_id: int
    granted: int = 0
    already_redeemed: int = 0
    rejected: int = 0


class OccupancyOut(BaseModel):
    """Ocupación REAL del recinto en este momento (mig 052-054).

    El tablero necesita estas cifras SEPARADAS. Un solo "ingresaron 300" no
    sirve para decidir si se puede dejar entrar a alguien: 300 puede ser
    "hay 300 personas adentro" o "entraron 300 en toda la noche y ya salieron
    100". `inside` es la única que manda para el aforo.
    """
    event_id: int
    capacity: int
    issued: int = 0
    unique_admitted: int = 0
    inside: int = 0
    exits: int = 0
    reentries: int = 0
    rejected: int = 0
    allow_reentry: bool = False
    free_seats: int = 0


class ExitIn(BaseModel):
    """Egreso: la persona sale del recinto (habilita reingreso y libera lugar)."""
    raw_token: str = Field(min_length=8)
    door_id: str | None = Field(default=None, max_length=64)


class ExitOut(BaseModel):
    code: str = ""  # EXITED | ALREADY_OUTSIDE | NOT_FOUND | INVALID_EVENT
    ticket_id: int | None = None
    customer_name: str | None = None
    ticket_type: str | None = None
    exited: bool = False


class MyEventOut(BaseModel):
    """Una noche donde este promotor trabaja, con SUS números."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    starts_at: datetime
    status: str
    flyer_url: str | None = None
    capacity: int
    # Cupo agregado del promotor EN este evento (sum de sus allocations).
    my_capacity: int = 0
    my_issued: int = 0
    my_redeemed: int = 0


# --------------------------------------------------------------------------
# Espacio de promotor (mig 063)
# --------------------------------------------------------------------------
class PromoterTypeOut(BaseModel):
    id: int
    name: str
    price_cents: int
    quantity: int
    is_courtesy: bool
    is_active: bool
    global_issued: int = 0
    pending_reserved: int = 0
    available: int = 0
    my_capacity: int = 0
    my_issued: int = 0
    my_remaining: int = 0
    modes: list[str] = []


class PromoterEventOut(BaseModel):
    id: int
    venue_id: int
    venue_name: str
    name: str
    category: str | None = None
    flyer_url: str | None = None
    starts_at: datetime
    ends_at: datetime | None = None
    location: str | None = None
    status: str
    capacity: int
    assignment_active: bool = True
    my_capacity: int = 0
    my_issued: int = 0
    my_redeemed: int = 0
    link_sold: int = 0
    direct_sold: int = 0
    available_total: int = 0
    can_sell: bool = False
    sell_reason: str | None = None
    ticket_types: list[PromoterTypeOut] = []


class PromoterEventDetailOut(PromoterEventOut):
    description: str | None = None
    doors_open_at: datetime | None = None
    dress_code: str | None = None
    min_age: int | None = None
    location_url: str | None = None
    contact_name: str | None = None
    contact_phone: str | None = None
    currency: str = "COP"
    public_path: str = ""
    allocations: list[AllocationOut] = []


class PromoterSaleOut(BaseModel):
    ticket_id: int
    event_id: int
    event_name: str
    event_starts_at: datetime
    customer_name: str
    customer_phone: str | None = None
    customer_email: str | None = None
    ticket_type: str
    price_cents: int = 0
    payment_method: str | None = None
    sale_channel: str = "promoter_direct"
    status: str
    payment_state: str = "reported"
    admission_state: str = "pending"
    issued_at: datetime
    redeemed_at: datetime | None = None
    attention: bool = False
    issue_id: int | None = None
    issue_status: str | None = None
    can_reissue: bool = False
    has_phone: bool = False
    has_email: bool = False


class PromoterSalesOut(BaseModel):
    total: int
    items: list[PromoterSaleOut]


class PromoterIssueCreate(BaseModel):
    kind: Literal["contact", "payment", "delivery", "duplicate", "other"] = "other"
    note: str = Field(min_length=5, max_length=500)


class PromoterIssueOut(BaseModel):
    id: int
    ticket_id: int
    kind: str
    note: str
    status: str
    resolution_note: str | None = None
    created_at: datetime
    resolved_at: datetime | None = None


class PromoterSaleDetailOut(PromoterSaleOut):
    venue_name: str
    event_status: str
    payment_reference: str | None = None
    payment_status: str | None = None
    payment_provider: str | None = None
    reissue_blocked_reason: str | None = None
    issues: list[PromoterIssueOut] = []


class PromoterLinkOut(BaseModel):
    public_id: str
    url: str
    is_active: bool = True
    visits: int = 0
    checkouts: int = 0
    purchases: int = 0
    attributed_revenue_cents: int = 0
    attributed_commission_cents: int = 0
    commission_pct: float = 0
    period_label: str = "Histórico del link"


class PromoterCommissionPayoutOut(PayoutOut):
    items_count: int = 0
    can_dispute: bool = False


class PromoterCommissionsOut(BaseModel):
    currency: str = "COP"
    commission_pct: float = 0
    generated_cents: int = 0
    pending_settlement_cents: int = 0
    paid_cents: int = 0
    unsettled_cents: int = 0
    attributed_revenue_cents: int = 0
    eligible_sales_count: int = 0
    generated_includes_paid: bool = True
    definition: str = ""
    payouts: list[PromoterCommissionPayoutOut] = []


class PromoterPayoutItemOut(BaseModel):
    ticket_id: int
    event_id: int
    event_name: str
    ticket_type: str
    customer_name: str
    issued_at: datetime
    price_cents: int
    sale_channel: str
    status_at_close: str


class PromoterPayoutDetailOut(PayoutOut):
    items: list[PromoterPayoutItemOut] = []
    currency: str = "COP"
    base_cents: int = 0
    adjustment_cents: int = 0
    rule: str = ""
    can_dispute: bool = False


class PreflightStaff(BaseModel):
    """Una persona de puerta en el pre-vuelo de apertura."""
    user_id: int
    full_name: str
    shift_start: datetime | None = None
    shift_end: datetime | None = None
    # True = ya canjeó su link: tiene el escáner de esta noche abierto.
    link_used: bool = False
    # Teléfono autorizado y vigente (mig 064).
    device_active: bool = False
    device_phone: str | None = None
    door_name: str | None = None
    device_expires_at: datetime | None = None


class EventPreflight(BaseModel):
    """Checklist previo a abrir puertas.

    `door_ready` responde la pregunta que motiva el endpoint: ¿hay ALGUIEN de
    puerta con su escáner de esta noche ya abierto? Sin roster el aviso es
    claro; con roster pero sin canje, también ("generá y mandá el link").
    """
    event_id: int
    event_name: str
    status: str
    capacity: int
    starts_at: datetime
    bouncers: int = 0
    promoters: int = 0
    door_ready: bool = False
    door_staff: list[PreflightStaff] = []
    tickets_issued: int = 0
    tickets_redeemed: int = 0


# --------------------------------------------------------------------------
# Suite operativa y comercial (mig 071)
# --------------------------------------------------------------------------
class TransportPointIn(BaseModel):
    kind: Literal["recogida", "parqueadero", "regreso", "otro"] = "otro"
    name: str = Field(min_length=1, max_length=120)
    detail: str | None = Field(default=None, max_length=500)
    schedule: str | None = Field(default=None, max_length=160)
    map_url: str | None = Field(default=None, max_length=500)
    sort_order: int = 0


class MapPointIn(BaseModel):
    kind: Literal["baño", "atencion", "encuentro", "accesible", "salida", "otro"] = "otro"
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    accessible: bool = False
    sort_order: int = 0


class CheckoutRecoveryIn(BaseModel):
    ticket_type_id: int | None = None
    customer_name: str | None = Field(default=None, max_length=120)
    customer_phone: str | None = Field(default=None, max_length=40)
    customer_email: str | None = Field(default=None, max_length=160)


class ShiftIn(BaseModel):
    shift_start: datetime | None = None
    shift_end: datetime | None = None
    break_start: datetime | None = None
    break_end: datetime | None = None
    station: str | None = Field(default=None, max_length=80)


class CheckinIn(BaseModel):
    note: str | None = Field(default=None, max_length=300)


class OpsOrderIn(BaseModel):
    message: str = Field(min_length=1, max_length=1000)
    target: str | None = Field(default=None, max_length=120)


class EquipmentIn(BaseModel):
    item_name: str = Field(min_length=1, max_length=120)
    serial: str | None = Field(default=None, max_length=120)
    responsible_user_id: int | None = None
    notes: str | None = Field(default=None, max_length=500)


class EquipmentPatch(BaseModel):
    status: Literal["prestado", "devuelto", "perdido"] | None = None
    responsible_user_id: int | None = None
    notes: str | None = Field(default=None, max_length=500)


class BookingIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    event_id: int | None = None
    starts_at: datetime
    ends_at: datetime
    setup_starts_at: datetime | None = None
    teardown_ends_at: datetime | None = None
    status: Literal["tentativa", "confirmada", "cancelada"] = "tentativa"
    notes: str | None = Field(default=None, max_length=500)


class MilestoneIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    due_date: date
    owner_user_id: int | None = None
    status: Literal["pendiente", "hecho", "bloqueado"] = "pendiente"
    notes: str | None = Field(default=None, max_length=500)


class CourtesyIn(BaseModel):
    ticket_type_id: int | None = None
    quantity: int = Field(gt=0, le=200)
    reason: str | None = Field(default=None, max_length=500)


class CourtesyReviewIn(BaseModel):
    status: Literal["aprobada", "rechazada"]
    notes: str | None = Field(default=None, max_length=500)


class DocumentIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    url: str = Field(min_length=1, max_length=1000)
    version: str = Field(default="1", max_length=40)
    access_role: Literal["admin", "equipo", "todos"] = "equipo"
    owner_user_id: int | None = None
    notes: str | None = Field(default=None, max_length=500)


class TicketChangeIn(BaseModel):
    new_event_id: int
    new_type_id: int
    payment_method: Literal["efectivo", "transferencia", "online", "cortesia"] | None = None
    reason: str | None = Field(default=None, max_length=500)


class ResaleIn(BaseModel):
    ticket_id: int
    price_cents: int = Field(ge=0)
    seller_name: str | None = Field(default=None, max_length=120)
    seller_phone: str | None = Field(default=None, max_length=40)
    notes: str | None = Field(default=None, max_length=500)


class ResaleSellIn(BaseModel):
    buyer_name: str = Field(min_length=1, max_length=120)
    buyer_phone: str | None = Field(default=None, max_length=40)
    buyer_email: str | None = Field(default=None, max_length=160)
    payment_method: Literal["efectivo", "transferencia", "online", "cortesia"] = "efectivo"


class ResaleRequestIn(BaseModel):
    buyer_name: str = Field(min_length=1, max_length=120)
    buyer_phone: str | None = Field(default=None, max_length=40)
    buyer_email: str | None = Field(default=None, max_length=160)


class BundleIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    event_ids: list[int] = Field(min_length=1)
    price_cents: int = Field(ge=0)
    quantity: int = Field(gt=0)


# --------------------------------------------------------------------------
# Doce frentes nuevos (mig 072)
# --------------------------------------------------------------------------
class ManualAdmissionIn(BaseModel):
    ticket_id: int
    reason: str = Field(min_length=3, max_length=300)
    verification: str = Field(min_length=3, max_length=300)


class DisputeIn(BaseModel):
    payment_id: int | None = None
    amount_cents: int = Field(ge=0)
    reason: str = Field(min_length=3, max_length=500)
    due_at: datetime | None = None
    notes: str | None = Field(default=None, max_length=1000)


class DisputePatch(BaseModel):
    status: Literal["abierta", "en_revision", "ganada", "perdida", "cerrada"] | None = None
    notes: str | None = Field(default=None, max_length=1000)
    evidence: dict[str, Any] | None = None


class FeeConfigIn(BaseModel):
    service_fee_cents: int = Field(default=0, ge=0)
    payment_fee_pct: float = Field(default=0, ge=0, le=100)
    tax_pct: float = Field(default=0, ge=0, le=100)
    show_breakdown: bool = True
    platform_fee_bps: int = Field(default=0, ge=0, le=10000)
    platform_fee_fixed_cents: int = Field(default=0, ge=0)
    platform_fee_payer: Literal["organizer", "buyer"] = "organizer"


class PayoutProfileIn(BaseModel):
    legal_name: str | None = Field(default=None, max_length=200)
    tax_id: str | None = Field(default=None, max_length=60)
    contact_name: str | None = Field(default=None, max_length=120)
    contact_phone: str | None = Field(default=None, max_length=40)
    contact_email: str | None = Field(default=None, max_length=254)
    bank_name: str | None = Field(default=None, max_length=120)
    bank_account_type: Literal["ahorros", "corriente", "billetera"] | None = None
    bank_account_last4: str | None = Field(default=None, pattern=r"^[0-9]{4}$")
    payout_provider: str | None = Field(default=None, max_length=80)
    payout_account_ref: str | None = Field(default=None, max_length=200)


class PayoutReviewIn(BaseModel):
    status: Literal["approved", "rejected"]
    note: str | None = Field(default=None, max_length=1000)


class AccessRulesIn(BaseModel):
    dress_code: str | None = Field(default=None, max_length=500)
    bags_policy: str | None = Field(default=None, max_length=500)
    prohibited_items: list[str] = Field(default_factory=list)


class PollIn(BaseModel):
    question: str = Field(min_length=3, max_length=300)
    opens_at: datetime | None = None
    closes_at: datetime | None = None
    options: list[str] = Field(min_length=2)


class PollStatusIn(BaseModel):
    status: Literal["borrador", "abierta", "cerrada", "publicada"]


class PollVoteIn(BaseModel):
    ticket_token: str = Field(min_length=8)
    option_id: int


class RecordingIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    url: str = Field(min_length=1, max_length=1000)
    ticket_type_id: int | None = None
    available_from: datetime | None = None
    available_until: datetime | None = None


class LotteryIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    opens_at: datetime
    closes_at: datetime
    draw_at: datetime | None = None
    quantity: int = Field(gt=0, le=10000)
    terms: str | None = Field(default=None, max_length=1000)


class LotteryEntryIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=160)
    phone: str | None = Field(default=None, max_length=40)


class RsvpIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=160)
    phone: str | None = Field(default=None, max_length=40)


class RsvpStatusIn(BaseModel):
    status: Literal["confirmada", "reconfirmar", "cancelada"]


class VenueProfileIn(BaseModel):
    stage_width_m: float | None = Field(default=None, ge=0)
    stage_depth_m: float | None = Field(default=None, ge=0)
    load_in_start: str | None = Field(default=None, max_length=8)
    load_in_end: str | None = Field(default=None, max_length=8)
    sound_system: str | None = Field(default=None, max_length=500)
    lighting: str | None = Field(default=None, max_length=500)
    power: str | None = Field(default=None, max_length=500)
    capacity_notes: str | None = Field(default=None, max_length=1000)
    technical_contact: str | None = Field(default=None, max_length=200)


class LinkCheckIn(BaseModel):
    url: str = Field(min_length=1, max_length=1000)
    kind: str = Field(default="campana", max_length=40)


class ArchiveIn(BaseModel):
    enabled: bool = False
    headline: str | None = Field(default=None, max_length=200)
    summary: str | None = Field(default=None, max_length=2000)
    photos: list[str] = Field(default_factory=list)
    video_url: str | None = Field(default=None, max_length=1000)
    next_event_id: int | None = None


# --------------------------------------------------------------------------
# Migración guiada y operación en lote (mig 073)
# --------------------------------------------------------------------------
class ImportPreviewIn(BaseModel):
    kind: Literal["events", "guests"]
    event_id: int | None = None
    filename: str = Field(min_length=1, max_length=200)
    content_base64: str = Field(min_length=1, max_length=8_000_000)


class ImportRowIn(BaseModel):
    row_number: int = Field(ge=1)
    data: dict[str, Any]


class ImportApplyIn(BaseModel):
    kind: Literal["events", "guests"]
    event_id: int | None = None
    filename: str = Field(min_length=1, max_length=200)
    rows: list[ImportRowIn] = Field(min_length=1, max_length=2000)


class BulkPreviewIn(BaseModel):
    entity: Literal["ticket_types"]
    ids: list[int] = Field(min_length=1, max_length=200)
    action: Literal["pause", "activate"]


class BulkApplyIn(BulkPreviewIn):
    pass


class ReceiptIn(BaseModel):
    raw_token: str = Field(min_length=8, max_length=500)
