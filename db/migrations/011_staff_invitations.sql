-- 011: invitaciones de personal por enlace de un solo uso (patrón unicall-blue).
--
-- Problema que resuelve: el alta de personal exigía que el admin INVENTARA
-- la contraseña de cada promotor/portero (y se la pasara por WhatsApp).
-- Con invitaciones, el admin genera un enlace y cada persona crea SU propia
-- contraseña: el admin nunca la conoce.
--
-- Decisiones de seguridad:
-- - token_hash: el token viaja en la URL pero en la DB solo vive su hash
--   SHA-256 (misma disciplina que las contraseñas). Una DB filtrada no
--   produce enlaces válidos.
-- - Un solo uso ATÓMICO: la aceptación hace UPDATE ... WHERE accepted_at IS
--   NULL — dos pestañas no canjean el mismo enlace dos veces.
-- - Expira (default 72 h) y el admin puede revocar en cualquier momento:
--   un enlace filtrado deja de servir con un clic.
-- - El email va ligado a la invitación: el enlace no se canjea con otro correo.

CREATE TABLE IF NOT EXISTS staff_invitations (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id         bigint NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    role             text   NOT NULL CHECK (role IN ('promotor', 'bouncer', 'admin')),
    full_name        text   NOT NULL,
    email            text   NOT NULL,
    token_hash       text   NOT NULL UNIQUE,
    expires_at       timestamptz NOT NULL,
    accepted_at      timestamptz,
    accepted_user_id bigint REFERENCES users(id),
    created_by       bigint NOT NULL REFERENCES users(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    revoked_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_invitations_venue_open
    ON staff_invitations (venue_id)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;
