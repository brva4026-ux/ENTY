-- Migración 006: blindar redeem_ticket contra eventos inexistentes.
--
-- Bug de producción: si el portero tiene seleccionado un evento que fue
-- eliminado (o el id no existe), cada escaneo intentaba insertar el log de
-- redención con ese event_id y violaba la FK redemptions_event_id_fkey
-- (HTTP 500). La función ahora valida la existencia del evento antes de
-- cualquier inserción y lanza 'event_not_found', que la API traduce a 404.

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

    -- Guardia: el evento del escaneo debe existir. Sin esto, el INSERT del
    -- log en redemptions rompe la FK y el escáner recibe un 500 opaco.
    IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_event_id) THEN
        RAISE EXCEPTION 'event_not_found';
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
