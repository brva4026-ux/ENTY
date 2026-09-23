-- 022: lista de espera del evento (E2 del ciclo DICE).
--
-- Problema: el evento agotado no captura demanda. La gente pregunta por
-- WhatsApp y la respuesta es manual ("avisame si se libera algo"), y cuando
-- alguien DEVUELVE una boleta (mig 021) el lugar se libera... para nadie en
-- particular: se pierde o se lo queda el que grita mas fuerte.
--
-- Modelo DICE: fila por evento en orden de llegada; al liberarse un lugar
-- (devolucion E1), la plataforma lo ofrece al PRIMERO con una ventana corta
-- (default 10 min); si no reclama, pasa al siguiente. Nunca hay reventa: el
-- anti-scalping es el producto.
--
-- Decisiones de diseno:
--   * Sin cuentas para el publico (igual que la boleta): el telefono es la
--     identidad (UNIQUE por evento) y el JOIN entrega un token crudo de una
--     sola vez; en la DB solo queda su SHA-256. Ese token es LA credencial
--     para consultar estado, reclamar y salir.
--   * La posicion NO se almacena: se deriva del orden de llegada (created_at)
--     contando solo los que siguen en fila. Almacenarla invita a drift
--     (renumerar en cada salida/expire es donde se rompe todo).
--   * El reclamo EMITE una boleta NUEVA contra el lugar liberado (nunca se
--     re-activa el token devuelto): el invitado nuevo entra con su propio QR
--     y su propia ventana de activacion (mig 013).
--   * La expiracion es PEREZOSA (expire_waitlist_offers), igual que el
--     cierre de eventos (mig 020): la llaman los endpoints de la lista.
--     Serverless no tiene cron; el polling de los propios interesados es el
--     watchdog natural.
--
-- Puerta de entrada (gate DICE): la lista solo acepta gente cuando el evento
-- esta AGOTADO (boletas activas >= min(suma de tipos, aforo)). Con lugar
-- libre el publico compra directo, no hace fila.
--
-- El lugar liberado viaja con la oferta: (tipo, cupo) de la boleta devuelta
-- quedan congelados en la fila de la persona ofrecida. Si al reclamar el
-- cupo ya no tiene lugar (alguien emitio mientras tanto), el reclamo expira
-- la oferta e intenta re-ofrecer el mismo lugar al siguiente.
--
-- NOTA: los cuerpos de las funciones deben ser byte-identicos a los de
-- db/schema.sql (el guardian test_schema_drift compara pg_dumps y el texto
-- de prosrc incluye los comentarios internos de cada bloque $$...$$).
-- Esta migracion tambien REEMPLAZA return_ticket (mig 021) para enganchar
-- la oferta al final de la devolucion.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Ventana de oferta por evento: cuantos minutos tiene el primero de la
--    fila para reclamar el lugar. 10 min es el estandar de DICE.
-- ---------------------------------------------------------------------------
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS waitlist_offer_minutes integer NOT NULL DEFAULT 10
    CHECK (waitlist_offer_minutes >= 1);

-- ---------------------------------------------------------------------------
-- 2) La fila. Estados: waiting -> offered -> claimed | expired; waiting ->
--    left (el propio fan se va). El token crudo jamas se guarda.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_waitlist (
    id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id               bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name                   text NOT NULL,
    phone                  text NOT NULL,
    token_hash             text NOT NULL UNIQUE,
    status                 text NOT NULL DEFAULT 'waiting',
    offered_at             timestamptz,
    offered_ticket_type_id bigint REFERENCES ticket_types(id) ON DELETE SET NULL,
    offered_allocation_id  bigint REFERENCES promoter_allocations(id) ON DELETE SET NULL,
    claimed_ticket_id      bigint REFERENCES tickets(id) ON DELETE SET NULL,
    claimed_at             timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, phone),
    CONSTRAINT event_waitlist_status_check CHECK (status IN
        ('waiting', 'offered', 'claimed', 'expired', 'left'))
);

CREATE INDEX IF NOT EXISTS idx_event_waitlist_queue
    ON event_waitlist (event_id, status, created_at);

-- ---------------------------------------------------------------------------
-- 3) El kind 'waitlist_offered' entra al catalogo cerrado de notificaciones
--    (mig 012/021): los admins se enteran de que el lugar circula de nuevo.
-- ---------------------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind = ANY (ARRAY['payout_created'::text, 'payout_reviewed'::text,
                             'payout_disputed'::text, 'invitation_accepted'::text,
                             'ticket_reissued'::text, 'ticket_returned'::text,
                             'waitlist_offered'::text]));

-- ---------------------------------------------------------------------------
-- 4) offer_next_waitlist_spot: ofrece el lugar al PRIMERO de la fila.
--    SKIP LOCKED: dos liberaciones concurrentes no ofrecen a la misma
--    persona. Devuelve 1 si ofrecio, 0 si no habia fila.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION offer_next_waitlist_spot(
    p_event_id         bigint,
    p_ticket_type_id   bigint,
    p_allocation_id    bigint
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_offered bigint;
    v_venue   bigint;
BEGIN
    UPDATE event_waitlist
       SET status = 'offered',
           offered_at = now(),
           offered_ticket_type_id = p_ticket_type_id,
           offered_allocation_id = p_allocation_id
     WHERE id = (
        SELECT id FROM event_waitlist
         WHERE event_id = p_event_id AND status = 'waiting'
         ORDER BY created_at, id
         LIMIT 1 FOR UPDATE SKIP LOCKED
     )
    RETURNING id INTO v_offered;

    IF v_offered IS NULL THEN
        RETURN 0;
    END IF;

    -- Avisar a los admins: el lugar libero circula de nuevo. El fan no tiene
    -- cuenta (sin push posible): su canal es su pagina de estado, que hace
    -- polling y muestra la ventana de reclamo.
    SELECT venue_id INTO v_venue FROM events WHERE id = p_event_id;
    PERFORM notify_venue_admins(v_venue, 'waitlist_offered',
        'Lugar ofrecido a la lista',
        'Se libero un lugar y se ofrecio al primero de la fila.',
        '/admin');
    RETURN 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) expire_waitlist_offers: expira las ofertas vencidas y hereda el lugar
--    al siguiente (misma oferta, nueva persona). Idempotente y re-ejecutable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION expire_waitlist_offers()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_expired integer := 0;
    v_row     record;
BEGIN
    FOR v_row IN
        SELECT w.id, w.event_id, w.offered_ticket_type_id, w.offered_allocation_id
          FROM event_waitlist w
          JOIN events e ON e.id = w.event_id
         WHERE w.status = 'offered'
           AND w.offered_at + (e.waitlist_offer_minutes * INTERVAL '1 minute') < now()
         FOR UPDATE OF w SKIP LOCKED
    LOOP
        UPDATE event_waitlist SET status = 'expired' WHERE id = v_row.id;
        PERFORM offer_next_waitlist_spot(
            v_row.event_id, v_row.offered_ticket_type_id, v_row.offered_allocation_id
        );
        v_expired := v_expired + 1;
    END LOOP;
    RETURN v_expired;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6) join_waitlist: el fan entra a la fila. Idempotente por telefono (la
--    identidad del publico sin cuentas): re-entrar actualiza el nombre y
--    devuelve la posicion actual, sin duplicar.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION join_waitlist(
    p_event_id  bigint,
    p_name      text,
    p_phone     text,
    p_raw_token text
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_event    events%ROWTYPE;
    v_active   bigint;
    v_total    bigint;
    v_existing event_waitlist%ROWTYPE;
BEGIN
    IF p_raw_token IS NULL OR length(p_raw_token) < 8 THEN
        RAISE EXCEPTION 'invalid_token_format';
    END IF;
    IF p_name IS NULL OR btrim(p_name) = '' THEN
        RAISE EXCEPTION 'invalid_name';
    END IF;
    IF p_phone IS NULL OR btrim(p_phone) = '' THEN
        RAISE EXCEPTION 'invalid_phone';
    END IF;

    SELECT * INTO v_event FROM events WHERE id = p_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'event_not_found';
    END IF;
    IF v_event.status NOT IN ('published', 'live') THEN
        RAISE EXCEPTION 'event_not_open';
    END IF;

    -- Gate DICE: la lista existe cuando NO hay boletas. Con lugar libre el
    -- publico compra directo, no hace fila.
    SELECT count(*) INTO v_active FROM tickets
     WHERE event_id = p_event_id AND status NOT IN ('voided', 'refunded');
    SELECT COALESCE(SUM(quantity), 0) INTO v_total FROM ticket_types WHERE event_id = p_event_id;
    IF v_active < LEAST(v_total, v_event.capacity::bigint) THEN
        RAISE EXCEPTION 'waitlist_not_needed';
    END IF;

    SELECT * INTO v_existing FROM event_waitlist
     WHERE event_id = p_event_id AND phone = btrim(p_phone);
    IF FOUND THEN
        UPDATE event_waitlist SET name = btrim(p_name) WHERE id = v_existing.id;
        RETURN (SELECT count(*) FROM event_waitlist w
                 WHERE w.event_id = p_event_id AND w.status = 'waiting'
                   AND (w.created_at, w.id) < (v_existing.created_at, v_existing.id)) + 1;
    END IF;

    INSERT INTO event_waitlist (event_id, name, phone, token_hash)
    VALUES (p_event_id, btrim(p_name), btrim(p_phone),
            encode(digest(p_raw_token, 'sha256'), 'hex'));

    -- Ultimo en llegar: mi posicion es el total de la fila viva.
    RETURN (SELECT count(*) FROM event_waitlist w
             WHERE w.event_id = p_event_id AND w.status = 'waiting');
END;
$$;

-- ---------------------------------------------------------------------------
-- 7) leave_waitlist: el fan se va por su propia voluntad (su token es la
--    credencial). Si estaba OFERTEADO, su turno se hereda al siguiente con
--    el mismo lugar.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION leave_waitlist(p_expected_token_hash text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_row event_waitlist%ROWTYPE;
BEGIN
    SELECT * INTO v_row FROM event_waitlist
     WHERE token_hash = p_expected_token_hash
     FOR UPDATE;
    IF NOT FOUND OR v_row.status NOT IN ('waiting', 'offered') THEN
        RAISE EXCEPTION 'waitlist_entry_not_found';
    END IF;

    UPDATE event_waitlist SET status = 'left' WHERE id = v_row.id;

    IF v_row.status = 'offered' THEN
        PERFORM offer_next_waitlist_spot(
            v_row.event_id, v_row.offered_ticket_type_id, v_row.offered_allocation_id
        );
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8) claim_waitlist: reclamar = EMITIR una boleta nueva contra el lugar
--    liberado. La credencial es el token del fan; la boleta nueva nace con
--    su propio token crudo (lo genera el endpoint, llega una sola vez).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_waitlist(
    p_claim_token_hash text,
    p_new_raw_token    text
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    v_row       event_waitlist%ROWTYPE;
    v_event     events%ROWTYPE;
    v_alloc_ok  boolean := false;
    v_ticket_id bigint;
    v_gone      boolean := false;
BEGIN
    IF p_new_raw_token IS NULL OR length(p_new_raw_token) < 8 THEN
        RAISE EXCEPTION 'invalid_token_format';
    END IF;

    SELECT * INTO v_row FROM event_waitlist
     WHERE token_hash = p_claim_token_hash
     FOR UPDATE;
    IF NOT FOUND OR v_row.status <> 'offered' THEN
        RAISE EXCEPTION 'waitlist_offer_expired';
    END IF;

    SELECT * INTO v_event FROM events WHERE id = v_row.event_id;
    IF v_event.status NOT IN ('published', 'live') THEN
        RAISE EXCEPTION 'event_not_open_for_sales';
    END IF;

    -- Ventana: si la oferta ya vencio, expirarla y ofrecer al siguiente.
    IF v_row.offered_at IS NULL
       OR v_row.offered_at + (v_event.waitlist_offer_minutes * INTERVAL '1 minute') < now() THEN
        UPDATE event_waitlist SET status = 'expired' WHERE id = v_row.id;
        PERFORM offer_next_waitlist_spot(
            v_row.event_id, v_row.offered_ticket_type_id, v_row.offered_allocation_id
        );
        RAISE EXCEPTION 'waitlist_offer_expired';
    END IF;

    IF v_row.offered_ticket_type_id IS NULL THEN
        v_gone := true;
    ELSE
        IF v_row.offered_allocation_id IS NOT NULL THEN
            SELECT is_active INTO v_alloc_ok
              FROM promoter_allocations WHERE id = v_row.offered_allocation_id;
        END IF;

        -- Emitir la boleta NUEVA. Primero contra el cupo liberado; si el
        -- cupo ya no existe o no tiene lugar (alguien emitio mientras
        -- tanto), venta directa del mismo tipo; si tampoco hay, el lugar
        -- se fue: expira y se re-ofrece al siguiente.
        BEGIN
            IF v_alloc_ok THEN
                v_ticket_id := emit_ticket(v_row.event_id, v_row.offered_ticket_type_id,
                                           v_row.offered_allocation_id, NULL,
                                           v_row.name, p_new_raw_token,
                                           v_row.phone, NULL);
            ELSE
                v_ticket_id := emit_ticket(v_row.event_id, v_row.offered_ticket_type_id,
                                           NULL, NULL,
                                           v_row.name, p_new_raw_token,
                                           v_row.phone, NULL);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%quota%' OR SQLERRM LIKE '%sold_out%'
               OR SQLERRM LIKE '%capacity%' OR SQLERRM LIKE '%inactive%' THEN
                v_gone := true;
            ELSE
                RAISE;
            END IF;
        END;
    END IF;

    IF v_gone THEN
        UPDATE event_waitlist SET status = 'expired' WHERE id = v_row.id;
        PERFORM offer_next_waitlist_spot(
            v_row.event_id, v_row.offered_ticket_type_id, v_row.offered_allocation_id
        );
        RAISE EXCEPTION 'waitlist_spot_gone';
    END IF;

    UPDATE event_waitlist
       SET status = 'claimed',
           claimed_ticket_id = v_ticket_id,
           claimed_at = now()
     WHERE id = v_row.id;

    RETURN v_ticket_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9) return_ticket (mig 021 + enganche E2): al devolverse una boleta, el
--    lugar libre se ofrece al primero de la fila. Cuerpo identico al de 021
--    mas el PERFORM final.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION return_ticket(
    p_ticket_id           bigint,
    p_expected_token_hash text DEFAULT NULL,
    p_by_user_id          bigint DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    v_ticket      tickets%ROWTYPE;
    v_event       events%ROWTYPE;
    v_return_hash text;
BEGIN
    SELECT * INTO v_ticket FROM tickets WHERE id = p_ticket_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ticket_not_found';
    END IF;

    -- Carrera con reissue: el invitado actua con el token de SU enlace; si
    -- la boleta ya roto token (reenvio), su credencial esta muerta y no
    -- puede matar la boleta nueva. El staff pasa NULL: manda su rol.
    IF p_expected_token_hash IS NOT NULL
       AND v_ticket.token_hash <> p_expected_token_hash THEN
        RAISE EXCEPTION 'token_stale';
    END IF;

    SELECT * INTO v_event FROM events WHERE id = v_ticket.event_id;
    IF v_event.status IN ('ended', 'cancelled') THEN
        RAISE EXCEPTION 'event_closed';
    END IF;

    IF v_ticket.status = 'voided' THEN
        -- Ya anulada: si fue DEVUELTA (hay auditoria) es idempotente; si fue
        -- anulada por staff, no hay nada que devolver y se lo decimos.
        IF EXISTS (SELECT 1 FROM ticket_returns WHERE ticket_id = v_ticket.id) THEN
            RETURN v_ticket.event_id;
        END IF;
        RAISE EXCEPTION 'cannot_return_ticket';
    END IF;

    -- Solo una boleta vigente se devuelve: una usada ya entro (el lugar se
    -- lo quedo alguien) y una reembolsada ya no cuenta en aforo.
    IF v_ticket.status <> 'issued' THEN
        RAISE EXCEPTION 'cannot_return_ticket';
    END IF;

    -- Ventana limite (E1-2): devolver es para ANTES de que el QR se active.
    -- Ventana CERRADA (unlock <= now) => rechazo: a esa altura el cupo ya es
    -- compromiso de puerta (cobija lista).
    IF (v_event.starts_at - (v_event.qr_unlock_minutes * INTERVAL '1 minute')) <= now() THEN
        RAISE EXCEPTION 'return_window_closed';
    END IF;

    -- Compare-and-swap: dos devoluciones concurrentes no pueden ambas
    -- anular; la segunda no encuentra la fila 'issued' y muere.
    UPDATE tickets
       SET status = 'voided',
           voided_at = now(),
           updated_at = now()
     WHERE id = v_ticket.id AND status = 'issued';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'cannot_return_ticket';
    END IF;

    -- Auditar con la credencial que hizo la devolucion: el hash del token
    -- vigente (invitado) o la marca de quien actuo (staff).
    v_return_hash := coalesce(
        p_expected_token_hash,
        'staff::' || coalesce(p_by_user_id::text, 'system')
    );
    INSERT INTO ticket_returns (ticket_id, event_id, returned_token_hash, returned_by_user_id)
    VALUES (v_ticket.id, v_ticket.event_id, v_return_hash, p_by_user_id)
    ON CONFLICT (ticket_id, returned_token_hash) DO NOTHING;

    -- Avisar al promotor/admin que la emitio: su cupo se libero y puede
    -- reasignarlo. Sin notificacion el promotor se entera cuando el invitado
    -- le escribe, y la cara del promotor es el producto.
    IF v_ticket.sold_by_user_id IS NOT NULL THEN
        PERFORM notify_user(
            v_ticket.sold_by_user_id, v_event.venue_id, 'ticket_returned',
            'Boleta devuelta',
            coalesce(v_ticket.customer_name, 'Un invitado') ||
            ' devolvio su boleta. Tu cupo se libero: puedes usarlo con alguien mas.',
            '/panel'
        );
    END IF;

    -- Lista de espera (E2): el lugar libre se ofrece al primero de la fila,
    -- con el tipo y el cupo de la boleta devuelta como el lugar heredable.
    PERFORM offer_next_waitlist_spot(
        v_event.id, v_ticket.ticket_type_id, v_ticket.allocation_id
    );

    RETURN v_ticket.event_id;
END;
$$;

COMMIT;
