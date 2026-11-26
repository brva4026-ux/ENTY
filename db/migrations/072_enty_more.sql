-- 072: doce frentes nuevos de Enty.
-- Ingreso sin celular, contracargos, costos transparentes, reglas de acceso,
-- votaciones, grabaciones, sorteos, registro gratuito, catálogo de recintos,
-- previsión de personal, revisión de enlaces y archivo público.

BEGIN;

CREATE TABLE IF NOT EXISTS public.door_manual_admissions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    ticket_id bigint NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
    staff_user_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
    reason text NOT NULL,
    verification text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_manual_admissions_event
    ON public.door_manual_admissions (event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.payment_disputes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    payment_id bigint REFERENCES public.ticket_payments(id) ON DELETE SET NULL,
    provider text NOT NULL DEFAULT 'wompi',
    amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
    reason text NOT NULL,
    status text NOT NULL DEFAULT 'abierta'
        CHECK (status IN ('abierta','en_revision','ganada','perdida','cerrada')),
    due_at timestamptz,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    notes text,
    created_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_disputes_event
    ON public.payment_disputes (event_id, status, due_at);

CREATE TABLE IF NOT EXISTS public.event_fee_config (
    event_id bigint PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
    service_fee_cents bigint NOT NULL DEFAULT 0 CHECK (service_fee_cents >= 0),
    payment_fee_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (payment_fee_pct >= 0),
    tax_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_pct >= 0),
    show_breakdown boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_access_rules (
    event_id bigint PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
    dress_code text,
    bags_policy text,
    prohibited_items text[] NOT NULL DEFAULT '{}',
    version integer NOT NULL DEFAULT 1,
    updated_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_polls (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    question text NOT NULL,
    status text NOT NULL DEFAULT 'borrador'
        CHECK (status IN ('borrador','abierta','cerrada','publicada')),
    opens_at timestamptz,
    closes_at timestamptz,
    created_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_polls_event ON public.event_polls (event_id, status);

CREATE TABLE IF NOT EXISTS public.event_poll_options (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    poll_id bigint NOT NULL REFERENCES public.event_polls(id) ON DELETE CASCADE,
    label text NOT NULL,
    sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.event_poll_votes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    poll_id bigint NOT NULL REFERENCES public.event_polls(id) ON DELETE CASCADE,
    option_id bigint NOT NULL REFERENCES public.event_poll_options(id) ON DELETE CASCADE,
    ticket_id bigint NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (poll_id, ticket_id)
);

CREATE TABLE IF NOT EXISTS public.event_recordings (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    ticket_type_id bigint REFERENCES public.ticket_types(id) ON DELETE SET NULL,
    title text NOT NULL,
    url text NOT NULL,
    available_from timestamptz,
    available_until timestamptz,
    created_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recordings_event ON public.event_recordings (event_id);

CREATE TABLE IF NOT EXISTS public.event_lotteries (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    name text NOT NULL,
    opens_at timestamptz NOT NULL,
    closes_at timestamptz NOT NULL,
    draw_at timestamptz,
    quantity integer NOT NULL CHECK (quantity > 0),
    status text NOT NULL DEFAULT 'borrador'
        CHECK (status IN ('borrador','abierta','sorteada','cerrada')),
    terms text,
    created_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_lottery_entries (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lottery_id bigint NOT NULL REFERENCES public.event_lotteries(id) ON DELETE CASCADE,
    name text NOT NULL,
    email text NOT NULL,
    phone text,
    token text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (lottery_id, email)
);

CREATE TABLE IF NOT EXISTS public.event_lottery_winners (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lottery_id bigint NOT NULL REFERENCES public.event_lotteries(id) ON DELETE CASCADE,
    entry_id bigint NOT NULL UNIQUE REFERENCES public.event_lottery_entries(id) ON DELETE CASCADE,
    token text NOT NULL UNIQUE,
    reserved_until timestamptz,
    claimed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_rsvps (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    name text NOT NULL,
    email text NOT NULL,
    phone text,
    status text NOT NULL DEFAULT 'confirmada'
        CHECK (status IN ('confirmada','reconfirmar','cancelada')),
    token text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, email)
);

CREATE TABLE IF NOT EXISTS public.venue_profiles (
    venue_id bigint PRIMARY KEY REFERENCES public.venues(id) ON DELETE CASCADE,
    stage_width_m numeric(6,2),
    stage_depth_m numeric(6,2),
    load_in_start time,
    load_in_end time,
    sound_system text,
    lighting text,
    power text,
    capacity_notes text,
    technical_contact text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_link_checks (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    url text NOT NULL,
    kind text NOT NULL DEFAULT 'campana',
    status text NOT NULL CHECK (status IN ('ok','warn','fail')),
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    checked_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_archives (
    event_id bigint PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    headline text,
    summary text,
    photos jsonb NOT NULL DEFAULT '[]'::jsonb,
    video_url text,
    next_event_id bigint REFERENCES public.events(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
