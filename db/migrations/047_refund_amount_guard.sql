-- =============================================================================
-- 047 — Reembolso acotado: el monto no puede superar lo pagado ni ser negativo.
-- =============================================================================
-- Hallazgo (auditoría): `refund_ticket` aceptaba el `amount_in_cents` que venía
-- del cliente sin ningún tope y el esquema lo registraba tal cual. Un admin (o
-- un bug de la UI) podía dejar en caja una salida MAYOR que el recaudo real,
-- hasta devolver una boleta de cortesía por un monto inventado.
--
-- La guarda vive en la DB, no en el endpoint: es el punto donde el reembolso se
-- consume de verdad y no se puede esquivar desde otro camino.
--
-- Nota de alcance: el tope de usos del cupón que traía el fix original quedó
-- cubierto de forma más fuerte por el modelo de RESERVAS de checkout (mig
-- 044_checkout_reservations): el cupo se aparta al crear el pago y
-- `approve_ticket_payment` lo revalida con `FOR UPDATE` antes de incrementar
-- `used_count`. Por eso aquí solo viaja la guarda de reembolso.
--
-- Idempotente: CREATE OR REPLACE (safe re-run).
-- =============================================================================


BEGIN;

-- ---------------------------------------------------------------------------
-- REEMBOLSO: el monto no puede superar lo pagado ni ser negativo.
-- ---------------------------------------------------------------------------
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
    -- negativo (mig 047). Sin este tope, el endpoint aceptaba el monto del
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
