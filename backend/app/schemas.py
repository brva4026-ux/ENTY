import re
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

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
    description: str | None = None
    flyer_url: str | None = None
    starts_at: datetime
    ends_at: datetime | None = None
    event_timezone: str = "America/Bogota"
    capacity: int = Field(gt=0)


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    venue_id: int
    name: str
    starts_at: datetime
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


class AllocationCreate(BaseModel):
    ticket_type_id: int
    promoter_id: int
    capacity: int = Field(ge=0)


class AllocationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    event_id: int
    ticket_type_id: int
    promoter_id: int
    capacity: int
    is_active: bool
    # Boletas vivas contra este cupo (excluye anuladas/reembolsadas). La UI lo
    # necesita para el medidor "Usados X/Y" del promotor.
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


class MessageOut(BaseModel):
    detail: str