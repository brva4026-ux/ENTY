-- =============================================================================
-- Migración 064: Puerta como espacio operativo.
--
--  * Un puesto (Acceso VIP, General…) con un teléfono activo por puesto.
--  * El link de puerta se convierte en una autorización de DISPOSITIVO:
--    se canjea una vez, devuelve un token de dispositivo y el servidor lo
--    exige en cada operación. Relevar o revocar mata ese token.
--  * Incidencias compartidas por evento: Puerta, Administración y Promotor
--    trabajan sobre el mismo expediente, con comentarios y estados.
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) El puesto asignado en la noche y en el link.
-- ---------------------------------------------------------------------------
ALTER TABLE public.event_staff
    ADD COLUMN IF NOT EXISTS door_name text,
    ADD COLUMN IF NOT EXISTS door_ticket_type_id bigint
        REFERENCES public.ticket_types(id) ON DELETE SET NULL;

ALTER TABLE public.event_access_tokens
    ADD COLUMN IF NOT EXISTS door_name text,
    ADD COLUMN IF NOT EXISTS ticket_type_id bigint
        REFERENCES public.ticket_types(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS phone text;

-- ---------------------------------------------------------------------------
-- 2) Dispositivo autorizado de un puesto.
--
-- El token en claro nunca se guarda: solo SHA-256. `status='active'` es la
-- única autorización que el servidor acepta; un reemplazo o una revocación
-- cambia el estado en la misma transacción. El índice único parcial es la
-- regla del piloto: un teléfono activo por puesto.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_door_devices (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    door_name text,
    ticket_type_id bigint REFERENCES public.ticket_types(id) ON DELETE SET NULL,
    phone text,
    token_hash text NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'active',
    created_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    activated_at timestamp with time zone,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    replaced_by_device_id bigint REFERENCES public.event_door_devices(id) ON DELETE SET NULL,
    last_seen_at timestamp with time zone,
    CONSTRAINT event_door_devices_status_check
        CHECK (status IN ('active', 'revoked', 'replaced'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_door_device_active
    ON public.event_door_devices (event_id, lower(door_name))
    WHERE status = 'active' AND door_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_door_devices_event
    ON public.event_door_devices (event_id, status);

CREATE INDEX IF NOT EXISTS idx_event_door_devices_user
    ON public.event_door_devices (user_id, status);

-- ---------------------------------------------------------------------------
-- 3) Relevo de turno.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.door_shift_requests (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    device_id bigint REFERENCES public.event_door_devices(id) ON DELETE SET NULL,
    requested_by bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    requested_phone text,
    reason text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    reviewed_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at timestamp with time zone,
    review_note text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT door_shift_requests_status_check
        CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_door_shift_requests_event
    ON public.door_shift_requests (event_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4) Incidencias compartidas.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.door_incidents (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    device_id bigint REFERENCES public.event_door_devices(id) ON DELETE SET NULL,
    created_by bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    ticket_id bigint REFERENCES public.tickets(id) ON DELETE SET NULL,
    ticket_ref text,
    door_name text,
    reason text NOT NULL,
    note text,
    status text NOT NULL DEFAULT 'open',
    promoter_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
    promoter_access boolean NOT NULL DEFAULT false,
    assigned_admin_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
    resolution_guidance text,
    status_changed_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    status_changed_at timestamp with time zone,
    client_request_id text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    resolved_at timestamp with time zone,
    resolved_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT door_incidents_status_check
        CHECK (status IN ('open', 'reviewing', 'resolved'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_door_incident_client_request
    ON public.door_incidents (created_by, client_request_id)
    WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_door_incidents_event
    ON public.door_incidents (event_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_door_incidents_promoter
    ON public.door_incidents (promoter_id, event_id, created_at DESC)
    WHERE promoter_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.door_incident_comments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    incident_id bigint NOT NULL REFERENCES public.door_incidents(id) ON DELETE CASCADE,
    author_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    author_role text NOT NULL,
    body text NOT NULL,
    channel text NOT NULL DEFAULT 'note',
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT door_incident_comments_channel_check
        CHECK (channel IN ('note', 'call', 'whatsapp', 'status'))
);

CREATE INDEX IF NOT EXISTS idx_door_incident_comments_incident
    ON public.door_incident_comments (incident_id, created_at);

-- ---------------------------------------------------------------------------
-- 5) Nuevos avisos de la campana. La restricción es la lista completa:
--    reemplazarla (no sumar) evita dejar fuera un kind histórico.
-- ---------------------------------------------------------------------------
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN (
        'payout_created', 'payout_reviewed', 'payout_disputed',
        'invitation_accepted', 'ticket_reissued', 'ticket_returned',
        'waitlist_offered', 'payment_approved', 'event_autoclosed',
        'door_anomaly', 'capacity_alert', 'event_reminder',
        'ticket_refunded', 'door_open',
        'event_assigned', 'allocation_changed', 'sales_closed',
        'door_incident_opened', 'door_incident_updated',
        'door_incident_resolved', 'door_shift_requested',
        'door_shift_changed', 'door_device_revoked'
    ));

COMMIT;
