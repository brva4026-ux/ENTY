-- 032: preferencias de usuario por negocio.
--
-- Problema: la guia de primeros pasos guardaba su decision en localStorage
-- (`tf_onboarding:<venue>`). localStorage es por NAVEGADOR, no por persona:
--
--   * el mismo admin que ya dijo "Lo hago solo" en la laptop volvia a ver la
--     invitacion en el celular (o en incognito, o al borrar datos), y
--   * el dominio de preview y el de produccion en Vercel son origenes
--     distintos, asi que el preview "olvidaba" la decision de produccion.
--
-- Resultado: una guia que el usuario ya habia rechazado reaparecia sola, que
-- es exactamente lo que no debe pasar.
--
-- Decisiones:
--   * La preferencia vive en la DB, por (usuario, venue). Por USUARIO y no
--     por venue: si mañana entra un socio al equipo, cada uno decide lo suyo
--     sobre su propia guia.
--   * Tabla clave-valor generica (`user_preferences`) y no una columna por
--     preferencia: la proxima preferencia (densidad, tutorial visto, etc.) no
--     necesita otra migracion.
--   * `key` con CHECK cerrado: la tabla es del producto, no un cajon donde
--     cualquier string entre a la DB.
--   * ON DELETE CASCADE en ambas FK: borrar un usuario o un negocio no debe
--     dejar preferencias huerfanas.
--   * `venue_id` NOT NULL: todas las preferencias de hoy son por negocio
--     (la guia es por venue). Cuando aparezca una global de verdad se agrega
--     una columna propia, no se relaja esta con NULLs.

BEGIN;

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    venue_id   bigint NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    key        text NOT NULL
        CHECK (key IN ('onboarding', 'tutorial')),
    -- Estado de la preferencia. El CHECK de valores depende de la clave:
    -- 'onboarding'/'tutorial' comparten los mismos cuatro estados.
    value      text NOT NULL
        CHECK (value IN ('pending', 'accepted', 'dismissed', 'completed')),
    -- Posicion del tutorial en curso (paso 1..N) y de la guia: permite
    -- retomarlo donde quedo tras cerrar la app. NULL = sin progreso.
    step       integer CHECK (step IS NULL OR step >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, venue_id, key)
);

-- El panel pide TODAS las preferencias del usuario en un negocio de una sola
-- lectura (GET /me/preferences): el indice cubre ese acceso por la PK, asi
-- que no hace falta uno adicional para ese patron. Este otro sirve al caso
-- inverso, poco frecuente pero real: saber cuanta gente de un negocio ya
-- completo la guia (reporte interno), que filtra por venue sin usuario.
CREATE INDEX IF NOT EXISTS idx_user_preferences_venue
    ON user_preferences (venue_id, key);

COMMIT;
