-- 013: activación del QR del invitado (patrón DICE / SafeTix adaptado).
--
-- Problema: hoy el QR del invitado vive desde que se emite la boleta, así
-- que el enlace `/t#<token>` se puede reenviar y el QR circula por WhatsApp
-- días antes del evento. En la puerta eso permite "yo le muestro el QR a
-- fulano" sin que fulano haya pagado nada: la boleta se comparte como un
-- billete de papel.
--
-- Estándar del rubio (investigación sep-2026):
--   * DICE: el QR solo existe dentro de la app, se "activa" 60 minutos
--     antes de la apertura y se desactiva al usarse.
--   * Ticketmaster SafeTix: el código rota cada 15s (anti screenshot).
--   * Eventbrite: guarda la imagen "para la puerta sin internet" (su
--     anti-fraude es el nombre impreso + documento).
--
-- TicketFlow es web y stateless: el QR codifica el token crudo, que es la
-- credencial. No podemos impedir la captura de pantalla, pero SÍ el
-- reenvío anticipado: el QR se dibuja SOLO dentro de la ventana de
-- activación del evento (default: 60 minutos antes de la apertura, el
-- estándar de DICE). Fuera de la ventana, la página del invitado explica
-- cuándo se activa y cuándo empieza el evento: el enlace sigue sirviendo
-- (quien lo recibió no queda fuera), pero no muestra el código.
--
-- El bouncer NO cambia: `redeem_ticket` valida contra la DB (token_hash,
-- estado del evento y de la boleta), no contra lo que se muestra en la
-- pantalla del invitado. Un QR viejo nunca abrió una puerta aquí.

BEGIN;

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS qr_unlock_minutes integer NOT NULL DEFAULT 60
    CHECK (qr_unlock_minutes >= 0);

-- El instante exacto de activación se calcula en SQL en cada consulta
-- (starts_at - qr_unlock_minutes * interval '1 minute'): derivado, nunca
-- almacenado, así mover el horario del evento mueve la activación con él.
-- qr_unlock_minutes = 0 significa "se activa con la apertura".

-- ---------------------------------------------------------------------------
-- redeem_ticket (mig 008 + puerta de activación):
-- Un QR se puede REGENERAR desde el token (el fragmento # nunca viaja al
-- servidor, pero quien tiene el enlace tiene el token y puede dibujar su
-- propio QR). El bloqueo solo en la pantalla no defiende nada: la puerta
-- de verdad está ACÁ. Antes de la ventana, el escaneo se rechaza con
-- 'NOT_ACTIVE' sin consumir la boleta y queda auditado (outcome not_active).
-- Orden: después del estado del evento ("puerta cerrada" manda) y antes
-- del filtro de fila.
-- ---------------------------------------------------------------------------
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
    v_event_starts_at timestamptz;
    v_event_unlock integer;
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

    SELECT status, starts_at, qr_unlock_minutes
      INTO v_event_status, v_event_starts_at, v_event_unlock
      FROM events WHERE id = p_event_id;
    IF v_event_status <> 'live' AND v_event_status <> 'published' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'event_not_live');
        RETURN 'EVENT_NOT_LIVE';
    END IF;

    -- Ventana de activación (mig 013): el QR "existe" desde
    -- starts_at - unlock minutos. Antes, rechazo sin consumir.
    IF v_event_starts_at - (v_event_unlock * INTERVAL '1 minute') > now() THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'not_active');
        RETURN 'NOT_ACTIVE';
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

COMMIT;
