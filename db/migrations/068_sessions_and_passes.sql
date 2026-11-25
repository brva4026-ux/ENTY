-- 068: eventos con varias jornadas y pases que cubren todas.
--
-- Una sesión es un evento hijo con su propia fecha, aforo y localidades.
-- Un pase es una localidad del evento padre que, al venderse, emite una
-- boleta por cada sesión incluida. La boleta del padre representa el pase;
-- las boletas hijas son las que se escanean en cada jornada.

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS parent_event_id bigint
    REFERENCES public.events(id) ON DELETE CASCADE;

-- Localidad técnica del pase: se emite pero no se vende suelta. La ficha
-- pública la esconde; la puerta la escanea como cualquier boleta.
ALTER TABLE public.ticket_types
    ADD COLUMN IF NOT EXISTS is_pass_only boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_events_parent
    ON public.events (parent_event_id, starts_at);

CREATE TABLE IF NOT EXISTS public.pass_sessions (
    pass_ticket_type_id bigint NOT NULL
        REFERENCES public.ticket_types(id) ON DELETE CASCADE,
    session_event_id bigint NOT NULL
        REFERENCES public.events(id) ON DELETE CASCADE,
    session_ticket_type_id bigint NOT NULL
        REFERENCES public.ticket_types(id) ON DELETE CASCADE,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (pass_ticket_type_id, session_event_id)
);

CREATE INDEX IF NOT EXISTS idx_pass_sessions_session
    ON public.pass_sessions (session_event_id);

-- Qué boletas hijas emitió cada cobro. Sirve para idempotencia y para que
-- Administración vea el pase completo sin adivinar por nombre.
CREATE TABLE IF NOT EXISTS public.ticket_payment_tickets (
    payment_id bigint NOT NULL
        REFERENCES public.ticket_payments(id) ON DELETE CASCADE,
    ticket_id bigint NOT NULL
        REFERENCES public.tickets(id) ON DELETE CASCADE,
    event_id bigint NOT NULL
        REFERENCES public.events(id) ON DELETE CASCADE,
    session_event_id bigint
        REFERENCES public.events(id) ON DELETE CASCADE,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (payment_id, session_event_id)
);

-- Emite las boletas hijas de un pase. La llama approve_ticket_payment (y la
-- recuperación de pagos) después de emitir la boleta del padre. Es idempotente
-- por (payment_id, session_event_id).
CREATE OR REPLACE FUNCTION public.emit_pass_children(
    p_payment_id bigint,
    p_raw_token text,
    p_by_user_id bigint
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_payment ticket_payments%ROWTYPE;
    v_row     record;
    v_child   bigint;
    v_token   text;
BEGIN
    SELECT * INTO v_payment FROM ticket_payments WHERE id = p_payment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'payment_not_found';
    END IF;

    FOR v_row IN
        SELECT ps.session_event_id, ps.session_ticket_type_id
          FROM pass_sessions ps
         WHERE ps.pass_ticket_type_id = v_payment.ticket_type_id
         ORDER BY ps.session_event_id
    LOOP
        IF EXISTS (
            SELECT 1 FROM ticket_payment_tickets
             WHERE payment_id = p_payment_id
               AND session_event_id = v_row.session_event_id
        ) THEN
            CONTINUE;
        END IF;

        v_token := encode(
            digest(p_raw_token || ':' || v_row.session_event_id::text, 'sha256'),
            'hex'
        );
        v_child := emit_ticket(
            v_row.session_event_id,
            v_row.session_ticket_type_id,
            NULL,
            COALESCE(v_payment.created_by_user_id, p_by_user_id),
            v_payment.customer_name,
            v_token,
            v_payment.customer_phone,
            v_payment.customer_email,
            'online',
            v_payment.customer_birth_date
        );
        UPDATE tickets
           SET price_cents_snapshot = 0,
               sale_channel = CASE
                   WHEN v_payment.sale_channel = 'promoter_link' THEN 'promoter_link'
                   ELSE 'public'
               END
         WHERE id = v_child;

        INSERT INTO ticket_payment_tickets
            (payment_id, ticket_id, event_id, session_event_id)
        VALUES (p_payment_id, v_child, v_row.session_event_id, v_row.session_event_id);
    END LOOP;
END;
$$;

COMMENT ON FUNCTION public.emit_pass_children(bigint, text, bigint) IS
    'Emite una boleta por sesión incluida en un pase. Idempotente.';

-- approve_ticket_payment: misma firma; si la localidad es un pase, emite las
-- boletas hijas en la misma transacción. Si una sesión está agotada, todo el
-- cobro cae a 'paid_unfulfilled' y Administración lo resuelve, igual que hoy.
CREATE OR REPLACE FUNCTION public.approve_ticket_payment(p_reference text, p_transaction_id text, p_status text, p_amount_in_cents bigint, p_raw_token text, p_payload jsonb DEFAULT NULL::jsonb) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_payment  ticket_payments%ROWTYPE;
    v_ticket   bigint;
    v_event    events%ROWTYPE;
    v_type     ticket_types%ROWTYPE;
BEGIN
    SELECT * INTO v_payment FROM ticket_payments
     WHERE reference = p_reference
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'payment_not_found';
    END IF;

    IF v_payment.status IN ('approved', 'paid_unfulfilled') THEN
        RETURN v_payment.ticket_id;
    END IF;

    IF p_status <> 'APPROVED' THEN
        UPDATE ticket_payments
           SET transaction_id = COALESCE(p_transaction_id, transaction_id),
               status = CASE p_status
                            WHEN 'DECLINED' THEN 'declined'
                            WHEN 'VOIDED'   THEN 'voided'
                            WHEN 'ERROR'    THEN 'expired'
                            ELSE status
                        END,
               raw_payload = COALESCE(p_payload, raw_payload)
         WHERE id = v_payment.id;
        RETURN NULL;
    END IF;

    IF v_payment.status <> 'pending' THEN
        RAISE EXCEPTION 'payment_not_approvable';
    END IF;

    IF p_amount_in_cents <> v_payment.amount_in_cents THEN
        RAISE EXCEPTION 'payment_amount_mismatch';
    END IF;

    BEGIN
        UPDATE ticket_payments SET reservation_expires_at=NULL WHERE id=v_payment.id;
        IF v_payment.coupon_id IS NOT NULL THEN
            PERFORM 1 FROM ticket_types WHERE id=v_payment.ticket_type_id FOR UPDATE;
            PERFORM 1 FROM events WHERE id=v_payment.event_id FOR UPDATE;
            PERFORM 1 FROM coupons WHERE id=v_payment.coupon_id FOR UPDATE;
            IF EXISTS (SELECT 1 FROM coupons c WHERE c.id=v_payment.coupon_id
                       AND c.max_uses IS NOT NULL AND c.used_count +
                         (SELECT count(*) FROM ticket_payments p WHERE p.coupon_id=c.id
                          AND p.status='pending' AND p.reservation_expires_at > now()) >= c.max_uses) THEN
                RAISE EXCEPTION 'coupon_unavailable';
            END IF;
        END IF;
        v_ticket := emit_ticket(v_payment.event_id, v_payment.ticket_type_id, NULL,
            v_payment.created_by_user_id, v_payment.customer_name, p_raw_token,
            v_payment.customer_phone, v_payment.customer_email, 'online',
            v_payment.customer_birth_date);
        UPDATE tickets SET price_cents_snapshot=v_payment.amount_in_cents WHERE id=v_ticket;

        IF EXISTS (
            SELECT 1 FROM pass_sessions
             WHERE pass_ticket_type_id = v_payment.ticket_type_id
        ) THEN
            PERFORM emit_pass_children(
                v_payment.id, p_raw_token, v_payment.created_by_user_id
            );
        END IF;

        IF v_payment.coupon_id IS NOT NULL THEN
            UPDATE coupons SET used_count=used_count+1 WHERE id=v_payment.coupon_id;
        END IF;
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT IN ('ticket_type_sold_out','event_at_capacity',
            'event_not_open_for_sales','ticket_type_inactive','coupon_unavailable') THEN
            RAISE;
        END IF;
        UPDATE ticket_payments SET status='paid_unfulfilled',
            reservation_expires_at=NULL, transaction_id=p_transaction_id,
            approved_at=now(), raw_payload=p_payload, fulfillment_error=SQLERRM
         WHERE id=v_payment.id;
        PERFORM notify_venue_admins(v_payment.venue_id, 'payment_approved',
            'Pago recibido: requiere revision',
            format('El pago %s de %s se recibio sin emitir boleta. Revisar disponibilidad o gestionar reembolso. Motivo: %s',
                v_payment.reference, v_payment.customer_name, SQLERRM),
            '/admin?event=' || v_payment.event_id || '&tab=cobros');
        RETURN NULL;
    END;

    UPDATE ticket_payments
       SET status = 'approved',
           transaction_id = COALESCE(p_transaction_id, transaction_id),
           approved_at = now(),
           ticket_id = v_ticket,
           raw_payload = COALESCE(p_payload, raw_payload)
     WHERE id = v_payment.id;

    PERFORM notify_venue_admins(
        v_payment.venue_id,
        'payment_approved',
        'Pago aprobado',
        format(
            'Pago de %s aprobado por Wompi: la boleta esta lista para entregar en el listado del evento.',
            v_payment.customer_name
        ),
        format('/admin?event=%s&tab=entradas', v_payment.event_id)
    );

    RETURN v_ticket;
END
$$;

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

    UPDATE tickets
       SET price_cents_snapshot = v_payment.amount_in_cents,
           sale_channel = CASE
               WHEN v_payment.sale_channel = 'promoter_link' THEN 'promoter_link'
               ELSE 'public'
           END
     WHERE id = v_ticket;

    IF EXISTS (
        SELECT 1 FROM pass_sessions
         WHERE pass_ticket_type_id = v_payment.ticket_type_id
    ) THEN
        PERFORM emit_pass_children(
            v_payment.id, p_raw_token, COALESCE(v_payment.created_by_user_id, p_by_user_id)
        );
    END IF;

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
