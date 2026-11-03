-- 035: nombre de usuario para entrar.
--
-- Problema: hoy el login exige un correo valido (`LoginRequest.email` tiene
-- pattern de email) y la gente de puerta y taquilla entra desde el celular, con
-- el correo del negocio que muchas veces no recuerda o no es suyo. Escribir
-- "puerta@bar.test" en un teclado de telefono es friccion pura en el momento
-- mas caliente del dia.
--
-- Decisiones:
--   * `username` es NULLABLE. Un usuario existente no tiene por que elegir uno
--     y la columna no puede bloquear el alta: quien ya entra con correo sigue
--     igual, sin migracion de datos obligatoria.
--   * Se guarda en MINUSCULAS y con un unico indice sobre `lower(username)`.
--     Un indice unico comun dejaria entrar "Admin" y "admin" como usuarios
--     distintos, que es justo la confusion que queremos evitar.
--   * CHECK de formato: sin espacios, 3..32 caracteres, [a-z0-9._-]. Es la
--     misma regla que valida el backend, puesta tambien en la DB para que un
--     INSERT manual o un seed no puedan dejar un username imparable.
--   * Backfill: a los usuarios existentes se les propone la parte local del
--     correo ("puerta@bar.test" -> "puerta") SOLO si esta libre. Los que
--     colisionan quedan con NULL y conservan el login por correo; no se
--     inventan sufijos porque el usuario no eligio ese nombre.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS username text;

-- El constraint se recrea (DROP IF EXISTS + ADD) para que re-aplicar la
-- migracion sobre un schema.sql que ya lo trae consolidado sea un no-op: un
-- ADD CONSTRAINT pelado falla con "constraint already exists" y el drift test
-- re-aplica TODAS las migraciones encima de schema.sql.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_format;

ALTER TABLE users
    ADD CONSTRAINT users_username_format
    CHECK (
        username IS NULL
        OR (
            username = lower(username)
            AND username ~ '^[a-z0-9._-]{3,32}$'
        )
    );

-- Un unico username en toda la tabla, comparando sin distinguir mayusculas.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key
    ON users (lower(username))
    WHERE username IS NOT NULL;

-- Backfill conservador: la parte local del correo, solo cuando no choca.
UPDATE users u
   SET username = lower(split_part(u.email, '@', 1))
 WHERE u.username IS NULL
   AND split_part(u.email, '@', 1) ~ '^[a-zA-Z0-9._-]{3,32}$'
   AND NOT EXISTS (
       SELECT 1 FROM users o
        WHERE o.id <> u.id
          AND lower(split_part(o.email, '@', 1)) = lower(split_part(u.email, '@', 1))
   );

COMMIT;
