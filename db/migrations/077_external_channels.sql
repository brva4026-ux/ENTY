-- 077: canal invitado para operar la puerta de boletas vendidas fuera de Enty.
--
-- El piloto no integra una API de terceros todavia: importa las boletas por
-- CSV/JSON, las trata como boletas propias para el escaner y conserva su
-- origen. La conciliacion se hace por canal, no contra un contador global.
--
-- Decisiones:
--   * Cada canal crea una localidad tecnica oculta (`ticket_types.is_external`).
--     Asi las boletas externas ocupan aforo pero no consumen el inventario que
--     Enty vende al publico.
--   * Las boletas externas son filas de `tickets` con `origin='external'`:
--     heredan QR, snapshot offline, redenciones, aforo e incidencias sin
--     duplicar la puerta.
--   * El token crudo nunca se guarda; se guarda su SHA-256 como en Enty.
--   * Un solo responsable de confirmacion por canal evita conteos dobles.

CREATE TABLE IF NOT EXISTS public.event_external_channels (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    ticket_type_id bigint NOT NULL REFERENCES public.ticket_types(id) ON DELETE RESTRICT,
    name text NOT NULL,
    provider_name text NOT NULL,
    confirmation_owner text NOT NULL DEFAULT 'enty'
        CHECK (confirmation_owner IN ('enty', 'provider', 'shared')),
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'closed')),
    created_by_user_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_external_channel_name
    ON public.event_external_channels (event_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_event_external_channels_event
    ON public.event_external_channels (event_id, status);

ALTER TABLE public.ticket_types
    ADD COLUMN IF NOT EXISTS is_external boolean NOT NULL DEFAULT false;

ALTER TABLE public.tickets
    ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'enty',
    ADD COLUMN IF NOT EXISTS external_channel_id bigint
        REFERENCES public.event_external_channels(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS external_ticket_id text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tickets_origin_check'
           AND conrelid = 'public.tickets'::regclass
    ) THEN
        ALTER TABLE public.tickets
            ADD CONSTRAINT tickets_origin_check
            CHECK (origin IN ('enty', 'external'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tickets_external_pair_check'
           AND conrelid = 'public.tickets'::regclass
    ) THEN
        ALTER TABLE public.tickets
            ADD CONSTRAINT tickets_external_pair_check
            CHECK (
                (origin = 'enty' AND external_channel_id IS NULL
                    AND external_ticket_id IS NULL)
                OR
                (origin = 'external' AND external_channel_id IS NOT NULL
                    AND external_ticket_id IS NOT NULL)
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tickets_external_ticket_key'
           AND conrelid = 'public.tickets'::regclass
    ) THEN
        ALTER TABLE public.tickets
            ADD CONSTRAINT tickets_external_ticket_key
            UNIQUE (external_channel_id, external_ticket_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tickets_external_channel
    ON public.tickets (external_channel_id, status)
    WHERE external_channel_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.external_ticket_imports (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id bigint NOT NULL
        REFERENCES public.event_external_channels(id) ON DELETE CASCADE,
    imported_by_user_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
    filename text,
    rows_total integer NOT NULL,
    rows_imported integer NOT NULL,
    rows_updated integer NOT NULL,
    rows_skipped integer NOT NULL,
    errors jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_external_ticket_imports_channel
    ON public.external_ticket_imports (channel_id, created_at DESC);

ALTER TABLE public.event_external_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_ticket_imports ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON TABLE public.event_external_channels, public.external_ticket_imports FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL ON TABLE public.event_external_channels, public.external_ticket_imports FROM authenticated';
    END IF;
END $$;
