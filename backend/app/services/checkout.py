"""Reserva transaccional antes del cobro externo, compartida por fan y admin."""
import psycopg
from fastapi import HTTPException
from psycopg.types.json import Jsonb

from app.core.db_errors import translate_db_error
from app.services import wompi


async def create_reserved_payment(
    db, *, event_id, ticket_type_id, reference, amount, customer_name,
    customer_phone, customer_email, user_id, coupon_id, discount,
    expires_at, name, description, redirect_url, customer_birth_date=None,
    promoter_id=None, sale_channel=None, fee_breakdown=None,
):
    try:
        async with db.cursor() as cur:
            await cur.execute(
                "SELECT reserve_ticket_payment(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) AS id",
                (event_id, ticket_type_id, reference, amount, customer_name,
                 customer_phone, customer_email, user_id, coupon_id, discount, expires_at,
                 customer_birth_date),
            )
            payment_id = (await cur.fetchone())["id"]
            if (promoter_id is not None or sale_channel is not None
                    or fee_breakdown is not None):
                breakdown = fee_breakdown or {}
                await cur.execute(
                    """
                    UPDATE ticket_payments
                       SET promoter_id = COALESCE(%s, promoter_id),
                           sale_channel = COALESCE(%s, sale_channel),
                           fee_breakdown = COALESCE(%s, fee_breakdown),
                           platform_fee_cents = COALESCE(%s, platform_fee_cents),
                           organizer_net_cents = COALESCE(%s, organizer_net_cents)
                     WHERE id = %s
                    """,
                    (
                        promoter_id, sale_channel,
                        Jsonb(breakdown) if fee_breakdown else None,
                        breakdown.get("platform_fee_cents"),
                        breakdown.get("organizer_net_cents"),
                        payment_id,
                    ),
                )
        await db.commit()
    except psycopg.Error as error:
        http = translate_db_error(error, overrides={
            "coupon_unavailable": (409, "El cupon ya no esta disponible. Revisa el precio e intenta de nuevo."),
            "payment_reservation_expired": (409, "El plazo para comprar termino."),
            "under_age_restriction": (
                403,
                "Este evento es para mayores de la edad minima indicada. "
                "Revisa la fecha de nacimiento o elige otro evento.",
            ),
        })
        if http:
            raise http from error
        raise

    try:
        link = await wompi.create_payment_link(
            name=name, description=description, amount_in_cents=amount,
            expires_at_iso=expires_at.isoformat(), redirect_url=redirect_url,
        )
    except wompi.WompiError as error:
        # Solo liberamos cuando no se pudo entregar un enlace. La fila queda
        # auditada; jamas se elimina un cobro de la base.
        await db.execute(
            "UPDATE ticket_payments SET status='expired', reservation_expires_at=NULL WHERE id=%s",
            (payment_id,),
        )
        await db.commit()
        raise HTTPException(502, "No pudimos iniciar el pago. Intenta de nuevo.") from error

    await db.execute("UPDATE ticket_payments SET provider_ref=%s WHERE id=%s",
                     (str(link["id"]), payment_id))
    await db.commit()
    return payment_id, link
