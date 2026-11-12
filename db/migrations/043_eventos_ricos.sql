-- =============================================================================
-- 043 — Eventos más ricos: categoría elegible, lineup, cupones, reembolso y
--       recordatorio de la noche.
-- =============================================================================
-- Motivo (segunda mitad de la tanda "operar la noche"): el modelo de eventos se
-- quedó corto para lo que el negocio ya hace a mano:
--
--   1. CATEGORÍA: no existía columna; el catálogo público la ADIVINABA del
--      texto (`_category_of`) y caía en "Música" por defecto. Una graduación
--      salía como música y el organizador no podía corregirlo.
--   2. LINEUP: la ficha pública ya tiene la pestaña, pero devolvía [] siempre
--      ("el modelo no tiene artistas todavía").
--   3. CUPONES: no había códigos de descuento; solo cortesía (gratis) o precio
--      fijo. Un 2x1 o un "TEMPRANO20" se resolvía por fuera.
--   4. REEMBOLSO: `refunded` existe en el enum y todo el sistema lo maneja
--      (aforo, puerta, cierre: status NOT IN ('voided','refunded')) pero
--      NINGÚN camino lo asignaba. Era un estado huérfano.
--   5. RECORDATORIO: nadie avisaba "tu evento empieza pronto".
--   6. FICHA: edad mínima / dress code / apertura de puertas no existían.
--
-- Idempotente: safe re-run (IF NOT EXISTS / OR REPLACE / DROP CONSTRAINT IF
-- EXISTS antes de ADD).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) EVENTOS: categoría elegible + campos de ficha
-- ---------------------------------------------------------------------------
-- Categoría: texto acotado. NULL = sin categoría elegida -> el catálogo
-- público cae a la heurística de siempre (compatibilidad hacia atrás).
ALTER TABLE events ADD COLUMN IF NOT EXISTS category text;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_category_check;
ALTER TABLE events ADD CONSTRAINT events_category_check
    CHECK (category IS NULL OR category IN (
        'Música', 'Deportes', 'Teatro', 'Fiesta', 'Cultural',
        'Académico', 'Comedia', 'Otro'
    ));

-- Ficha del evento: lo que el invitado pregunta en la puerta.
ALTER TABLE events ADD COLUMN IF NOT EXISTS min_age integer;
ALTER TABLE events ADD COLUMN IF NOT EXISTS dress_code text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS doors_open_at timestamp with time zone;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_min_age_check;
ALTER TABLE events ADD CONSTRAINT events_min_age_check
    CHECK (min_age IS NULL OR (min_age >= 0 AND min_age <= 99));

-- Marca del recordatorio: cuándo se avisó (NULL = aún no). Evita mandar el
-- mismo aviso en cada lectura (ver notify_event_reminders).
ALTER TABLE events ADD COLUMN IF NOT EXISTS reminded_at timestamp with time zone;

-- ---------------------------------------------------------------------------
-- 2) LINEUP: los artistas de la noche
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_lineup (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name text NOT NULL,
    role text,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT event_lineup_name_check CHECK (btrim(name) <> '')
);

CREATE INDEX IF NOT EXISTS idx_event_lineup_event
    ON event_lineup (event_id, sort_order, id);

-- ---------------------------------------------------------------------------
-- 3) CUPONES: descuentos por código (solo venta online)
-- ---------------------------------------------------------------------------
-- `percent`: 1..99 (100 = gratis -> usar cortesía, no un cupón).
-- `fixed`: descuento en centavos, validado contra el precio en el checkout.
CREATE TABLE IF NOT EXISTS coupons (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    code text NOT NULL,
    kind text NOT NULL,
    value integer NOT NULL,
    max_uses integer,
    used_count integer NOT NULL DEFAULT 0,
    expires_at timestamp with time zone,
    is_active boolean NOT NULL DEFAULT true,
    created_by bigint,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT coupons_kind_check CHECK (kind IN ('percent', 'fixed')),
    CONSTRAINT coupons_value_check CHECK (
        (kind = 'percent' AND value BETWEEN 1 AND 99)
        OR (kind = 'fixed' AND value > 0)
    ),
    CONSTRAINT coupons_max_uses_check CHECK (max_uses IS NULL OR max_uses > 0),
    CONSTRAINT coupons_code_check CHECK (btrim(code) <> '')
);

-- Un código no se repite dentro del evento (case-insensitive: "temprano20"
-- y "TEMPRANO20" son el mismo cupón).
CREATE UNIQUE INDEX IF NOT EXISTS uq_coupons_event_code
    ON coupons (event_id, lower(code));

-- El cupón aplicado a un cobro (NULL = sin cupón). El descuento queda
-- registrado para el arqueo: el dinero que entró es el neto, pero se ve
-- cuánto se descontó y con qué código.
ALTER TABLE ticket_payments ADD COLUMN IF NOT EXISTS coupon_id bigint;
ALTER TABLE ticket_payments ADD COLUMN IF NOT EXISTS discount_in_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE ticket_payments DROP CONSTRAINT IF EXISTS ticket_payments_coupon_id_fkey;
ALTER TABLE ticket_payments ADD CONSTRAINT ticket_payments_coupon_id_fkey
    FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 4) REEMBOLSO: auditoría del estado que ya existía sin dueño
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_refunds (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    event_id bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    amount_in_cents bigint NOT NULL DEFAULT 0,
    reason text,
    refunded_by_user_id bigint,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_refunds_ticket ON ticket_refunds (ticket_id);

-- ---------------------------------------------------------------------------
-- 5) KINDS de notificación nuevos
-- ---------------------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind = ANY (ARRAY[
        'payout_created', 'payout_reviewed', 'payout_disputed',
        'invitation_accepted', 'ticket_reissued', 'ticket_returned',
        'waitlist_offered', 'payment_approved', 'event_autoclosed',
        'door_anomaly', 'capacity_alert', 'event_reminder', 'ticket_refunded'
    ]::text[]));

-- ---------------------------------------------------------------------------
-- 6) refund_ticket(): el dueño del estado 'refunded'
-- ---------------------------------------------------------------------------
-- Espejo de void_ticket, con dos diferencias de negocio:
--   * NO exige evento abierto: un reembolso puede ocurrir después de la noche.
--   * Deja auditoría en ticket_refunds (monto + motivo + quién), que es lo que
--     el arqueo necesita para cuadrar la salida de dinero.
CREATE OR REPLACE FUNCTION public.refund_ticket(
    p_ticket_id bigint,
    p_amount_in_cents bigint,
    p_reason text,
    p_by_user_id bigint
) RETURNS bigint
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

-- ---------------------------------------------------------------------------
-- 7) notify_event_reminders(): "tu evento empieza pronto"
-- ---------------------------------------------------------------------------
-- Se llama best-effort desde las lecturas (mismo patrón que auto_close: en
-- serverless no hay cron). Avisa UNA vez por evento: la marca `reminded_at`
-- evita repetir el aviso en cada request. Devuelve cuántos eventos avisó.
CREATE OR REPLACE FUNCTION public.notify_event_reminders() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_row   events%ROWTYPE;
    v_count integer := 0;
BEGIN
    FOR v_row IN
        SELECT * FROM events
         WHERE status IN ('published', 'live')
           AND reminded_at IS NULL
           AND starts_at > now()
           AND starts_at <= now() + INTERVAL '2 hours'
         FOR UPDATE SKIP LOCKED
    LOOP
        PERFORM notify_venue_admins(
            v_row.venue_id, 'event_reminder',
            'Tu evento empieza pronto',
            'Faltan menos de 2 horas para "' || v_row.name
              || '". Revisa equipo, aforo y puerta.',
            '/admin?event=' || v_row.id
        );

        -- El staff asignado (bouncers/promotores) también se entera.
        PERFORM notify_user(
            s.user_id, v_row.venue_id, 'event_reminder',
            'Tu turno empieza pronto',
            'Faltan menos de 2 horas para "' || v_row.name || '".',
            '/admin?event=' || v_row.id
        )
        FROM event_staff s WHERE s.event_id = v_row.id;

        UPDATE events SET reminded_at = now() WHERE id = v_row.id;
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8) approve_ticket_payment(): aplica el cupón al emitir
-- ---------------------------------------------------------------------------
-- Cuerpo idéntico al de schema.sql (lo exige el drift test) más el bloque que
-- ajusta el precio de la boleta al neto pagado y suma el uso del cupón.
CREATE OR REPLACE FUNCTION public.approve_ticket_payment(p_reference text, p_transaction_id text, p_status text, p_amount_in_cents bigint, p_raw_token text, p_payload jsonb DEFAULT NULL::jsonb) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
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
        v_payment.customer_email,
        'online'
    );

    -- Cupón aplicado (mig 043): la boleta nace con el precio de lista; aquí se
    -- corrige al NETO que el fan pagó, para que el recaudo y el cierre de caja
    -- reflejen el descuento. Sin cupón, amount_in_cents == precio de lista y
    -- este bloque no hace nada.
    IF v_payment.discount_in_cents > 0 THEN
        UPDATE tickets SET price_cents_snapshot = v_payment.amount_in_cents
         WHERE id = v_ticket;
        UPDATE coupons SET used_count = used_count + 1
         WHERE id = v_payment.coupon_id;
    END IF;

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
$$;

COMMIT;
