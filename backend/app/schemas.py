import re
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator

# Regex de email pragmática: acepta tlds de prueba (.test, .local) y hosts reales.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------
class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")
    password: str


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


class EventCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    # HttpUrl (no str): el flyer se pinta en un <img>, asi que solo aceptamos
    # URLs http(s) reales y no cualquier cadena.
    flyer_url: HttpUrl | None = None
    starts_at: datetime
    ends_at: datetime | None = None
    event_timezone: str = "America/Bogota"
    capacity: int = Field(gt=0)

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
    starts_at: datetime
    ends_at: datetime | None = None
    event_timezone: str
    capacity: int
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


class TicketRedeemRequest(BaseModel):
    raw_token: str = Field(min_length=8)


class RedeemOut(BaseModel):
    code: str = ""  # GRANTED | ALREADY_REDEEMED | NOT_FOUND | INVALID_EVENT | EVENT_NOT_LIVE | NOT_VALID
    ticket_id: int | None = None
    customer_name: str | None = None
    redeemed: bool = False


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
    status: str
    issued_at: datetime
    price_cents_snapshot: int
    type_name: str | None = None
    sold_by_name: str | None = None
    from_allocation: bool = False


# --------------------------------------------------------------------------
# Reporte en vivo
# --------------------------------------------------------------------------
class EventReport(BaseModel):
    event_id: int
    event_name: str
    capacity: int
    issued: int
    redeemed: int
    pending: int
    voided: int
    occupancy_pct: float
    by_type: list[dict]
    by_promoter: list[dict]


class MessageOut(BaseModel):
    detail: str