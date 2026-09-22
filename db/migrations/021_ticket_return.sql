-- 021: devolución de boletas — "No puedo ir" (E1 del ciclo DICE).
--
-- Problema: la boleta que ya no se usará muere en el teléfono de alguien.
-- El bar pierde aforo real y el promotor pierde la cara; reenviar el QR por
-- WhatsApp pone a un desconocido en la lista sin trazabilidad de quién
-- terminó usando la boleta.
--
-- Modelo DICE: el invitado devuelve la boleta a la plataforma desde su
-- enlace /t#<token> (sin cuentas para el público: el token ES la
-- credencial). La devolución:
--   * mata el QR en el acto (la boleta pasa a 'voided': la puerta responde
--     NOT_VALID y la imagen pública cae al 410, patrón de anuladas),
--   * LIBERA el cupo del promotor si lo usó y devuelve el lugar al aforo
--     (todos los conteos ya excluyen 'voided': liberación gratis y sin
--     tocar una sola consulta),
--   * queda auditada (quién devolvió, cuándo y con qué credencial).
--
-- Decisión de diseño: NO se agrega un estado nuevo al enum ticket_status y
-- NO se rota el token. El octavo estado exigiría tocar cada conteo del
-- sistema y cualquiera olvidado es una fuga de aforo. Mantener el token
-- permite que el enlace siga explicando (página "devuelta", sin QR) en vez
-- de mentir con un 404; el QR no se puede regenerar por ningún canal porque
-- /tickets/image devuelve 410 para boletas no vigentes. La fila en
-- ticket_returns es la marca que distingue una DEVOLUCIÓN de la anulación
-- de staff, y de ella salen los reportes de "boletas devueltas".
--
-- Ventana límite (E1-2): nunca después del unlock del QR. Una vez activado
-- el QR (starts_at - qr_unlock_minutes), la devolución ya es problema de
-- puerta: cobija lista. Devolver fuera de ventana rechaza con
-- 'return_window_closed' y la UI lo dice claro. El staff que necesita
-- liberar un cupo fuera de ventana usa la anulación (void), que es su
-- herramienta de siempre: la devolución es el flujo del INVITADO.
--
-- Dos llamadas, una función:
--   * Invitado (público): return_ticket(id, hash_esperado, NULL). El hash
--     esperado cierra la carrera con reissue: si el promotor reenvió la
--     boleta mientras el invitado tenía la página abierta, el token viejo ya
--     no coincide y la devolución muere (el nuevo dueño manda).
--   * Staff (dueño de la boleta o admin): return_ticket(id, NULL, user_id).
--
-- Idempotencia: devolver una boleta ya devuelta NO es error (el botón puede
-- duplicarse por una red lenta): si ya está anulada CON auditoría de
-- devolución, devuelve su event_id igual. Una anulada SIN auditoría es una
-- anulación de staff: 'cannot_return_ticket'.
--
-- Convenio de firma: el hash esperado va antes que el actor para que el
-- invitado llame con (id, hash) y el staff con (id, NULL, user_id).
--
-- NOTA: el cuerpo de la función debe ser byte-idéntico al de db/schema.sql
-- (el guardián test_schema_drift compara pg_dumps y el texto de prosrc
-- incluye los comentarios internos del bloque $$...$$).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Auditoría de devoluciones: la boleta, el evento y el token con el que
--    se devolvió (su hash: el crudo jamás se guarda). NULL en
--    returned_by_user_id significa "el invitado desde su enlace"; si un
--    staff lo hace, queda su id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_returns (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id           bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    event_id            bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    returned_token_hash text NOT NULL,
    returned_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ticket_id, returned_token_hash)
);

CREATE INDEX IF NOT EXISTS idx_ticket_returns_event
    ON ticket_returns (event_id, created_at);

-- ---------------------------------------------------------------------------
-- 1b) El kind 'ticket_returned' entra al catalogo cerrado de notificaciones
--     (mig 012 puso un CHECK de kinds validos: sin esto, la devolucion muere
--     al notificar y revienta TODA la transaccion).
-- ---------------------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind = ANY (ARRAY['payout_created'::text, 'payout_reviewed'::text,
                             'payout_disputed'::text, 'invitation_accepted'::text,
                             'ticket_reissued'::text, 'ticket_returned'::text]));

-- ---------------------------------------------------------------------------
-- 2) return_ticket: anula la boleta (mata el QR y libera cupo/aforo),
--    audita y avisa al vendedor. Devuelve el event_id.
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

    RETURN v_ticket.event_id;
END;
$$;

COMMIT;
