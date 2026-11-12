-- =============================================================================
-- 044 — Cupón con tope de usos: la validación vive en la DB, no solo al cotizar.
-- =============================================================================
-- Hallazgo (auditoría): `approve_ticket_payment` (mig 043) incrementaba
-- `coupons.used_count` SIN volver a mirar `max_uses`. El tope se validaba solo
-- en la LECTURA del checkout (`_resolve_coupon`), que es un snapshot: dos (o
-- veinte) fans que abren el checkout antes de que el primero pague pasan todos
-- la validación, y sus webhooks aprueban TODOS, porque el incremento no tenía
-- freno. Un "2x1 para los primeros 10" se podía redimir 50 veces.
--
-- La corrección cierra la puerta en el ÚNICO punto donde el cupón se consume de
-- verdad: la aprobación del pago (una llamada a función = una transacción, así
-- que el chequeo y el incremento son atómicos aun con autocommit).
--
-- Si el tope ya se agotó cuando llega el webhook, se rechaza con
-- 'coupon_exhausted'. El dinero ya entró (Wompi cobró): el cobro queda 'pending'
-- con el pago registrado en raw_payload, y la API responde 409 para que el
-- reintento no lo dé por bueno en silencio y alguien lo resuelva (devolución o
-- cortesía). Es preferible un caso visible a una boleta regalada.
--
-- Idempotente: CREATE OR REPLACE (safe re-run).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.approve_ticket_payment(p_reference text, p_transaction_id text, p_status text, p_amount_in_cents bigint, p_raw_token text, p_payload jsonb DEFAULT NULL::jsonb) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_payment  ticket_payments%ROWTYPE;
    v_coupon   coupons%ROWTYPE;
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
    IF v_payment.status = 'approved' THEN
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

    -- Cupón con tope de usos (mig 044): se revalida AQUÍ, en el consumo real.
    -- La lectura del checkout es un snapshot y no basta: N cobros creados antes
    -- del primer pago pasarian todos. FOR UPDATE serializa dos aprobaciones
    -- concurrentes del mismo cupón.
    IF v_payment.coupon_id IS NOT NULL THEN
        SELECT * INTO v_coupon FROM coupons WHERE id = v_payment.coupon_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'coupon_not_found';
        END IF;
        IF NOT v_coupon.is_active THEN
            RAISE EXCEPTION 'coupon_inactive';
        END IF;
        IF v_coupon.expires_at IS NOT NULL AND v_coupon.expires_at <= now() THEN
            RAISE EXCEPTION 'coupon_expired';
        END IF;
        IF v_coupon.max_uses IS NOT NULL AND v_coupon.used_count >= v_coupon.max_uses THEN
            RAISE EXCEPTION 'coupon_exhausted';
        END IF;
    END IF;

    SELECT * INTO v_event FROM events WHERE id = v_payment.event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'event_not_found';
    END IF;
    -- Misma guardia que emit_ticket: un evento cerrado no vende (si el fan
    -- pago tarde, el dinero esta pero la boleta no se emite: el 409 deja
    -- la situacion visible para resolverla a mano).
    IF v_event.status NOT IN ('published', 'live') THEN
        RAISE EXCEPTION 'event_not_open_for_sales';
    END IF;

    SELECT * INTO v_type FROM ticket_types WHERE id = v_payment.ticket_type_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ticket_type_not_found';
    END IF;

    -- Emision de venta directa: cupo NULL (una boleta de pago no usa cupo
    -- de promotor) y created_by = quien creo el cobro (reportes "vendida
    -- por"). La DB jamas devuelve el token: lo guarda hasheado.
    v_ticket := emit_ticket(
        v_payment.event_id,
        v_payment.ticket_type_id,
        NULL,
        v_payment.created_by_user_id,
        v_payment.customer_name,
        p_raw_token,
        v_payment.customer_phone,
        v_payment.customer_email,
        'online'
    );

    -- Cupón aplicado (mig 043): la boleta nace con el precio de lista; aquí se
    -- corrige al NETO que el fan pagó, para que el recaudo y el cierre de caja
    -- reflejen el descuento. Sin cupón, amount_in_cents == precio de lista y
    -- este bloque no hace nada.
    IF v_payment.discount_in_cents > 0 THEN
        UPDATE tickets SET price_cents_snapshot = v_payment.amount_in_cents
         WHERE id = v_ticket;
        UPDATE coupons SET used_count = used_count + 1
         WHERE id = v_payment.coupon_id;
    END IF;

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

-- ---------------------------------------------------------------------------
-- 2) REEMBOLSO: el monto no puede superar lo pagado ni ser negativo.
-- ---------------------------------------------------------------------------
-- Mismo tipo de hallazgo: el endpoint aceptaba `amount_in_cents` del cliente
-- sin tope y el esquema lo registraba tal cual. Un admin (o un bug de la UI)
-- dejaba en caja una salida mayor que el recaudo real —hasta devolver una
-- boleta de cortesía por un monto inventado.
CREATE OR REPLACE FUNCTION public.refund_ticket(p_ticket_id bigint, p_amount_in_cents bigint, p_reason text, p_by_user_id bigint) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_ticket tickets%ROWTYPE;
BEGIN
    SELECT * INTO v_ticket FROM tickets WHERE id = p_ticket_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_not_found'; END IF;

    -- Idempotente: reembolsar dos veces no duplica la salida de caja.
    IF v_ticket.status = 'refunded' THEN
        RETURN v_ticket.event_id;
    END IF;
    IF v_ticket.status = 'voided' THEN
        RAISE EXCEPTION 'cannot_refund_voided';
    END IF;
    IF v_ticket.status = 'redeemed' THEN
        -- Ya entró alguien: devolver el dinero es una decisión manual, no un
        -- clic de panel (el lugar se usó). Se rechaza con nombre claro.
        RAISE EXCEPTION 'cannot_refund_redeemed';
    END IF;

    -- El monto reembolsado no puede superar lo que costó la boleta ni ser
    -- negativo (mig 044). Sin este tope, el endpoint aceptaba el monto del
    -- cliente tal cual y la caja registraba una salida mayor que el recaudo.
    IF p_amount_in_cents IS NOT NULL THEN
        IF p_amount_in_cents < 0 THEN
            RAISE EXCEPTION 'refund_amount_negative';
        END IF;
        IF p_amount_in_cents > v_ticket.price_cents_snapshot THEN
            RAISE EXCEPTION 'refund_amount_exceeds_price';
        END IF;
    END IF;

    UPDATE tickets
       SET status = 'refunded', updated_at = now()
     WHERE id = p_ticket_id AND status = 'issued';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'cannot_refund_ticket';
    END IF;

    INSERT INTO ticket_refunds
        (ticket_id, event_id, amount_in_cents, reason, refunded_by_user_id)
    VALUES (
        p_ticket_id, v_ticket.event_id,
        COALESCE(p_amount_in_cents, v_ticket.price_cents_snapshot),
        p_reason, p_by_user_id
    );

    RETURN v_ticket.event_id;
END;
$$;

COMMIT;
