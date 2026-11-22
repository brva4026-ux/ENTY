-- 058: usuario universal y espacio de trabajo con identidad propia.
--
-- El usuario identifica a la PERSONA y se genera en el servidor al crear la
-- cuenta. El nombre del negocio identifica su espacio de trabajo y se edita
-- aparte. Una cuenta sin negocio recibe "Mi organización" como nombre interno,
-- marcado con `is_placeholder` para que las superficies públicas no lo
-- publiquen hasta que la persona configure su identidad.
--
-- Compatibilidad:
--   * No se toca ningún id, rol ni asignación.
--   * Las cuentas existentes con `username` lo conservan.
--   * Las cuentas existentes sin `username` reciben uno derivado de su nombre
--     completo (nunca del correo). Si el nombre no produce una base válida se
--     usa "usuario" y se prueban variantes.
--   * `welcome_seen_at` se agrega solo la primera vez y marca a las cuentas ya
--     existentes como vistas; las cuentas nuevas nacen con NULL para que el
--     panel muestre la bienvenida una vez.

BEGIN;

ALTER TABLE venues
    ADD COLUMN IF NOT EXISTS is_placeholder boolean DEFAULT false NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'users'
           AND column_name = 'welcome_seen_at'
    ) THEN
        ALTER TABLE users ADD COLUMN welcome_seen_at timestamp with time zone;
        -- Las cuentas que ya existían no deben ver la bienvenida de alta.
        UPDATE users SET welcome_seen_at = now();
    END IF;
END $$;

-- Backfill de usernames legados. La normalización replica la del backend:
-- minúsculas, sin tildes, separadores válidos, 3..32 caracteres.
DO $$
DECLARE
    r record;
    base text;
    candidate text;
    n integer;
BEGIN
    FOR r IN
        SELECT id, coalesce(full_name, '') AS full_name
          FROM users
         WHERE username IS NULL
         ORDER BY id
    LOOP
        base := lower(translate(r.full_name,
            'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'));
        base := regexp_replace(base, '[^a-z0-9._-]+', '.', 'g');
        base := regexp_replace(base, '[._-]{2,}', '.', 'g');
        base := btrim(base, '._-');
        IF length(base) < 3 THEN
            base := 'usuario';
        END IF;
        base := left(base, 32);
        base := btrim(base, '._-');
        IF base = '' THEN
            base := 'usuario';
        END IF;

        candidate := base;
        n := 1;
        WHILE EXISTS (
            SELECT 1 FROM users u
             WHERE u.username IS NOT NULL
               AND lower(u.username) = lower(candidate)
        ) LOOP
            n := n + 1;
            candidate := left(base, 32 - length('-' || n)) || '-' || n;
        END LOOP;

        UPDATE users SET username = candidate WHERE id = r.id;
    END LOOP;
END $$;

COMMIT;
