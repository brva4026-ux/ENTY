-- 063: espacio de promotor de punta a punta.
--
--   * Origen de venta y atribución: cada boleta dice si nació de un cupo,
--     de una emisión directa o de un link público del promotor.
--   * Idempotencia de emisión: el cliente puede reintentar sin duplicar.
--   * Links públicos por (evento, promotor) con métricas comprobables.
--   * Incidencias reportadas por el promotor ("por atender").
--   * Items congelados de cada liquidación para que el detalle no cambie
--     cuando una boleta se anule después del cierre.
--   * Avisos propios del promotor: asignación, cupo y cierre de ventas.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Origen de venta e idempotencia en boletas
-- ---------------------------------------------------------------------------
ALTER TABLE tickets
    ADD COLUMN IF NOT EXISTS client_request_id text,
    ADD COLUMN IF NOT EXISTS sale_channel text NOT NULL DEFAULT 'venue';

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_sale_channel_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_sale_channel_check
    CHECK (sale_channel IN (
        'venue', 'public', 'promoter_quota', 'promoter_direct', 'promoter_link'
    ));

CREATE UNIQUE INDEX IF NOT EXISTS tickets_client_request_uidx
    ON tickets (sold_by_user_id, client_request_id)
    WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tickets_sold_by_channel
    ON tickets (sold_by_user_id, sale_channel, issued_at DESC);

-- Las boletas históricas de cupo ya tienen allocation_id: se etiquetan para
-- que el filtro por canal no las trate como venta de taquilla.
UPDATE tickets
   SET sale_channel = 'promoter_quota'
 WHERE allocation_id IS NOT NULL AND sale_channel = 'venue';

-- ---------------------------------------------------------------------------
-- 2. Atribución en el checkout público
-- ---------------------------------------------------------------------------
ALTER TABLE ticket_payments
    ADD COLUMN IF NOT EXISTS promoter_id bigint REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS sale_channel text NOT NULL DEFAULT 'public';

ALTER TABLE ticket_payments DROP CONSTRAINT IF EXISTS ticket_payments_sale_channel_check;
ALTER TABLE ticket_payments ADD CONSTRAINT ticket_payments_sale_channel_check
    CHECK (sale_channel IN ('public', 'venue', 'promoter_link'));

CREATE INDEX IF NOT EXISTS idx_ticket_payments_promoter
    ON ticket_payments (promoter_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Link público del promotor
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promoter_links (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id bigint NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    event_id bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    promoter_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_id text NOT NULL UNIQUE,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (event_id, promoter_id)
);

CREATE INDEX IF NOT EXISTS idx_promoter_links_promoter
    ON promoter_links (promoter_id, event_id);

CREATE TABLE IF NOT EXISTS promoter_link_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    link_id bigint NOT NULL REFERENCES promoter_links(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('view', 'checkout_started', 'purchase_approved')),
    reference text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS promoter_link_events_purchase_uidx
    ON promoter_link_events (link_id, reference)
    WHERE kind = 'purchase_approved' AND reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_promoter_link_events_link
    ON promoter_link_events (link_id, kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Incidencias que el promotor necesita atender
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promoter_sale_issues (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id bigint NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    event_id bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    ticket_id bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    promoter_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN (
        'contact', 'payment', 'delivery', 'duplicate', 'other'
    )),
    note text NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    resolution_note text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    resolved_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS idx_promoter_sale_issues_open
    ON promoter_sale_issues (promoter_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Items congelados de una liquidación
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promoter_payout_items (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    payout_id bigint NOT NULL REFERENCES promoter_payouts(id) ON DELETE CASCADE,
    ticket_id bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    event_id bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    ticket_type_id bigint NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE,
    issued_at timestamp with time zone NOT NULL,
    price_cents bigint NOT NULL,
    sale_channel text NOT NULL,
    status_at_close text NOT NULL,
    UNIQUE (payout_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_promoter_payout_items_payout
    ON promoter_payout_items (payout_id, issued_at DESC);

-- ---------------------------------------------------------------------------
-- 6. Avisos nuevos del promotor
-- ---------------------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN (
        'payout_created', 'payout_reviewed', 'payout_disputed',
        'invitation_accepted', 'ticket_reissued', 'ticket_returned',
        'waitlist_offered', 'payment_approved', 'event_autoclosed',
        'door_anomaly', 'capacity_alert', 'event_reminder',
        'ticket_refunded', 'door_open',
        'event_assigned', 'allocation_changed', 'sales_closed'
    ));

CREATE OR REPLACE FUNCTION public.notify_promoter_assignment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_event events%ROWTYPE;
BEGIN
    IF NEW.role <> 'promotor' THEN
        RETURN NEW;
    END IF;
    SELECT * INTO v_event FROM events WHERE id = NEW.event_id;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;
    PERFORM notify_user(
        NEW.user_id, v_event.venue_id, 'event_assigned',
        'Nueva noche asignada',
        'Te asignaron a "' || v_event.name || '". Revisa tu cupo y comparte tu link.',
        '/promotor?event=' || v_event.id
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_promoter_assignment ON public.event_staff;
CREATE TRIGGER trg_notify_promoter_assignment
    AFTER INSERT ON public.event_staff
    FOR EACH ROW EXECUTE FUNCTION public.notify_promoter_assignment();

CREATE OR REPLACE FUNCTION public.notify_promoter_allocation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_event events%ROWTYPE;
    v_type  ticket_types%ROWTYPE;
BEGIN
    SELECT * INTO v_event FROM events WHERE id = NEW.event_id;
    SELECT * INTO v_type FROM ticket_types WHERE id = NEW.ticket_type_id;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND (
        NEW.capacity IS DISTINCT FROM OLD.capacity
        OR NEW.is_active IS DISTINCT FROM OLD.is_active
    )) THEN
        PERFORM notify_user(
            NEW.promoter_id, v_event.venue_id, 'allocation_changed',
            CASE WHEN TG_OP = 'INSERT' THEN 'Nuevo cupo asignado' ELSE 'Cupo actualizado' END,
            '"' || v_event.name || '" · ' || v_type.name || ': ' ||
            NEW.capacity || ' boletas' ||
            CASE WHEN NEW.is_active THEN '' ELSE ' (cupo retirado)' END || '.',
            '/promotor?event=' || v_event.id
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_promoter_allocation ON public.promoter_allocations;
CREATE TRIGGER trg_notify_promoter_allocation
    AFTER INSERT OR UPDATE OF capacity, is_active ON public.promoter_allocations
    FOR EACH ROW EXECUTE FUNCTION public.notify_promoter_allocation();

CREATE OR REPLACE FUNCTION public.notify_promoter_sales_closed() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    IF NEW.status IN ('ended', 'cancelled')
       AND OLD.status IN ('published', 'live') THEN
        PERFORM notify_user(
            s.user_id, NEW.venue_id, 'sales_closed',
            CASE WHEN NEW.status = 'cancelled' THEN 'Evento cancelado' ELSE 'Ventas cerradas' END,
            '"' || NEW.name || '" ' ||
            CASE WHEN NEW.status = 'cancelled'
                 THEN 'fue cancelado. Revisa tus boletas y comisiones.'
                 ELSE 'terminó. Revisa tus ventas y comisiones.' END,
            '/promotor?event=' || NEW.id
        )
        FROM event_staff s
        WHERE s.event_id = NEW.id AND s.role = 'promotor';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_promoter_sales_closed ON public.events;
CREATE TRIGGER trg_notify_promoter_sales_closed
    AFTER UPDATE OF status ON public.events
    FOR EACH ROW EXECUTE FUNCTION public.notify_promoter_sales_closed();

COMMIT;
