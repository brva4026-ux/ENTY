-- 040: negocio activo del usuario (multi-negocio).
--
-- Problema (Ley de Tesler, T7): la preferencia "con que negocio abren mis
-- paneles" vivia SOLO en localStorage (`tf_venue`, lib/venue.js). localStorage
-- es por NAVEGADOR: el mismo admin que trabaja con dos bares elegia el bar A
-- en la laptop y, al entrar desde el celular, los paneles abrian con el bar B
-- (la primera venue por defecto). La eleccion es de la PERSONA, no del
-- dispositivo, y habia que volver a hacerla en cada equipo.
--
-- Decisiones:
--   * Columna propia en `users` y NO una fila en `user_preferences`. La 032
--     lo anticipo: aquella tabla es por (usuario, venue) —la clave describe
--     una preferencia DE un negocio— y `venue_id` es NOT NULL a proposito. El
--     negocio activo es una preferencia GLOBAL del usuario; meterla ahi
--     exigiria relajar esa columna con NULLs. "Cuando aparezca una global de
--     verdad se agrega una columna propia" (mig 032).
--   * NULLABLE y SIN backfill: no se inventa un negocio activo para quien
--     nunca lo eligio. NULL = "usa el primero disponible", que es el mismo
--     default de hoy. El frontend cae al primer venue de sus roles.
--   * ON DELETE SET NULL: si borran el negocio activo, la persona no queda
--     apuntando a un id fantasma (que haria 403 todo panel); vuelve al default.
--   * No se toca el CHECK de `user_preferences.key` (mig 039): esa tabla
--     sigue siendo la de las preferencias por negocio.
--
-- Tema, movimiento y los datos del fan (favoritos/contacto) NO se mueven aqui
-- a proposito; el porque esta en docs/ley-de-tesler.md (T7): el tema y el
-- movimiento son del DISPOSITIVO (se aplican antes del primer paint y siguen
-- al sistema operativo), y el fan no tiene identidad verificada en el servidor
-- hasta reclamar una boleta — guardar sus favoritos contra un contacto sin
-- verificar seria almacenar datos personales de un anonimo, no mover
-- complejidad al sistema.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS active_venue_id bigint;

-- La FK va en su propia sentencia con guarda: `ADD COLUMN IF NOT EXISTS ...
-- REFERENCES` no agrega la referencia cuando la columna ya existe, y en una
-- instalacion nueva (schema.sql) la columna ya viene creada. Sin esta guarda
-- la migracion seria un no-op incompleto (columna sin FK) y el test de drift
-- lo delataria.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'users_active_venue_id_fkey'
           AND conrelid = 'users'::regclass
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_active_venue_id_fkey
            FOREIGN KEY (active_venue_id) REFERENCES venues(id)
            ON DELETE SET NULL;
    END IF;
END $$;

COMMIT;
