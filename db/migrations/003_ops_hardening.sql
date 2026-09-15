-- =============================================================================
-- Migración 003: robustez operativa de la puerta y del aforo.
--   1) emit_ticket rechaza eventos ended/cancelled (antes solo draft).
--      Además unifica el chequeo de inventario: la suma de quantities de los
--      tipos define el total vendible (antes cada tipo vendía hasta su propia
--      quantity, permitiendo exceder el aforo con N tipos).
--   2) set_event_status('published'->'live') valida que el inventario no esté
--      por debajo de lo ya emitido (la puerta no abre con sobreventa).
-- Conserva intacto el chequeo de cupo por promotor (anti-sobreventa original).
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) emit_ticket endurecido
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION emit_ticket(
    p_event_id         bigint,
    p_ticket_type_id   bigint,
    p_allocation_id    bigint,        -- NULL para venta directa
    p_sold_by_user_id  bigint,
    p_customer_name    text,
    p_raw_token        text,
    p_customer_phone   text DEFAULT NULL,
    p_customer_email   text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    v_type           ticket_types%ROWTYPE;
    v_alloc          promoter_allocations%ROWTYPE;
    v_used_in_alloc  bigint;
    v_used_total     bigint;
    v_types_total    bigint;
    v_event_capacity bigint;
    v_status_allowed text;
    v_token_hash     text;
    v_ticket_id      bigint;
BEGIN
    SELECT * INTO v_type FROM ticket_types WHERE id = p_ticket_type_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_type_not_found'; END IF;

    IF v_type.price_cents > 0 AND p_allocation_id IS NOT NULL THEN
        RAISE EXCEPTION 'paid_ticket_tied_to_promoter_allocation: usar venta directa para boletas de pago';
    END IF;

    -- 1) Bloquear el evento: serializa emisiones concurrentes y valida estado.
    SELECT capacity, status INTO v_event_capacity, v_status_allowed
      FROM events WHERE id = p_event_id FOR UPDATE;
    IF v_status_allowed NOT IN ('published', 'live') THEN
        RAISE EXCEPTION 'event_not_open_for_sales';
    END IF;

    -- 2) Cupo del promotor (si aplica): bloquear fila y validar capacidad.
    IF p_allocation_id IS NOT NULL THEN
        SELECT * INTO v_alloc FROM promoter_allocations WHERE id = p_allocation_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'allocation_not_found'; END IF;
        SELECT count(*) INTO v_used_in_alloc
          FROM tickets
         WHERE allocation_id = p_allocation_id
           AND status NOT IN ('voided', 'refunded');
        IF v_used_in_alloc >= v_alloc.capacity THEN
            RAISE EXCEPTION 'promoter_quota_exceeded';
        END IF;
    END IF;

    -- 3) Un solo conteo de boletas activas del evento (anti-sobreventa global).
    SELECT count(*) INTO v_used_total
      FROM tickets
     WHERE event_id = p_event_id
       AND status NOT IN ('voided', 'refunded');

    -- 3a) Inventario por tipos: la suma de quantities es el total vendible.
    SELECT COALESCE(SUM(quantity), 0) INTO v_types_total
      FROM ticket_types WHERE event_id = p_event_id;
    IF v_used_total >= v_types_total THEN
        RAISE EXCEPTION 'ticket_type_sold_out';
    END IF;

    -- 3b) Aforo físico del evento.
    IF v_used_total >= v_event_capacity THEN
        RAISE EXCEPTION 'event_at_capacity';
    END IF;

    v_token_hash := encode(digest(p_raw_token, 'sha256'), 'hex');

    INSERT INTO tickets (
        event_id, ticket_type_id, allocation_id, sold_by_user_id,
        customer_name, customer_phone, customer_email, token_hash,
        price_cents_snapshot
    ) VALUES (
        p_event_id, p_ticket_type_id, p_allocation_id, p_sold_by_user_id,
        p_customer_name, p_customer_phone, p_customer_email, v_token_hash,
        v_type.price_cents
    ) RETURNING id INTO v_ticket_id;

    RETURN v_ticket_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) set_event_status: al abrir puertas, el inventario debe cubrir lo emitido.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_event_status(
    p_event_id bigint,
    p_from     text,
    p_to       text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_count integer;
    v_issued bigint;
    v_types_total bigint;
BEGIN
    SELECT count(*) INTO v_count
      FROM events
     WHERE id = p_event_id
       AND status = p_from;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'invalid_transition';
    END IF;

    -- Al abrir puertas (published -> live): la suma de quantities de los tipos
    -- debe cubrir las boletas ya emitidas. Si el admin redujo tipos por
    -- debajo de lo vendido, la puerta no abre con sobreventa.
    IF p_from = 'published' AND p_to = 'live' THEN
        SELECT count(*) INTO v_issued
          FROM tickets
         WHERE event_id = p_event_id
           AND status NOT IN ('voided', 'refunded');

        SELECT COALESCE(SUM(quantity), 0) INTO v_types_total
          FROM ticket_types
         WHERE event_id = p_event_id;

        IF v_issued > v_types_total THEN
            RAISE EXCEPTION 'capacity_below_issued (issued=%, types_total=%)',
                v_issued, v_types_total;
        END IF;
    END IF;

    UPDATE events
       SET status = p_to, updated_at = now()
     WHERE id = p_event_id AND status = p_from;
END;
$$;

COMMIT;
