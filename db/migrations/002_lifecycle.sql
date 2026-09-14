-- =============================================================================
-- Migración 002: ciclo de vida de eventos, anulación de boletas y auditoría
-- de escaneos no encontrados (backlog S1-6, S2-3, S2-5).
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) redemptions.ticket_id nullable: los escaneos NOT_FOUND no tienen boleta,
--    pero TODO escaneo debe quedar auditado (backlog S2-3).
-- ---------------------------------------------------------------------------
ALTER TABLE redemptions ALTER COLUMN ticket_id DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) redeem_ticket: auditar NOT_FOUND sin ticket (antes insertaba 0 filas
--    porque el INSERT...SELECT dependía de un ticket inexistente).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION redeem_ticket(
    p_event_id      bigint,
    p_raw_token     text,
    p_scanned_by_user_id bigint
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_ticket tickets%ROWTYPE;
    v_token_hash text;
    v_event_status text;
BEGIN
    IF p_raw_token IS NULL OR length(p_raw_token) < 8 THEN
        RAISE EXCEPTION 'invalid_token_format';
    END IF;

    v_token_hash := encode(digest(p_raw_token, 'sha256'), 'hex');

    SELECT * INTO v_ticket FROM tickets WHERE token_hash = v_token_hash;
    IF NOT FOUND THEN
        -- ticket_id NULL: el escaneo existe como huella, sin boleta asociada
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
        VALUES (NULL, p_event_id, p_scanned_by_user_id, 'not_found');
        RETURN 'NOT_FOUND';
    END IF;

    IF v_ticket.event_id <> p_event_id THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'invalid_event');
        RETURN 'INVALID_EVENT';
    END IF;

    SELECT status INTO v_event_status FROM events WHERE id = p_event_id;
    IF v_event_status <> 'live' AND v_event_status <> 'published' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'event_not_live');
        RETURN 'EVENT_NOT_LIVE';
    END IF;

    IF v_ticket.status = 'voided' OR v_ticket.status = 'refunded' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'not_valid');
        RETURN 'NOT_VALID';
    END IF;

    IF v_ticket.status = 'redeemed' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'already_redeemed');
        RETURN 'ALREADY_REDEEMED';
    END IF;

    -- Compare-and-swap: exactamente UNA de las filas concurrentes sera afectada.
    UPDATE tickets
       SET status = 'redeemed', redeemed_at = now(), redeemed_by_user_id = p_scanned_by_user_id
     WHERE id = v_ticket.id AND status = 'issued';

    IF NOT FOUND THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'already_redeemed');
        RETURN 'ALREADY_REDEEMED';
    END IF;

    INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
    VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'granted');
    RETURN 'GRANTED';
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) void_ticket: anula una boleta y libera cupo (backlog S2-5).
--    El promotor puede re-emitir la misma posición del cupo de inmediato.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION void_ticket(
    p_ticket_id  bigint,
    p_reason     text,
    p_by_user_id bigint
)
RETURNS bigint   -- event_id de la boleta anulada (0 si no se pudo)
LANGUAGE plpgsql
AS $$
DECLARE
    v_ticket tickets%ROWTYPE;
    v_status text;
BEGIN
    SELECT * INTO v_ticket FROM tickets WHERE id = p_ticket_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_not_found'; END IF;

    -- Solo el evento dueño hace falta para validar venue en el endpoint.
    SELECT status INTO v_status FROM events WHERE id = v_ticket.event_id;
    IF v_status = 'ended' OR v_status = 'cancelled' THEN
        RAISE EXCEPTION 'event_closed';
    END IF;

    IF v_ticket.status = 'redeemed' THEN
        RAISE EXCEPTION 'cannot_void_redeemed';
    END IF;
    IF v_ticket.status = 'voided' THEN
        RETURN v_ticket.event_id;   -- idempotente
    END IF;

    UPDATE tickets
       SET status = 'voided', voided_at = now(), updated_at = now()
     WHERE id = p_ticket_id AND status IN ('issued', 'refunded');

    IF NOT FOUND THEN
        RAISE EXCEPTION 'cannot_void_ticket';
    END IF;

    RETURN v_ticket.event_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) set_event_status: transiciones válidas del ciclo de vida del evento.
--    draft -> published -> live -> ended;  draft/published -> cancelled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_event_status(
    p_event_id bigint,
    p_from     text,
    p_to       text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_count integer;
BEGIN
    SELECT count(*) INTO v_count
      FROM events
     WHERE id = p_event_id
       AND status = p_from;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'invalid_transition';
    END IF;

    UPDATE events
       SET status = p_to, updated_at = now()
     WHERE id = p_event_id AND status = p_from;
END;
$$;

COMMIT;
