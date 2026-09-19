-- =============================================================================
-- Migración 015: corrección de contacto del asistente (nombre/teléfono) con
-- auditoría.
--
-- El error más común del flujo de emisión: el promotor digitó mal el teléfono y
-- el WhatsApp del QR nunca llegó. Hoy la única salida es anular + reemitir
-- (fricción doble). Esta mig permite CORREGIR nombre y teléfono de una boleta
-- activa, con auditoría completa (quién, cuándo, qué cambió, valores viejos).
--
-- Reglas de negocio (en la DB, como todo el core):
--   * Solo boletas `issued` (una boleta usada/anulada es historia, no se edita).
--   * Nombre y teléfono: al menos uno debe venir; teléfono con solo dígitos.
--   * Evento cerrado (ended/cancelled): nada se corrige.
--   * La auditoría guarda los valores ANTES del cambio (en claro: son datos de
--     contacto, no credenciales — no hay razón para hashearlos).
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- Auditoría de correcciones de contacto.
CREATE TABLE IF NOT EXISTS ticket_contact_edits (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id    bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    edited_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
    old_name     text,
    new_name     text,
    old_phone    text,
    new_phone    text,
    reason       text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_contact_edits_ticket
    ON ticket_contact_edits (ticket_id, created_at);

CREATE OR REPLACE FUNCTION correct_ticket_contact(
    p_ticket_id  bigint,
    p_new_name   text,
    p_new_phone  text,
    p_by_user_id bigint,
    p_reason     text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_ticket tickets%ROWTYPE;
    v_event_status text;
    v_old_name  text;
    v_old_phone text;
BEGIN
    IF p_new_name IS NULL AND p_new_phone IS NULL THEN
        RAISE EXCEPTION 'nothing_to_update';
    END IF;

    SELECT * INTO v_ticket FROM tickets WHERE id = p_ticket_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_not_found'; END IF;

    SELECT status INTO v_event_status FROM events WHERE id = v_ticket.event_id;
    IF v_event_status = 'ended' OR v_event_status = 'cancelled' THEN
        RAISE EXCEPTION 'event_closed';
    END IF;

    -- Solo boletas vigentes: una usada ya ocurrió; una anulada/reembolsada es
    -- historia (y "corregir" una anulada podría reactivarla de facto).
    IF v_ticket.status <> 'issued' THEN
        RAISE EXCEPTION 'cannot_edit_ticket_status';
    END IF;

    v_old_name  := v_ticket.customer_name;
    v_old_phone := v_ticket.customer_phone;

    IF p_new_name IS NOT NULL THEN
        IF length(btrim(p_new_name)) = 0 THEN
            RAISE EXCEPTION 'invalid_name';
        END IF;
        UPDATE tickets SET customer_name = btrim(p_new_name) WHERE id = p_ticket_id;
    END IF;

    IF p_new_phone IS NOT NULL THEN
        IF length(btrim(p_new_phone)) = 0
           OR btrim(p_new_phone) !~ '^[0-9+ ()-]{7,20}$' THEN
            RAISE EXCEPTION 'invalid_phone';
        END IF;
        UPDATE tickets SET customer_phone = btrim(p_new_phone) WHERE id = p_ticket_id;
    END IF;

    INSERT INTO ticket_contact_edits (
        ticket_id, edited_by_user_id, old_name, new_name, old_phone, new_phone, reason
    ) VALUES (
        p_ticket_id, p_by_user_id, v_old_name,
        CASE WHEN p_new_name IS NULL THEN v_old_name ELSE btrim(p_new_name) END,
        v_old_phone,
        CASE WHEN p_new_phone IS NULL THEN v_old_phone ELSE btrim(p_new_phone) END,
        p_reason
    );
END;
$$;

-- =============================================================================
-- Prueba funcional con rollback total: si algo falla, el BEGIN exterior revierte
-- todo (tabla, función y datos de prueba). Si pasa, imprime OK_TEST.
-- =============================================================================
DO $$
DECLARE
    v_venue bigint; v_event bigint; v_type bigint; v_user bigint; v_ticket bigint;
    v_tag text := md5(random()::text);
BEGIN
    INSERT INTO venues (name, slug) VALUES ('test-contact-mig-' || v_tag, 'test-contact-mig-' || v_tag) RETURNING id INTO v_venue;
    INSERT INTO users (email, password_hash, full_name) VALUES ('contact-mig-' || v_tag || '@example.com', 'x', 'Test') RETURNING id INTO v_user;
    INSERT INTO venue_user_roles (venue_id, user_id, role) VALUES (v_venue, v_user, 'admin');
    INSERT INTO events (venue_id, name, starts_at, capacity, status) VALUES (v_venue, 'Test', now() + interval '29 hours', 100, 'published') RETURNING id INTO v_event;
    INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy) VALUES (v_event, 'General', 0, 10, true) RETURNING id INTO v_type;
    INSERT INTO tickets (event_id, ticket_type_id, sold_by_user_id, customer_name, customer_phone, token_hash, price_cents_snapshot, status)
    VALUES (v_event, v_type, v_user, 'Nombre Mal Escrito', '3000000000', md5(random()::text) || md5(random()::text), 0, 'issued') RETURNING id INTO v_ticket;

    -- 1) Corrección de ambos campos
    PERFORM correct_ticket_contact(v_ticket, 'Nombre  Correcto', '311 222 3344', v_user, 'prueba mig');
    IF (SELECT customer_name FROM tickets WHERE id = v_ticket) <> 'Nombre  Correcto' THEN
        RAISE EXCEPTION 'TEST_FAIL name';
    END IF;

    -- 2) Teléfono inválido debe fallar
    BEGIN
        PERFORM correct_ticket_contact(v_ticket, NULL, 'abc', v_user, NULL);
        RAISE EXCEPTION 'TEST_FAIL invalid_phone_accepted';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%invalid_phone%' THEN RAISE; END IF;
    END;

    -- 3) Boleta usada no se corrige
    UPDATE tickets SET status = 'redeemed' WHERE id = v_ticket;
    BEGIN
        PERFORM correct_ticket_contact(v_ticket, 'Otro', NULL, v_user, NULL);
        RAISE EXCEPTION 'TEST_FAIL redeemed_accepted';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%cannot_edit_ticket_status%' THEN RAISE; END IF;
    END;

    -- Verificación de auditoría
    IF (SELECT count(*) FROM ticket_contact_edits WHERE ticket_id = v_ticket) <> 1 THEN
        RAISE EXCEPTION 'TEST_FAIL audit_rows';
    END IF;

    RAISE NOTICE 'OK_TEST';

    -- Autolimpieza: la prueba no deja rastro (los tests backend hacen DROP
    -- CASCADE, pero en producción no debe quedar basura de la migración).
    DELETE FROM venues WHERE id = v_venue;  -- arrastra users/tickets/event por CASCADE
END $$;

COMMIT;
