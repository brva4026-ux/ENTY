-- 059: perfil completo, contactos con permiso explícito, sesiones y avisos.
--
-- Objetivos:
--   * El contacto del negocio deja de publicarse por existir: publicar exige
--     una autorización explícita y canales elegidos. Los contactos que ya
--     estaban publicados se conservan (backfill único) para no romper fichas.
--   * La persona puede compartir (o no) su contacto personal con el equipo.
--   * Sesiones individuales: permiten listar dispositivos y revocar uno sin
--     cerrar todos. El token sigue siendo la credencial; se guarda su hash.
--   * Actividad de seguridad real para el perfil.
--   * Verificación de correo nuevo antes de activarlo.
--   * Estado de registro push por dispositivo (last_seen_at) y aviso de puerta
--     en la campana interna.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Contacto personal de la persona (además del teléfono ya existente).
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_contact_with_team boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2) Contacto del negocio: canales + autorización de publicación.
--    El backfill corre UNA vez, cuando nacen las columnas. Si la migración se
--    re-ejecuta, no vuelve a encender un contacto que la persona apagó.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'venues'
           AND column_name = 'public_contact_enabled'
    ) THEN
        ALTER TABLE venues ADD COLUMN public_contact_enabled boolean NOT NULL DEFAULT false;
        ALTER TABLE venues ADD COLUMN public_contact_channels text[] NOT NULL DEFAULT '{}';
        ALTER TABLE venues ADD COLUMN contact_team_visible boolean NOT NULL DEFAULT true;
        ALTER TABLE venues ADD COLUMN contact_email text;

        -- Publicaciones intencionales existentes: conservarlas tal cual.
        UPDATE venues
           SET public_contact_enabled = true,
               public_contact_channels = ARRAY['whatsapp']::text[]
         WHERE contact_phone IS NOT NULL
           AND btrim(contact_phone) <> '';
    END IF;
END $$;

ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact_email text;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact_team_visible boolean NOT NULL DEFAULT true;

ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_public_contact_channels_check;
ALTER TABLE venues ADD CONSTRAINT venues_public_contact_channels_check
    CHECK (public_contact_channels <@ ARRAY['whatsapp', 'email']::text[]);

-- ---------------------------------------------------------------------------
-- 3) Sesiones individuales. token_hash = SHA-256 del JWT crudo; el token
--    nunca se guarda. La fila se crea en el login y se reutiliza en cada
--    request. Revocar = revoked_at.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_sessions (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_hash  text NOT NULL UNIQUE,
    user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_agent  text,
    ip          text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active
    ON user_sessions (user_id, last_seen_at DESC)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4) Actividad de seguridad visible para la persona.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security_events (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       text NOT NULL,
    detail     text,
    ip         text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_events_user
    ON security_events (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5) Verificación del correo nuevo: un solo uso, vence en 24 h.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_change_tokens (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    new_email  text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_change_tokens_user
    ON email_change_tokens (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 6) Push: última confirmación de registro por dispositivo.
-- ---------------------------------------------------------------------------
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------------
-- 7) "Puerta abierta" entra al catálogo de la campana interna.
-- ---------------------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN (
        'payout_created', 'payout_reviewed', 'payout_disputed',
        'invitation_accepted', 'ticket_reissued', 'ticket_returned',
        'waitlist_offered', 'payment_approved', 'event_autoclosed',
        'door_anomaly', 'capacity_alert', 'event_reminder',
        'ticket_refunded', 'door_open'
    ));

COMMIT;
