-- Reservas de checkout y conciliacion de pagos tardios. No modifica pagos previos.
ALTER TABLE public.ticket_payments ADD COLUMN IF NOT EXISTS reservation_expires_at timestamptz;
ALTER TABLE public.ticket_payments ADD COLUMN IF NOT EXISTS fulfillment_error text;
ALTER TABLE public.ticket_payments DROP CONSTRAINT IF EXISTS ticket_payments_status_check;
ALTER TABLE public.ticket_payments ADD CONSTRAINT ticket_payments_status_check
 CHECK (status IN ('pending','approved','declined','voided','expired','paid_unfulfilled'));

CREATE INDEX IF NOT EXISTS ix_ticket_payments_reservations ON public.ticket_payments (event_id, ticket_type_id, reservation_expires_at) WHERE status='pending';
CREATE INDEX IF NOT EXISTS ix_ticket_payments_coupon_reservations ON public.ticket_payments (coupon_id, reservation_expires_at) WHERE status='pending' AND coupon_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.reserve_ticket_payment(p_event_id bigint, p_type_id bigint, p_reference text, p_amount bigint, p_name text, p_phone text, p_email text, p_user_id bigint, p_coupon_id bigint, p_discount bigint, p_expires timestamptz) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_type ticket_types%ROWTYPE;
    v_event events%ROWTYPE;
    v_coupon coupons%ROWTYPE;
    v_count bigint;
    v_id bigint;
BEGIN
    -- Mismo orden de locks que emit_ticket: localidad, evento, cupon.
    SELECT * INTO v_type FROM ticket_types WHERE id=p_type_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_type_not_found'; END IF;
    IF v_type.event_id <> p_event_id THEN RAISE EXCEPTION 'ticket_type_not_in_event'; END IF;
    IF NOT v_type.is_active THEN RAISE EXCEPTION 'ticket_type_inactive'; END IF;
    SELECT * INTO v_event FROM events WHERE id=p_event_id FOR UPDATE;
    IF v_event.status NOT IN ('published','live') THEN RAISE EXCEPTION 'event_not_open_for_sales'; END IF;
    IF p_expires <= now() THEN RAISE EXCEPTION 'payment_reservation_expired'; END IF;

    SELECT count(*) INTO v_count FROM tickets
     WHERE ticket_type_id=p_type_id AND status NOT IN ('voided','refunded');
    v_count := v_count + (SELECT count(*) FROM ticket_payments
     WHERE ticket_type_id=p_type_id AND status='pending' AND reservation_expires_at > now());
    IF v_count >= v_type.quantity THEN RAISE EXCEPTION 'ticket_type_sold_out'; END IF;
    SELECT count(*) INTO v_count FROM tickets
     WHERE event_id=p_event_id AND status NOT IN ('voided','refunded');
    v_count := v_count + (SELECT count(*) FROM ticket_payments
     WHERE event_id=p_event_id AND status='pending' AND reservation_expires_at > now());
    IF v_count >= v_event.capacity THEN RAISE EXCEPTION 'event_at_capacity'; END IF;

    IF p_coupon_id IS NOT NULL THEN
        SELECT * INTO v_coupon FROM coupons WHERE id=p_coupon_id AND event_id=p_event_id FOR UPDATE;
        IF NOT FOUND OR NOT v_coupon.is_active OR v_coupon.expires_at <= now() THEN
            RAISE EXCEPTION 'coupon_unavailable';
        END IF;
        SELECT count(*) INTO v_count FROM ticket_payments
         WHERE coupon_id=p_coupon_id AND status='pending' AND reservation_expires_at > now();
        IF v_coupon.max_uses IS NOT NULL AND v_coupon.used_count + v_count >= v_coupon.max_uses THEN
            RAISE EXCEPTION 'coupon_unavailable';
        END IF;
    END IF;
    INSERT INTO ticket_payments (venue_id,event_id,ticket_type_id,reference,
        amount_in_cents,customer_name,customer_phone,customer_email,created_by_user_id,
        coupon_id,discount_in_cents,reservation_expires_at)
    VALUES (v_event.venue_id,p_event_id,p_type_id,p_reference,p_amount,p_name,p_phone,
        p_email,p_user_id,p_coupon_id,p_discount,p_expires) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.emit_ticket(p_event_id bigint, p_ticket_type_id bigint, p_allocation_id bigint, p_sold_by_user_id bigint, p_customer_name text, p_raw_token text, p_customer_phone text DEFAULT NULL::text, p_customer_email text DEFAULT NULL::text, p_payment_method text DEFAULT NULL::text) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_type           ticket_types%ROWTYPE;
    v_alloc          promoter_allocations%ROWTYPE;
    v_used_in_alloc  bigint;
    v_used_in_type   bigint;
    v_used_total     bigint;
    v_event_capacity bigint;
    v_status_allowed text;
    v_token_hash     text;
    v_ticket_id      bigint;
    v_payment_method text;
BEGIN
    -- Bloquea la localidad: serializa emisiones concurrentes contra su cupo.
    SELECT * INTO v_type FROM ticket_types WHERE id = p_ticket_type_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_type_not_found'; END IF;
    IF v_type.event_id <> p_event_id THEN
        RAISE EXCEPTION 'ticket_type_not_in_event';
    END IF;

    IF v_type.price_cents > 0 AND p_allocation_id IS NOT NULL THEN
        RAISE EXCEPTION 'paid_ticket_tied_to_promoter_allocation: usar venta directa para boletas de pago';
    END IF;

    -- Medio de pago: una boleta gratis es cortesía por definición (no hay
    -- dinero que conciliar). Una de pago sin método explícito se asume venta
    -- directa en efectivo (la taquilla es el caso por defecto del bar).
    IF v_type.price_cents = 0 THEN
        v_payment_method := 'cortesia';
    ELSE
        v_payment_method := COALESCE(p_payment_method, 'efectivo');
        IF v_payment_method NOT IN ('online', 'efectivo', 'transferencia') THEN
            RAISE EXCEPTION 'invalid_payment_method';
        END IF;
    END IF;

    -- 1) Bloquear el evento: serializa emisiones concurrentes y valida estado.
    SELECT capacity, status INTO v_event_capacity, v_status_allowed
      FROM events WHERE id = p_event_id FOR UPDATE;
    IF v_status_allowed NOT IN ('published', 'live') THEN
        RAISE EXCEPTION 'event_not_open_for_sales';
    END IF;

    -- 2) Cupo del promotor (si aplica): bloquear fila y validar capacidad.
    IF p_allocation_id IS NOT NULL THEN
        SELECT * INTO v_alloc FROM promoter_allocations WHERE id = p_allocation_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'allocation_not_found'; END IF;
        SELECT count(*) INTO v_used_in_alloc
          FROM tickets
         WHERE allocation_id = p_allocation_id
           AND status NOT IN ('voided', 'refunded');
        IF v_used_in_alloc >= v_alloc.capacity THEN
            RAISE EXCEPTION 'promoter_quota_exceeded';
        END IF;
    END IF;

    -- 3) Inventario DE ESTA LOCALIDAD (mig 033): el tope es el suyo, no la
    -- suma de todas. Antes, una localidad chica se podía sobrevender con el
    -- sobrante de las demás.
    SELECT count(*) INTO v_used_in_type
      FROM tickets
     WHERE event_id = p_event_id
       AND ticket_type_id = p_ticket_type_id
       AND status NOT IN ('voided', 'refunded');
    v_used_in_type := v_used_in_type + (SELECT count(*) FROM ticket_payments
     WHERE ticket_type_id=p_ticket_type_id AND status='pending' AND reservation_expires_at > now());
    IF v_used_in_type >= v_type.quantity THEN
        RAISE EXCEPTION 'ticket_type_sold_out';
    END IF;

    -- 3b) Aforo físico del evento (tope distinto del inventario por localidad).
    SELECT count(*) INTO v_used_total
      FROM tickets
     WHERE event_id = p_event_id
       AND status NOT IN ('voided', 'refunded');
    v_used_total := v_used_total + (SELECT count(*) FROM ticket_payments
     WHERE event_id=p_event_id AND status='pending' AND reservation_expires_at > now());
    IF v_used_total >= v_event_capacity THEN
        RAISE EXCEPTION 'event_at_capacity';
    END IF;

    v_token_hash := encode(digest(p_raw_token, 'sha256'), 'hex');

    INSERT INTO tickets (
        event_id, ticket_type_id, allocation_id, sold_by_user_id,
        customer_name, customer_phone, customer_email, token_hash,
        price_cents_snapshot, payment_method
    ) VALUES (
        p_event_id, p_ticket_type_id, p_allocation_id, p_sold_by_user_id,
        p_customer_name, p_customer_phone, p_customer_email, v_token_hash,
        v_type.price_cents, v_payment_method
    ) RETURNING id INTO v_ticket_id;

    RETURN v_ticket_id;
END;
$$;

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

    -- Idempotencia: el reintento del webhook llega aqui con el cobro ya
    -- aprobado. Devolver el MISMO ticket_id sin tocar nada.
    IF v_payment.status IN ('approved', 'paid_unfulfilled') THEN
        RETURN v_payment.ticket_id;
    END IF;

    IF p_status <> 'APPROVED' THEN
        -- Estados finales no aprobados (DECLINED/VOIDED/ERROR) e
        -- intermedios: quedan auditados, no emiten. El cobro muere y el
        -- bar crea uno nuevo (una referencia no se reutiliza).
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

    -- Un cobro que ya termino mal no revive (Wompi no pasa de un estado
    -- final a APPROVED; si llegara a pasar, el 409 de la API lo hace
    -- visible en lugar de emitir gratis).
    IF v_payment.status <> 'pending' THEN
        RAISE EXCEPTION 'payment_not_approvable';
    END IF;

    -- El monto pagado debe ser EXACTAMENTE el cobrado.
    IF p_amount_in_cents <> v_payment.amount_in_cents THEN
        RAISE EXCEPTION 'payment_amount_mismatch';
    END IF;

    BEGIN
        -- Libera solo NUESTRA reserva dentro de esta transaccion; los locks
        -- de emit_ticket protegen las demas ventas. Un error revierte el bloque.
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
            v_payment.customer_phone, v_payment.customer_email, 'online');
        -- El monto historico siempre es lo realmente pagado, incluso si un
        -- admin negocio un precio o cambio la tarifa despues de crear el link.
        UPDATE tickets SET price_cents_snapshot=v_payment.amount_in_cents WHERE id=v_ticket;
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
