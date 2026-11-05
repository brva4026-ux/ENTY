-- 037: fecha del ultimo cambio de contrasena.
--
-- Problema: el perfil ya dice desde cuando es miembro y cuando entro por
-- ultima vez, pero no hay forma de saber si la contrasena es la de siempre o
-- se cambio despues de un incidente. `updated_at` no sirve para esto: se mueve
-- al cambiar el nombre o el telefono, no solo la contrasena.
--
-- Decisiones:
--   * NULLABLE y SIN backfill. No sabemos cuando cambio la contrasena un
--     usuario existente; escribir `created_at` o `updated_at` seria inventar un
--     dato de seguridad ("tu contrasena se cambio hace 8 meses" cuando puede
--     que nunca se haya cambiado). NULL = sin registro, y el perfil no pinta la
--     linea. Es informacion honesta: se muestra lo que se sabe.
--   * Se escribe en los DOS caminos que cambian la contrasena: PATCH
--     /auth/change-password y POST /auth/reset-password (el de "olvide mi
--     contrasena"). Ambos ya bumpean `token_version` en la misma sentencia, asi
--     que la fecha viaja con la revocacion.
--   * Vive en `users` y no en una tabla de eventos: es estado actual ("cuando
--     fue la ultima vez"), no historial. Cuando haga falta el historial
--     completo sera su propia tabla, no una columna mas ancha.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;

COMMIT;
