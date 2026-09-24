-- 023: pagos online con Wompi (E3, Etapa 2 del backlog).
--
-- Problema: las boletas de pago (General/VIP) se cobran "en puerta o
-- transferencia" (docs/flujos-usuario.md). El bar pierde ventas porque el
-- fan no siempre lleva efectivo y la transferencia manual no deja rastro
-- verificable: alguien manda el comprobante por WhatsApp y el bar cruza los
-- dedos (o emite de buena fe y a veces el comprobante es truchado).
--
-- Modelo elegido (docs/pagos-online.md): el bar cobra desde el dashboard.
-- La app crea un LINK DE PAGO de Wompi (monto fijo, single_use, con
-- expiracion), lo manda al invitado por WhatsApp y cuando Wompi aprueba la
-- transaccion, su webhook dispara la emision de la boleta. El dinero entra
-- primero, el QR despues.
--
-- Decisiones de diseno:
--   * Idempotencia por UNIQUE + estado en la DB: Wompi reintenta el webhook
--     (30 min / 3 h / 24 h). El segundo approve() ve status approved y
--     RETURN sin tocar nada: cero boletas dobles.
--   * reference NUESTRA ("TF-<evento>-<aleatorio>"): viaja a Wompi y vuelve
--     en el webhook; es la llave de todo el ciclo. No se buscan cobros por
--     ids ajenos.
--   * transaction_id con indice UNIQUE parcial: defensa en profundidad
--     contra replays de una transaccion bajo otra referencia.
--   * El monto se VALIDA contra esta tabla (payment_amount_mismatch): la
--     fuente de verdad del precio es la DB, nunca el payload.
--   * La emision va por emit_ticket (venta directa, cupo NULL): la boleta
--     nace con el mismo ciclo de vida que cualquier otra (QR con ventana
--     de mig 013, devolucion E1, reissue mig 004).
--   * El token crudo entra por parametro (lo genera el router, igual que
--     en emision manual) y se entrega UNA vez al admin via REISSUE del
--     dashboard: el webhook responde a Wompi, no hay nadie a quien
--     devolverselo en linea, y guardarlo en una notificacion dejaria la
--     credencial viva en la DB (aqui solo vive su SHA-256).
--   * kind 'payment_approved' suma al catalogo cerrado de notifications
--     (mig 012): sin extenderlo, el approve revienta al notificar, misma
--     trampa que E1.
--   * raw_payload jsonb: auditoria del webhook tal cual llego.

BEGIN;

CREATE TABLE IF NOT EXISTS ticket_payments (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id           bigint NOT NULL REFERENCES venues(id),
    event_id           bigint NOT NULL REFERENCES events(id),
    ticket_type_id     bigint NOT NULL REFERENCES ticket_types(id),
    -- Referencia de la APP: "TF-<event_id>-<aleatorio>". Viaja a Wompi y
    -- vuelve en el webhook; es la llave del ciclo completo.
    reference          text NOT NULL UNIQUE,
    -- Pasarela: 'wompi' hoy; el CHECK crece cuando sumemos otra (MP).
    provider           text NOT NULL DEFAULT 'wompi' CHECK (provider IN ('wompi')),
    provider_ref       text,          -- payment_link_id de Wompi
    transaction_id     text,          -- id de transaccion Wompi (si llego)
    status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','declined','voided','expired')),
    amount_in_cents    bigint NOT NULL CHECK (amount_in_cents > 0),
    customer_name      text NOT NULL,
    customer_phone     text NOT NULL,
    customer_email     text,
    created_by_user_id bigint REFERENCES users(id),
    approved_at        timestamptz,
    -- Boleta emitida al aprobarse el pago (UNIQUE: un cobro emite a lo
    -- sumo una; el valor NULL hasta que el webhook lo haga).
    ticket_id          bigint UNIQUE REFERENCES tickets(id),
    -- Webhook crudo (auditoria): que dijo Wompi exactamente y cuando.
    raw_payload        jsonb,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_payments_event
    ON ticket_payments(event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_payments_tx
    ON ticket_payments(provider, transaction_id)
    WHERE transaction_id IS NOT NULL;
-- La ligazon webhook -> cobro es por payment_link_id (los links de Wompi
-- NO soportan reference por transaccion): cada cobro tiene su link, id
-- unico de Wompi. UNIQUE parcial: un provider_ref ajeno o duplicado no
-- puede atribuirse a dos cobros.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_payments_provider_ref
    ON ticket_payments(provider, provider_ref)
    WHERE provider_ref IS NOT NULL;

-- Catalogo cerrado de kinds (mig 012): sumar el de pagos.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN (
        'payout_created', 'payout_reviewed', 'payout_disputed',
        'invitation_accepted', 'ticket_reissued', 'ticket_returned',
        'waitlist_offered', 'payment_approved'
    ));

CREATE OR REPLACE FUNCTION approve_ticket_payment(
    p_reference text,
    p_transaction_id text,
    p_status text,
    p_amount_in_cents bigint,
    p_raw_token text,
    p_payload jsonb DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_payment  ticket_payments%ROWTYPE;
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
        v_payment.customer_email
    );

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
$fn$;

COMMIT;
