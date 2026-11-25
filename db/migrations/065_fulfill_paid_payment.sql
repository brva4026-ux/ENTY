-- Migración 065: resolver un pago aprobado sin boleta.
--
-- approve_ticket_payment deja el cobro en 'paid_unfulfilled' cuando Wompi ya
-- cobró pero la emisión no pudo completarse (aforo lleno, evento cerrado,
-- cupón agotado). Antes no había camino de salida: el dinero estaba cobrado y
-- Administración solo veía la alerta. Esta función reutiliza emit_ticket con
-- los datos ORIGINALES del cobro; no crea un segundo cobro ni inventa cupo.
--
-- Idempotente: si el cobro ya está aprobado devuelve su ticket. La emisión y
-- el cambio de estado caen en la misma transacción.

CREATE OR REPLACE FUNCTION public.fulfill_paid_payment(
    p_payment_id bigint,
    p_raw_token text,
    p_by_user_id bigint
) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_payment ticket_payments%ROWTYPE;
    v_ticket  bigint;
BEGIN
    SELECT * INTO v_payment
      FROM ticket_payments
     WHERE id = p_payment_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'payment_not_found';
    END IF;

    IF v_payment.status = 'approved' THEN
        RETURN v_payment.ticket_id;
    END IF;

    IF v_payment.status <> 'paid_unfulfilled' THEN
        RAISE EXCEPTION 'payment_not_fulfillable';
    END IF;

    v_ticket := emit_ticket(
        v_payment.event_id,
        v_payment.ticket_type_id,
        NULL,
        COALESCE(v_payment.created_by_user_id, p_by_user_id),
        v_payment.customer_name,
        p_raw_token,
        v_payment.customer_phone,
        v_payment.customer_email,
        'online',
        v_payment.customer_birth_date
    );

    -- El monto histórico es el realmente cobrado, no la tarifa de hoy. El
    -- canal sale del cobro: un enlace de promotor no es venta de taquilla.
    UPDATE tickets
       SET price_cents_snapshot = v_payment.amount_in_cents,
           sale_channel = CASE
               WHEN v_payment.sale_channel = 'promoter_link' THEN 'promoter_link'
               ELSE 'public'
           END
     WHERE id = v_ticket;

    IF v_payment.coupon_id IS NOT NULL THEN
        UPDATE coupons SET used_count = used_count + 1
         WHERE id = v_payment.coupon_id;
    END IF;

    UPDATE ticket_payments
       SET status = 'approved',
           ticket_id = v_ticket,
           approved_at = COALESCE(approved_at, now()),
           fulfillment_error = NULL
     WHERE id = v_payment.id;

    RETURN v_ticket;
END;
$$;

COMMENT ON FUNCTION public.fulfill_paid_payment(bigint, text, bigint) IS
    'Emite la boleta de un cobro aprobado que quedó sin emitir. Idempotente.';
