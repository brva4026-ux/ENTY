-- =============================================================================
-- Sistema de Boleteria y Control de Aforo - Esquema MVP (PostgreSQL 14+)
-- -----------------------------------------------------------------------------
-- Principios de diseno:
--   1. Anti-sobreventa: al emitir una boleta se hace SELECT ... FOR UPDATE
--      sobre el cupo del promotor (o el evento), de modo que dos emisiones
--      concurrentes no puedan superar el aforo. Todo dentro de una transaccion.
--   2. Anti-reuso: el cambio de estado de una boleta (issued -> redeemed) se hace
--      con compare-and-swap atomico (WHERE status = 'issued'). Dos escaneos
--      simultaneos del mismo QR: solo uno gana.
--   3. Tokens con hash SHA-256: nunca se guarda el codigo QR en texto plano en la
--      base de datos. Si hay filtracion, la data no es reutilizable.
--   4. Multi-tenant desde el dia uno: todo cuelga de venues hace que abrir el
--      segundo bar sea configuracion, no refactor.
--
-- Convenciones:
--   * ids: bigint generados por secuencias (suficiente para este dominio).
--   * timestamps: timestamptz (guardamos UTC; la zona horaria se resuelve en
--     el cliente o en el evento con event_timezone).
--   * soft-delete: activo/borrado por booleano o deleted_at; nunca DROP de
--     dinero en produccion.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Extension: hash de tokens
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid, digest

-- ---------------------------------------------------------------------------
-- 1. USUARIOS Y ROLES
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email            text NOT NULL UNIQUE,
    phone            text,
    password_hash    text NOT NULL,
    full_name        text NOT NULL,
    is_active        boolean NOT NULL DEFAULT TRUE,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Rol global (sin tabla extra):
--   'super_admin' -> plataforma completa (todas las venues)
--   'admin'       -> administrador de la venue (probablemente dueno/manager)
--   'promotor'    -> panel de venta por cupo asignado
--   'bouncer'     -> escaneo/validacion en puerta
CREATE TYPE user_role AS ENUM ('super_admin', 'admin', 'promotor', 'bouncer');

CREATE TABLE venue_user_roles (
    venue_id   bigint NOT NULL,      -- FK se agrega tras crear venues
    user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       user_role NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (venue_id, user_id, role)
);

-- ---------------------------------------------------------------------------
-- 2. VENUE (multi-tenant): la discoteca/bar al que se factura
-- ---------------------------------------------------------------------------

CREATE TABLE venues (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          text NOT NULL,
    slug          text NOT NULL UNIQUE,       -- para subdominio/URL amigable
    legal_name    text,                       -- razon social (facturacion)
    tax_id        text,                       -- NIT
    country       text NOT NULL DEFAULT 'CO',
    currency      text NOT NULL DEFAULT 'COP',
    logo_url      text,
    primary_color text,
    is_active     boolean NOT NULL DEFAULT TRUE,
    created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE venue_user_roles
    ADD CONSTRAINT venue_user_roles_venue_fk
    FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. EVENTO
-- ---------------------------------------------------------------------------

CREATE TABLE events (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id       bigint NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    name           text NOT NULL,
    description    text,
    flyer_url      text,                       -- bucket S3 / R2 / local
    starts_at      timestamptz NOT NULL,       -- cuando abre puertas
    ends_at        timestamptz,
    event_timezone text NOT NULL DEFAULT 'America/Bogota',
    capacity       integer NOT NULL CHECK (capacity > 0),          -- aforo total fisico
    status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'published', 'live', 'ended', 'cancelled')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Aforo del evento nunca baja de las boletas no canceladas
CREATE OR REPLACE FUNCTION events_check_capacity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    active_issued bigint;
BEGIN
    IF NEW.capacity IS DISTINCT FROM OLD.capacity THEN
        SELECT count(*) INTO active_issued
          FROM tickets t
         WHERE t.event_id = NEW.id
           AND t.status <> 'voided'
           AND t.status <> 'refunded';
        IF NEW.capacity < active_issued THEN
            RAISE EXCEPTION 'capacity_cannot_be_below_issued (capacity=%, issued=%)',
                NEW.capacity, active_issued;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_events_check_capacity
    BEFORE UPDATE OF capacity ON events
    FOR EACH ROW EXECUTE FUNCTION events_check_capacity();

-- ---------------------------------------------------------------------------
-- 4. TIPOS DE BOLETA (general, VIP, cortesia, etc.)
-- ---------------------------------------------------------------------------

CREATE TABLE ticket_types (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id       bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name           text NOT NULL,              -- 'General', 'VIP', 'Cortesia'
    price_cents    bigint NOT NULL DEFAULT 0 CHECK (price_cents >= 0),  -- 0 = cortesia
    currency       text NOT NULL DEFAULT 'COP',
    quantity       integer NOT NULL CHECK (quantity > 0),  -- cupo de este tipo
    is_courtesy    boolean NOT NULL DEFAULT FALSE,
    is_active      boolean NOT NULL DEFAULT TRUE,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, name)
);

-- ---------------------------------------------------------------------------
-- 5. CUPO DEL PROMOTOR (la "canasta" que el admin asigna)
-- ---------------------------------------------------------------------------

CREATE TABLE promoter_allocations (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    ticket_type_id  bigint NOT NULL REFERENCES ticket_types(id) ON DELETE CASCADE,
    promoter_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    capacity        integer NOT NULL CHECK (capacity >= 0),
    is_active       boolean NOT NULL DEFAULT TRUE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, ticket_type_id, promoter_id)
);

-- ---------------------------------------------------------------------------
-- 6. BOLETA (el activo central)
-- ---------------------------------------------------------------------------

CREATE TYPE ticket_status AS ENUM ('issued', 'voided', 'refunded', 'redeemed');

CREATE TABLE tickets (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id          bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    ticket_type_id    bigint NOT NULL REFERENCES ticket_types(id) ON DELETE RESTRICT,
    allocation_id     bigint REFERENCES promoter_allocations(id) ON DELETE SET NULL, -- NULL = venta directa
    sold_by_user_id   bigint REFERENCES users(id) ON DELETE SET NULL,
    customer_name     text NOT NULL,
    customer_phone    text,
    customer_email    text,
    token_hash        text NOT NULL UNIQUE,     -- sha256 del codigo QR crudo
    status            ticket_status NOT NULL DEFAULT 'issued',
    issued_at         timestamptz NOT NULL DEFAULT now(),
    voided_at         timestamptz,
    redeemed_at       timestamptz,
    redeemed_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
    price_cents_snapshot bigint NOT NULL,     -- precio al momento de emitir
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tickets_event_status     ON tickets (event_id, status);
CREATE INDEX idx_tickets_allocation       ON tickets (allocation_id);
CREATE INDEX idx_tickets_phone            ON tickets (customer_phone) WHERE customer_phone IS NOT NULL;
CREATE INDEX idx_tickets_token_hash       ON tickets (token_hash);

-- ---------------------------------------------------------------------------
-- 7. REDENCIONES (cada escaneo deja huella, no solo el cambio de estado)
-- ---------------------------------------------------------------------------

CREATE TABLE redemptions (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id     bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    event_id      bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    scanned_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
    outcome       text NOT NULL,  -- granted | already_redeemed | not_found | invalid_event
    scanned_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_redemptions_ticket ON redemptions (ticket_id, scanned_at);
CREATE INDEX idx_redemptions_event  ON redemptions (event_id, scanned_at);

-- =============================================================================
-- FUNCIONES TRANSACCIONALES (TODA la logica critica vive aqui, en la DB)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- emit_ticket: crea una boleta respetando cupos y aforo ANTICIPADO.
--   - Bloquea la fila del cupo (row lock) para evitar sobreventa concurrente.
--   - Bloquea la fila del evento (aforo global por tipo cancelador).
--   - Verifica que el evento no haya cerrado puertas.
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
    v_type          ticket_types%ROWTYPE;
    v_alloc         promoter_allocations%ROWTYPE;
    v_used_in_alloc bigint;
    v_used_in_event bigint;
    v_alloc_capacity bigint;
    v_event_capacity bigint;
    v_status_allowed text;
    v_token_hash text;
    v_ticket_id bigint;
BEGIN
    SELECT * INTO v_type FROM ticket_types WHERE id = p_ticket_type_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_type_not_found'; END IF;

    -- Snapshot de precio para inmutabilidad financiera.
    IF v_type.price_cents > 0 AND p_allocation_id IS NOT NULL THEN
        RAISE EXCEPTION 'paid_ticket_tied_to_promoter_allocation: usar venta directa para boletas de pago';
    END IF;

    -- 1) Bloquear el evento: serializa emisiones concurrentes y valida aforo global.
    SELECT capacity, status INTO v_event_capacity, v_status_allowed
      FROM events WHERE id = p_event_id FOR UPDATE;
    IF v_status_allowed IN ('draft') THEN
        RAISE EXCEPTION 'event_not_open_for_sales';
    END IF;

    SELECT count(*) INTO v_used_in_event
      FROM tickets
     WHERE event_id = p_event_id
       AND ticket_type_id = p_ticket_type_id
       AND status NOT IN ('voided', 'refunded');
    IF v_used_in_event >= v_type.quantity THEN
        RAISE EXCEPTION 'ticket_type_sold_out';
    END IF;

    -- 2) Si hay cupo de promotor: bloquear la fila y validar su capacidad.
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

    -- 3) Aforo global del evento (puerta): no puede exceder capacity.
    SELECT count(*) INTO v_used_in_event
      FROM tickets
     WHERE event_id = p_event_id
       AND status NOT IN ('voided', 'refunded');
    IF v_used_in_event >= v_event_capacity THEN
        RAISE EXCEPTION 'event_at_capacity';
    END IF;

    -- v_token_hash: el token crudo ya es un secreto de alta entropia generado por
    -- el backend (p.ej. crypto.randomBytes(20).toString('base64url')); por eso
    -- basta el sha256 sin salt. Si la DB se filtra, los hashes no permiten
    -- reusar boletas ajenas ni adivinar tokens validos.
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
-- redeem_ticket: valida y redime una boleta. Compare-and-swap atomico:
--   UPDATE ... SET status='redeemed' WHERE status='issued' -> solo 1 gana.
--   Devuelve un criterio legible para el bouncer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION redeem_ticket(
    p_event_id      bigint,
    p_raw_token     text,
    p_scanned_by_user_id bigint
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_ticket tickets%ROWTYPE;
    v_token_hash text;
    v_event_status text;
BEGIN
    IF p_raw_token IS NULL OR length(p_raw_token) < 8 THEN
        RAISE EXCEPTION 'invalid_token_format';
    END IF;

    v_token_hash := encode(digest(p_raw_token, 'sha256'), 'hex');

    SELECT * INTO v_ticket FROM tickets WHERE token_hash = v_token_hash;
    IF NOT FOUND THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
        SELECT t.id, p_event_id, p_scanned_by_user_id, 'not_found'
          FROM tickets t WHERE t.token_hash = v_token_hash;
        RETURN 'NOT_FOUND';
    END IF;

    IF v_ticket.event_id <> p_event_id THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'invalid_event');
        RETURN 'INVALID_EVENT';
    END IF;

    SELECT status INTO v_event_status FROM events WHERE id = p_event_id;
    IF v_event_status <> 'live' AND v_event_status <> 'published' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'event_not_live');
        RETURN 'EVENT_NOT_LIVE';
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