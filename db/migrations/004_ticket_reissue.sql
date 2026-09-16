-- =============================================================================
-- Migración 004: recuperación de boletas (reemisión / reenvío).
--
-- Problema: el token crudo del QR se devuelve UNA sola vez al emitir y en la DB
-- solo queda su SHA-256. Si el WhatsApp no salió, el invitado borró el chat o el
-- promotor cerró la pestaña, la boleta era irrecuperable: no había forma de
-- volver a mostrar ese QR.
--
-- Solución: NO se puede "recuperar" el token viejo (el hash es de una vía, y
-- guardar el crudo anularía la razón de ser del hash: si la DB se filtra, nadie
-- podría reusar boletas ajenas). Se ROTA: se emite un token nuevo para la misma
-- boleta y el anterior muere en el acto. Mismo cupo, mismo aforo, misma boleta;
-- solo cambia la credencial del QR.
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Auditoría de reemisiones: quién rotó qué token, cuándo y por qué.
--    Se guarda el hash viejo (no el crudo): sirve para soporte ("mi QR anterior
--    ya no sirve") sin debilitar el modelo de seguridad.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_reissues (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id          bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    reissued_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
    old_token_hash     text NOT NULL,
    new_token_hash     text NOT NULL,
    reason             text,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_reissues_ticket
    ON ticket_reissues (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- 2) reissue_ticket: rota el token de una boleta viva y devuelve su event_id.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reissue_ticket(
    p_ticket_id     bigint,
    p_new_raw_token text,
    p_by_user_id    bigint,
    p_reason        text DEFAULT NULL
)
RETURNS bigint   -- event_id de la boleta reemitida
LANGUAGE plpgsql
AS $$
DECLARE
    v_ticket     tickets%ROWTYPE;
    v_event_status text;
    v_new_hash   text;
BEGIN
    IF p_new_raw_token IS NULL OR length(p_new_raw_token) < 8 THEN
        RAISE EXCEPTION 'invalid_token_format';
    END IF;

    SELECT * INTO v_ticket FROM tickets WHERE id = p_ticket_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_not_found'; END IF;

    SELECT status INTO v_event_status FROM events WHERE id = v_ticket.event_id;
    IF v_event_status = 'ended' OR v_event_status = 'cancelled' THEN
        RAISE EXCEPTION 'event_closed';
    END IF;

    -- Una boleta ya usada no se reemite: la entrada ya ocurrió y un token nuevo
    -- sería una segunda entrada gratis.
    IF v_ticket.status = 'redeemed' THEN
        RAISE EXCEPTION 'cannot_reissue_redeemed';
    END IF;
    -- Anulada/reembolsada: dejaría de estar anulada si se le diera token vivo.
    IF v_ticket.status <> 'issued' THEN
        RAISE EXCEPTION 'cannot_reissue_ticket';
    END IF;

    v_new_hash := encode(digest(p_new_raw_token, 'sha256'), 'hex');

    -- Compare-and-swap: dos reemisiones concurrentes no pueden quedar ambas
    -- "vigentes"; la segunda falla y el llamador reintenta.
    UPDATE tickets
       SET token_hash = v_new_hash, updated_at = now()
     WHERE id = p_ticket_id AND status = 'issued';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'cannot_reissue_ticket';
    END IF;

    INSERT INTO ticket_reissues (
        ticket_id, reissued_by_user_id, old_token_hash, new_token_hash, reason
    ) VALUES (
        p_ticket_id, p_by_user_id, v_ticket.token_hash, v_new_hash, p_reason
    );

    RETURN v_ticket.event_id;
END;
$$;

COMMIT;
