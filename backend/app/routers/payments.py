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

from app.core.config import get_settings
from app.core.db import get_db
from app.core.refs import payment_reference
from app.deps import ensure_roles, get_current_user
from app.schemas import (
    PaymentCreateOut,
    PaymentCreateRequest,
    PaymentOut,
    PaymentsListOut,
)
from app.services import wompi
from app.services.wompi import WompiError

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
    """Traduce errores SQL de negocio de approve_ticket_payment a HTTP."""
    diag = getattr(e, "diag", None)
    primary = (getattr(diag, "message_primary", "") or "") or str(e)
    if "payment_amount_mismatch" in primary:
        raise HTTPException(409, "El monto pagado no coincide con el cobrado")
    if "payment_not_approvable" in primary:
        raise HTTPException(409, "El cobro ya no esta pendiente: no se puede aprobar")
    if "payment_not_found" in primary:
        raise HTTPException(404, "Cobro no encontrado")
    if "event_not_open_for_sales" in primary:
        raise HTTPException(409, "El evento ya no acepta emisiones")
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
        expires_at = min(ev["end_at"], now + timedelta(days=7))
        if expires_at <= now:
            raise HTTPException(409, "El evento ya termino: no se pueden crear cobros")

        reference = payment_reference(event_id)
        try:
            link = await wompi.create_payment_link(
                name=f"Boleta - {ev['event_name']}",
                description=f"Cobro para {body.customer_name} (evento {ev['event_name']})",
                amount_in_cents=body.amount_in_cents,
                expires_at_iso=expires_at.isoformat(),
                redirect_url=f"{s.app_public_url}/t",
            )
        except WompiError as e:
            raise HTTPException(502, f"Wompi rechazo el cobro: {e}")

        # La DB registra solo lo que Wompi acepto: si el link no se creo, no
        # hay fila 'pending' huerfana.
        await cur.execute(
            """
            INSERT INTO ticket_payments
                (venue_id, event_id, ticket_type_id, reference, provider,
                 provider_ref, amount_in_cents, customer_name, customer_phone,
                 customer_email, created_by_user_id)
            VALUES (%s, %s, %s, %s, 'wompi', %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                venue_id, event_id, body.ticket_type_id, reference,
                str(link.get("id")), body.amount_in_cents, body.customer_name,
                body.customer_phone, body.customer_email, user["id"],
            ),
        )
        payment_id = (await cur.fetchone())["id"]
        await db.commit()

    return PaymentCreateOut(
        payment_id=payment_id,
        reference=reference,
        payment_url=wompi.link_public_url(link),
        amount_in_cents=body.amount_in_cents,
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
                   transaction_id, approved_at, created_at
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
            SELECT id, reference FROM ticket_payments
             WHERE provider = 'wompi' AND provider_ref = %s
             FOR UPDATE
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
            await db.commit()
        except psycopg.errors.Error as e:
            _handle(e)

    ticket_id = row["approve_ticket_payment"] if isinstance(row, dict) else row[0]
    return {"ok": True, "ticket_id": ticket_id}
