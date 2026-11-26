-- 073: mudarse a Enty sin empezar de cero.
-- Importación guiada, deduplicación de reimportaciones y bitácora de lotes.

BEGIN;

CREATE TABLE IF NOT EXISTS public.import_batches (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    event_id bigint REFERENCES public.events(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('events','guests')),
    filename text NOT NULL,
    total_rows integer NOT NULL DEFAULT 0,
    imported_rows integer NOT NULL DEFAULT 0,
    duplicate_rows integer NOT NULL DEFAULT 0,
    error_rows integer NOT NULL DEFAULT 0,
    created_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_batches_venue
    ON public.import_batches (venue_id, created_at DESC);

-- Una huella por registro ya cargado. La huella no guarda PII: es el
-- SHA-256 de la clave natural (evento+fecha, o evento+correo/teléfono).
CREATE TABLE IF NOT EXISTS public.imported_records (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('events','guests')),
    fingerprint text NOT NULL,
    record_id bigint,
    batch_id bigint REFERENCES public.import_batches(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (venue_id, kind, fingerprint)
);

CREATE TABLE IF NOT EXISTS public.import_rows (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id bigint NOT NULL REFERENCES public.import_batches(id) ON DELETE CASCADE,
    row_number integer NOT NULL,
    status text NOT NULL CHECK (status IN ('imported','duplicate','error')),
    message text,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    record_id bigint
);
CREATE INDEX IF NOT EXISTS idx_import_rows_batch
    ON public.import_rows (batch_id, row_number);

COMMIT;
