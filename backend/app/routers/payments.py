"""Cobros online con Wompi (mig 023, E3 del ciclo DICE).

El bar cobra: el admin genera el link de pago desde el dashboard, lo manda
por WhatsApp y cuando Wompi aprueba, su WEBHOOK emite la boleta. El dinero
entra primero, el QR despues.

Seguridad del webhook (docs.wompi.co):
  * checksum = SHA256(concat(valores de signature.properties) + timestamp +
    secreto de eventos). Las properties se LEEN del evento (pueden variar),
    nunca se asumen fijas.
  * El payload se guarda crudo en ticket_payments.raw_payload y el monto lo
    valida la SQL contra la DB (payment_amount_mismatch): el payload no se
    confia, solo audita.
  * La ligazon webhook -> cobro es payment_link_id -> provider_ref (UNIQUE
    parcial): los links de Wompi no soportan reference por transaccion.
"""
import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.audit import write_audit
from app.core.config import get_settings
from app.core.db import get_db
from app.core.db_errors import translate_db_error
from app.core.refs import payment_reference
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    PaymentCreateOut,
    PaymentCreateRequest,
    PaymentFulfillOut,
    PaymentOut,
    PaymentsListOut,
)
from app.services import wompi
from app.services.checkout import create_reserved_payment

router = APIRouter(tags=["payments"])


def _check_signature(payload: dict, checksum: str) -> bool:
    """Valida la firma del evento de Wompi (SHA256 + secreto compartido)."""
    secret = get_settings().wompi_events_secret
    if not secret or not checksum:
        return False
    sig = payload.get("signature") or {}
    props = sig.get("properties") or []
    data = payload.get("data") or {}
    pieces: list[str] = []
    for prop in props:
        value: object = data
        for part in str(prop).split("."):
            value = value.get(part) if isinstance(value, dict) else None
        pieces.append("" if value is None else str(value))
    pieces.append(str(payload.get("timestamp", "")))
    pieces.append(secret)
    expected = hashlib.sha256("".join(pieces).encode("utf-8")).hexdigest()
    return expected.upper() == str(checksum).upper()


def _handle(e: psycopg.errors.Error) -> None:
    """Errores SQL de negocio de approve_ticket_payment → HTTP (mapa único)."""
    http = translate_db_error(
        e,
        overrides={"event_not_open_for_sales": (409, "El evento ya no acepta emisiones")},
    )
    if http is not None:
        raise http
    raise e


@router.post(
    "/venues/{venue_id}/events/{event_id}/payments",
    response_model=PaymentCreateOut,
    status_code=201,
)
async def create_payment(
    venue_id: int,
    event_id: int,
    body: PaymentCreateRequest,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """El admin cobra una boleta online: crea el link de Wompi y el cobro
    queda 'pending' hasta que el webhook confirme el pago."""
    ensure_roles(user, venue_id, "super_admin", "admin")
    s = get_settings()
    if not s.wompi_enabled:
        raise HTTPException(503, "Pagos online no configurados en este entorno")

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT status FROM venue_payout_profiles WHERE venue_id=%s",
            (venue_id,),
        )
        profile = await cur.fetchone()
        if not profile or profile["status"] != "approved":
            raise HTTPException(
                409, "El organizador aún no está habilitado para cobrar en línea."
            )
        # El tipo debe ser del evento (y del bar): evita cobrar por un tipo
        # de otro evento.
        await cur.execute(
            """
            SELECT t.id FROM ticket_types t
              JOIN events e ON e.id = t.event_id
             WHERE t.id = %s AND e.id = %s AND e.venue_id = %s
            """,
            (body.ticket_type_id, event_id, venue_id),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Ese tipo de boleta no existe en este evento")

        # Expiracion del link: fin del evento (o 7 dias, lo que sea menor).
        await cur.execute(
            """
            SELECT name AS event_name,
                   COALESCE(ends_at, starts_at + INTERVAL '12 hours') AS end_at
              FROM events WHERE id = %s
            """,
            (event_id,),
        )
        ev = await cur.fetchone()
        if not ev:
            raise HTTPException(404, "Evento no encontrado")
        now = datetime.now(timezone.utc)
        expires_at = min(ev["end_at"], now + timedelta(minutes=15))
        if expires_at <= now:
            raise HTTPException(409, "El evento ya termino: no se pueden crear cobros")

        reference = payment_reference(event_id)
        payment_id, link = await create_reserved_payment(
            db, event_id=event_id, ticket_type_id=body.ticket_type_id,
            reference=reference, amount=body.amount_in_cents,
            customer_name=body.customer_name, customer_phone=body.customer_phone,
            customer_email=body.customer_email, user_id=user["id"],
            coupon_id=None, discount=0, expires_at=expires_at,
            name=f"Boleta - {ev['event_name']}",
            description=f"Cobro para {body.customer_name} (evento {ev['event_name']})",
            redirect_url=f"{s.app_public_url}/evento/{event_id}?pago={reference}",
            customer_birth_date=body.customer_birth_date,
        )

    return PaymentCreateOut(
        payment_id=payment_id,
        reference=reference,
        payment_url=wompi.link_public_url(link),
        amount_in_cents=body.amount_in_cents,
    )


@router.post(
    "/venues/{venue_id}/events/{event_id}/payments/{payment_id}/fulfill",
    response_model=PaymentFulfillOut,
)
async def fulfill_payment(
    venue_id: int,
    event_id: int,
    payment_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Emite la boleta de un cobro que Wompi aprobó sin poder emitirla.

    Es la salida operativa de `paid_unfulfilled`: el dinero ya entró, pero la
    boleta no existe (se llenó el aforo, el evento estaba cerrado, el cupón se
    agotó). Administración libera cupo o reabre la venta y reintenta aquí.
    Reutiliza el cobro original; nunca crea un segundo pago.
    """
    ensure_roles(user, venue_id, "super_admin", "admin")

    async with db.transaction(), db.cursor() as cur:
        await cur.execute(
            """
            SELECT p.id, p.status, p.ticket_id, p.fulfillment_error
              FROM ticket_payments p
              JOIN events e ON e.id = p.event_id
             WHERE p.id=%s AND p.event_id=%s AND e.venue_id=%s
             FOR UPDATE OF p
            """,
            (payment_id, event_id, venue_id),
        )
        payment = await cur.fetchone()
        if not payment:
            raise HTTPException(404, "Cobro no encontrado")
        if payment["status"] == "approved" and payment["ticket_id"]:
            return PaymentFulfillOut(
                payment_id=payment_id,
                ticket_id=payment["ticket_id"],
                duplicate=True,
            )
        if payment["status"] != "paid_unfulfilled":
            raise HTTPException(
                409,
                "Ese cobro no está pendiente de emisión: "
                f"su estado es {payment['status']}.",
            )

        raw_token = secrets.token_urlsafe(24)
        try:
            await cur.execute(
                "SELECT fulfill_paid_payment(%s, %s, %s)",
                (payment_id, raw_token, user["id"]),
            )
            row = await cur.fetchone()
            ticket_id = (
                row["fulfill_paid_payment"] if isinstance(row, dict) else row[0]
            )
        except psycopg.errors.Error as error:
            http = translate_db_error(
                error,
                overrides={
                    "payment_not_fulfillable": (
                        409,
                        "Ese cobro ya no se puede emitir.",
                    ),
                    "ticket_type_sold_out": (
                        409,
                        "No hay cupo en esa localidad. Libera cupo o amplía "
                        "la cantidad y vuelve a intentar.",
                    ),
                    "event_at_capacity": (
                        409,
                        "El evento está lleno. Libera cupo o amplía el aforo "
                        "y vuelve a intentar.",
                    ),
                    "event_not_open_for_sales": (
                        409,
                        "El evento no está abierto para venta. Reábrelo o "
                        "gestiona el reembolso del cobro.",
                    ),
                    "ticket_type_inactive": (
                        409,
                        "La localidad está inactiva. Actívala y vuelve a intentar.",
                    ),
                    "coupon_unavailable": (
                        409,
                        "El cupón de este cobro ya no está disponible.",
                    ),
                },
            )
            if http is not None:
                raise http from error
            raise

        await write_audit(
            cur,
            venue_id,
            user["id"],
            "payment_fulfilled",
            "ticket_payment",
            payment_id,
            {
                "event_id": event_id,
                "ticket_id": ticket_id,
                "previous_error": payment["fulfillment_error"],
            },
        )

    return PaymentFulfillOut(
        payment_id=payment_id,
        ticket_id=ticket_id,
        raw_token=raw_token,
    )


@router.get(
    "/venues/{venue_id}/events/{event_id}/payments",
    response_model=PaymentsListOut,
)
async def list_payments(
    venue_id: int,
    event_id: int,
    user: Annotated[dict, Depends(get_current_user)],
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Cobros del evento para el dashboard (con la boleta emitida, si la hay)."""
    ensure_roles(user, venue_id, "super_admin", "admin")

    async with db.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM events WHERE id=%s AND venue_id=%s", (event_id, venue_id)
        )
        if not await cur.fetchone():
            raise HTTPException(404, "Evento no encontrado")

        await cur.execute(
            "SELECT count(*)::int AS n FROM ticket_payments WHERE event_id = %s",
            (event_id,),
        )
        total = (await cur.fetchone())["n"]
        await cur.execute(
            """
            SELECT id, reference, status, amount_in_cents, customer_name,
                   customer_phone, customer_email, provider_ref, ticket_id,
                   transaction_id, approved_at, created_at, fulfillment_error
              FROM ticket_payments
             WHERE event_id = %s
             ORDER BY id DESC
             LIMIT 200
            """,
            (event_id,),
        )
        rows = await cur.fetchall()

    items = []
    for r in rows:
        out = PaymentOut(
            id=r["id"],
            reference=r["reference"],
            status=r["status"],
            amount_in_cents=r["amount_in_cents"],
            customer_name=r["customer_name"],
            customer_phone=r["customer_phone"],
            customer_email=r["customer_email"],
            ticket_id=r["ticket_id"],
            transaction_id=r["transaction_id"],
            approved_at=r["approved_at"],
            created_at=r["created_at"],
            fulfillment_error=r["fulfillment_error"],
            # URL reconstruida del provider_ref: sirve para REENVIAR el
            # enlace mientras el cobro sigue pendiente.
            payment_url=(
                wompi.link_public_url({"slug": r["provider_ref"]})
                if r["provider_ref"]
                else None
            ),
        )
        items.append(out)
    return PaymentsListOut(total=total, items=items)


@router.post("/payments/wompi/webhook")
async def wompi_webhook(
    request: Request,
    db: Annotated[psycopg.AsyncConnection, Depends(get_db)],
):
    """Webhook de Wompi: publico, valida firma y emite la boleta.

    Si no le respondemos 200, Wompi reintenta (30min/3h/24h). Por eso:
    respondemos 200 en cuanto el evento es legible y de los nuestros, AUNQUE
    el negocio no aplique (el idempotente de la DB se encarga); 403 solo si
    la firma no valida (no es Wompi) y 409/500 para que reintente lo que
    puede resolver solo.
    """
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "Cuerpo no es JSON valido")
    if not isinstance(payload, dict) or "event" not in payload:
        raise HTTPException(400, "Evento malformado")
    if payload.get("event") != "transaction.updated":
        return {"ok": True}  # evento conocido pero no relevante para este MVP

    data = payload.get("data") or {}
    tx = data.get("transaction") or {}
    checksum = (payload.get("signature") or {}).get("checksum", "")
    if not _check_signature(payload, checksum):
        raise HTTPException(403, "Firma invalida")

    link_id = str(tx.get("payment_link_id") or "")
    transaction_id = str(tx.get("id") or "")
    amount = tx.get("amount_in_cents")
    tx_status = tx.get("status")
    if not link_id:
        # Transaccion directa (no nacida de un link): este MVP no las crea.
        return {"ok": True}

    # Monto saneado ANTES de la SQL: la funcion compara bigint; un payload
    # sin monto no puede colarse como "igual" (NULL <> x es NULL y evitaria
    # el raise de la comparacion).
    if not isinstance(amount, int):
        amount = -1

    async with db.cursor() as cur:
        await cur.execute(
            """
            SELECT id, reference, promoter_id, sale_channel
              FROM ticket_payments
             WHERE provider = 'wompi' AND provider_ref = %s
            """,
            (link_id,),
        )
        payment = await cur.fetchone()
        if not payment:
            # No es un cobro nuestro (ej. link creado a mano en el dashboard
            # de Wompi): 200 para que Wompi no reintente eternamente.
            return {"ok": True}

        raw = json.dumps(payload, default=str)
        raw_token = secrets.token_urlsafe(24)  # 192 bits: la credencial del QR
        try:
            await cur.execute(
                "SELECT approve_ticket_payment(%s, %s, %s, %s, %s, %s::jsonb)",
                (payment["reference"], transaction_id, tx_status, amount, raw_token, raw),
            )
            row = await cur.fetchone()
            ticket_id = row["approve_ticket_payment"] if isinstance(row, dict) else row[0]
            if ticket_id and payment["sale_channel"] == "promoter_link":
                await cur.execute(
                    "UPDATE tickets SET sale_channel='promoter_link' WHERE id=%s",
                    (ticket_id,),
                )
                await cur.execute(
                    """
                    INSERT INTO promoter_link_events (link_id, kind, reference)
                    SELECT l.id, 'purchase_approved', %s
                      FROM promoter_links l
                     WHERE l.event_id = (SELECT event_id FROM ticket_payments WHERE id=%s)
                       AND l.promoter_id = %s
                    ON CONFLICT DO NOTHING
                    """,
                    (payment["reference"], payment["id"], payment["promoter_id"]),
                )
            await db.commit()
        except psycopg.errors.Error as e:
            _handle(e)

    ticket_id = row["approve_ticket_payment"] if isinstance(row, dict) else row[0]
    return {"ok": True, "ticket_id": ticket_id}
