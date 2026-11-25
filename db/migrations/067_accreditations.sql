-- 067: acreditaciones de prensa, artistas y producción.
--
-- Una acreditación NO es una boleta: no consume aforo, no se vende y no
-- aparece en la caja. Es un pase operativo con su propia vigencia, zona y
-- número de ingresos permitidos. La puerta lo escanea con el mismo lector;
-- el token se guarda solo como SHA-256, igual que el QR de una boleta.

CREATE TABLE IF NOT EXISTS public.event_accreditations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    holder_name text NOT NULL,
    holder_email text,
    holder_phone text,
    category text NOT NULL DEFAULT 'invitado',
    zone text,
    valid_from timestamp with time zone NOT NULL DEFAULT now(),
    valid_until timestamp with time zone,
    entries_allowed integer NOT NULL DEFAULT 1,
    entries_used integer NOT NULL DEFAULT 0,
    token_hash text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    issued_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    revoked_at timestamp with time zone,
    CONSTRAINT event_accreditations_category_check CHECK (
        category IN ('prensa', 'artista', 'produccion', 'patrocinador', 'invitado')
    ),
    CONSTRAINT event_accreditations_status_check CHECK (
        status IN ('active', 'revoked')
    ),
    CONSTRAINT event_accreditations_entries_check CHECK (
        entries_allowed BETWEEN 1 AND 50 AND entries_used BETWEEN 0 AND entries_allowed
    ),
    CONSTRAINT event_accreditations_window_check CHECK (
        valid_until IS NULL OR valid_until > valid_from
    ),
    CONSTRAINT event_accreditations_token_hash_key UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_event_accreditations_event
    ON public.event_accreditations (event_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_accreditations_venue
    ON public.event_accreditations (venue_id, event_id);
