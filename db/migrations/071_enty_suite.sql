-- 071: suite operativa y comercial de Enty.
-- Agrupa transporte, plano, turnos, check-in, órdenes, equipos, reservas,
-- hitos, cortesías, documentos, cambios/upgrades, reventa y recuperación.
BEGIN;

CREATE TABLE IF NOT EXISTS public.event_transport_points (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    kind text NOT NULL DEFAULT 'otro'
        CHECK (kind IN ('recogida','parqueadero','regreso','otro')),
    name text NOT NULL,
    detail text,
    schedule text,
    map_url text,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_transport_event
    ON public.event_transport_points (event_id, sort_order, id);

CREATE TABLE IF NOT EXISTS public.event_map_points (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    kind text NOT NULL DEFAULT 'otro'
        CHECK (kind IN ('baño','atencion','encuentro','accesible','salida','otro')),
    name text NOT NULL,
    description text,
    accessible boolean NOT NULL DEFAULT false,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_map_event
    ON public.event_map_points (event_id, sort_order, id);

CREATE TABLE IF NOT EXISTS public.checkout_recoveries (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    ticket_type_id bigint REFERENCES public.ticket_types(id) ON DELETE SET NULL,
    reference text,
    customer_name text,
    customer_phone text,
    customer_email text,
    token text NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','sent','used','expired')),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone
);
CREATE INDEX IF NOT EXISTS idx_checkout_recoveries_event
    ON public.checkout_recoveries (event_id, created_at DESC);

ALTER TABLE public.event_staff
    ADD COLUMN IF NOT EXISTS break_start timestamp with time zone,
    ADD COLUMN IF NOT EXISTS break_end timestamp with time zone,
    ADD COLUMN IF NOT EXISTS station text;

CREATE TABLE IF NOT EXISTS public.staff_checkins (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    checked_in_at timestamp with time zone NOT NULL DEFAULT now(),
    checked_out_at timestamp with time zone,
    note text
);
CREATE INDEX IF NOT EXISTS idx_staff_checkins_event
    ON public.staff_checkins (event_id, checked_in_at DESC);

CREATE TABLE IF NOT EXISTS public.ops_orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    message text NOT NULL,
    target text,
    created_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    resolved_at timestamp with time zone
);
CREATE INDEX IF NOT EXISTS idx_ops_orders_event
    ON public.ops_orders (event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ops_order_acks (
    order_id bigint NOT NULL REFERENCES public.ops_orders(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    door_name text,
    acked_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (order_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.equipment_loans (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    item_name text NOT NULL,
    serial text,
    responsible_user_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'prestado'
        CHECK (status IN ('prestado','devuelto','perdido')),
    delivered_at timestamp with time zone NOT NULL DEFAULT now(),
    returned_at timestamp with time zone,
    notes text
);
CREATE INDEX IF NOT EXISTS idx_equipment_event
    ON public.equipment_loans (event_id, status, delivered_at DESC);

CREATE TABLE IF NOT EXISTS public.venue_bookings (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    event_id bigint REFERENCES public.events(id) ON DELETE SET NULL,
    title text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    setup_starts_at timestamp with time zone,
    teardown_ends_at timestamp with time zone,
    status text NOT NULL DEFAULT 'tentativa'
        CHECK (status IN ('tentativa','confirmada','cancelada')),
    notes text,
    created_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_venue_bookings_range
    ON public.venue_bookings (venue_id, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS public.production_milestones (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    title text NOT NULL,
    due_date date NOT NULL,
    owner_user_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'pendiente'
        CHECK (status IN ('pendiente','hecho','bloqueado')),
    notes text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    completed_at timestamp with time zone
);
CREATE INDEX IF NOT EXISTS idx_milestones_event
    ON public.production_milestones (event_id, due_date, id);

CREATE TABLE IF NOT EXISTS public.courtesy_requests (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    ticket_type_id bigint REFERENCES public.ticket_types(id) ON DELETE SET NULL,
    requested_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    quantity integer NOT NULL CHECK (quantity > 0),
    reason text,
    status text NOT NULL DEFAULT 'pendiente'
        CHECK (status IN ('pendiente','aprobada','rechazada')),
    reviewed_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_courtesy_event
    ON public.courtesy_requests (event_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.event_documents (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    title text NOT NULL,
    url text NOT NULL,
    version text NOT NULL DEFAULT '1',
    access_role text NOT NULL DEFAULT 'equipo'
        CHECK (access_role IN ('admin','equipo','todos')),
    owner_user_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
    notes text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_documents_event
    ON public.event_documents (event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ticket_changes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    old_ticket_id bigint NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
    new_ticket_id bigint REFERENCES public.tickets(id) ON DELETE SET NULL,
    kind text NOT NULL CHECK (kind IN ('cambio','upgrade')),
    old_type_id bigint REFERENCES public.ticket_types(id) ON DELETE SET NULL,
    new_type_id bigint REFERENCES public.ticket_types(id) ON DELETE SET NULL,
    amount_due_cents bigint NOT NULL DEFAULT 0,
    refund_cents bigint NOT NULL DEFAULT 0,
    payment_method text,
    reason text,
    created_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ticket_changes_event
    ON public.ticket_changes (event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ticket_resales (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    ticket_id bigint NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
    seller_name text,
    seller_phone text,
    price_cents bigint NOT NULL CHECK (price_cents >= 0),
    status text NOT NULL DEFAULT 'publicada'
        CHECK (status IN ('publicada','solicitada','vendida','cancelada')),
    buyer_name text,
    buyer_phone text,
    buyer_email text,
    new_ticket_id bigint REFERENCES public.tickets(id) ON DELETE SET NULL,
    payment_method text,
    sold_at timestamp with time zone,
    created_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    notes text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ticket_resales_event
    ON public.ticket_resales (event_id, status, created_at DESC);

CREATE OR REPLACE FUNCTION public.change_ticket(
    p_ticket_id bigint,
    p_new_event_id bigint,
    p_new_type_id bigint,
    p_raw_token text,
    p_by_user_id bigint,
    p_payment_method text DEFAULT NULL,
    p_reason text DEFAULT NULL
) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_old tickets%ROWTYPE;
    v_new_type ticket_types%ROWTYPE;
    v_old_venue bigint;
    v_new_venue bigint;
    v_new_id bigint;
    v_due bigint;
    v_refund bigint;
BEGIN
    SELECT * INTO v_old FROM tickets WHERE id = p_ticket_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_not_found'; END IF;
    IF v_old.status <> 'issued' THEN
        RAISE EXCEPTION 'ticket_not_changeable';
    END IF;

    SELECT * INTO v_new_type FROM ticket_types
     WHERE id = p_new_type_id AND event_id = p_new_event_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_type_not_in_event'; END IF;
    IF NOT v_new_type.is_active THEN RAISE EXCEPTION 'ticket_type_inactive'; END IF;

    SELECT venue_id INTO v_old_venue FROM events WHERE id = v_old.event_id;
    SELECT venue_id INTO v_new_venue FROM events WHERE id = p_new_event_id;
    IF v_old_venue IS DISTINCT FROM v_new_venue THEN
        RAISE EXCEPTION 'event_from_another_venue';
    END IF;

    UPDATE tickets SET status='voided', voided_at=now(), updated_at=now()
     WHERE id = v_old.id AND status='issued';
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_not_changeable'; END IF;

    v_new_id := emit_ticket(
        p_new_event_id, p_new_type_id, NULL, v_old.sold_by_user_id,
        v_old.customer_name, p_raw_token, v_old.customer_phone,
        v_old.customer_email, p_payment_method, v_old.customer_birth_date
    );
    UPDATE tickets SET price_cents_snapshot = v_new_type.price_cents
     WHERE id = v_new_id;

    v_due := GREATEST(v_new_type.price_cents - v_old.price_cents_snapshot, 0);
    v_refund := GREATEST(v_old.price_cents_snapshot - v_new_type.price_cents, 0);
    INSERT INTO ticket_changes
        (venue_id, event_id, old_ticket_id, new_ticket_id, kind,
         old_type_id, new_type_id, amount_due_cents, refund_cents,
         payment_method, reason, created_by)
    VALUES
        (v_old_venue, p_new_event_id, v_old.id, v_new_id,
         CASE WHEN v_old.event_id = p_new_event_id THEN 'upgrade' ELSE 'cambio' END,
         v_old.ticket_type_id, p_new_type_id, v_due, v_refund,
         p_payment_method, p_reason, p_by_user_id);
    RETURN v_new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.sell_resale(
    p_resale_id bigint,
    p_buyer_name text,
    p_buyer_phone text,
    p_buyer_email text,
    p_raw_token text,
    p_by_user_id bigint,
    p_payment_method text DEFAULT NULL
) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_resale ticket_resales%ROWTYPE;
    v_ticket tickets%ROWTYPE;
    v_new_id bigint;
BEGIN
    SELECT * INTO v_resale FROM ticket_resales WHERE id=p_resale_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'resale_not_found'; END IF;
    IF v_resale.status NOT IN ('publicada','solicitada') THEN
        RAISE EXCEPTION 'resale_not_available';
    END IF;
    SELECT * INTO v_ticket FROM tickets WHERE id=v_resale.ticket_id FOR UPDATE;
    IF NOT FOUND OR v_ticket.status <> 'issued' THEN
        RAISE EXCEPTION 'ticket_not_changeable';
    END IF;

    UPDATE tickets SET status='voided', voided_at=now(), updated_at=now()
     WHERE id=v_ticket.id AND status='issued';
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_not_changeable'; END IF;

    v_new_id := emit_ticket(
        v_ticket.event_id, v_ticket.ticket_type_id, NULL, p_by_user_id,
        p_buyer_name, p_raw_token, p_buyer_phone, p_buyer_email,
        p_payment_method, v_ticket.customer_birth_date
    );
    UPDATE tickets SET price_cents_snapshot = v_resale.price_cents
     WHERE id=v_new_id;

    UPDATE ticket_resales
       SET status='vendida', buyer_name=p_buyer_name, buyer_phone=p_buyer_phone,
           buyer_email=p_buyer_email, new_ticket_id=v_new_id,
           payment_method=p_payment_method, sold_at=now()
     WHERE id=p_resale_id;
    RETURN v_new_id;
END;
$$;

COMMIT;
