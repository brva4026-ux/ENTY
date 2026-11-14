"""Reserva transaccional antes del cobro externo, compartida por fan y admin."""
import psycopg
from fastapi import HTTPException

from app.core.db_errors import translate_db_error
from app.services import wompi


async def create_reserved_payment(
    db, *, event_id, ticket_type_id, reference, amount, customer_name,
    customer_phone, customer_email, user_id, coupon_id, discount,
    expires_at, name, description, redirect_url,
):
    try:
        async with db.cursor() as cur:
            await cur.execute(
                "SELECT reserve_ticket_payment(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) AS id",
                (event_id, ticket_type_id, reference, amount, customer_name,
                 customer_phone, customer_email, user_id, coupon_id, discount, expires_at),
            )
            payment_id = (await cur.fetchone())["id"]
        await db.commit()
    except psycopg.Error as error:
        http = translate_db_error(error, overrides={
            "coupon_unavailable": (409, "El cupon ya no esta disponible. Revisa el precio e intenta de nuevo."),
            "payment_reservation_expired": (409, "El plazo para comprar termino."),
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
