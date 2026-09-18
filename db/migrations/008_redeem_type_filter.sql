-- Migración 008: filtro de tipo de boleta en la puerta (filas separadas).
--
-- Producto: el admin/portero quiere separar filas de ingreso (VIP, general,
-- cortesía). Hasta ahora eso dependía del ojo del portero; una boleta de
-- general podía colarse en la fila VIP porque el QR es válido para el evento.
--
-- Cambio: redeem_ticket acepta p_expected_ticket_type_id (NULL = sin filtro,
-- comportamiento anterior intacto). Con filtro, una boleta válida del evento
-- pero de OTRO tipo se rechaza con 'WRONG_TYPE' sin consumirla: puede entrar
-- por la fila correcta después. El intento queda auditado en redemptions con
-- outcome 'wrong_type'.
--
-- Orden de validaciones: puerta cerrada (EVENT_NOT_LIVE) manda sobre tipo
-- incorrecto — el mensaje accionable cuando la puerta no abrió es el estado
-- de la puerta, no la fila.

-- La firma anterior (3 args) queda como overload si alguien aplicó schema.sql
-- actualizado: se elimina para dejar una única versión canónica.
DROP FUNCTION IF EXISTS redeem_ticket(bigint, text, bigint);

CREATE OR REPLACE FUNCTION redeem_ticket(
    p_event_id      bigint,
    p_raw_token     text,
    p_scanned_by_user_id bigint,
    p_expected_ticket_type_id bigint DEFAULT NULL
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

    -- Guardia: el evento del escaneo debe existir (migración 006). Sin esto,
    -- el INSERT del log rompe la FK y el escáner recibe un 500 opaco.
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

    -- Filtro de fila: con tipo esperado, una boleta válida de otro tipo NO
    -- entra y NO se consume (podrá entrar por la fila correcta después).
    IF p_expected_ticket_type_id IS NOT NULL
       AND v_ticket.ticket_type_id <> p_expected_ticket_type_id THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'wrong_type');
        RETURN 'WRONG_TYPE';
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
