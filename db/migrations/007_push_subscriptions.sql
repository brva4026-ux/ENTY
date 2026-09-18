-- Migración 007: notificaciones push Web Push (VAPID) para la puerta.
--
-- El portero activa "avisarme" en el escáner; el backend guarda la
-- suscripción del navegador y, cuando el admin abre puertas
-- (published -> live), envía una notificación a todos los dispositivos
-- de la venue. Sin servicios externos: Web Push estándar con claves VAPID.
--
-- 1 fila por (usuario, dispositivo): endpoint es único por navegador.
-- ON CONFLICT reemplaza las claves si el navegador renueva la suscripción.
-- ON DELETE SET NULL en user_id: el historial del dispositivo no bloquea
-- la eliminación definitiva de una cuenta.

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     bigint REFERENCES users(id) ON DELETE SET NULL,
    venue_id    bigint NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    endpoint    text   NOT NULL UNIQUE,
    p256dh      text   NOT NULL,
    auth        text   NOT NULL,
    user_agent  text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subs_venue ON push_subscriptions (venue_id);
CREATE INDEX IF NOT EXISTS idx_push_subs_user  ON push_subscriptions (user_id);
