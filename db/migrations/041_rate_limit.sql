-- =============================================================================
-- Migración 041: rate limiting REAL en serverless (el de memoria no limita).
--
-- Problema: `public.py` y `public_tickets.py` limitan por IP con un dict en
-- memoria del proceso. En serverless (Vercel) cada invocación puede caer en
-- una instancia distinta y el dict muere en cada cold start: los límites
-- "existen" en el código pero en producción no frenan nada. Es la misma falla
-- que la 016 arregló para /auth/login, ahora para el catálogo, el checkout
-- (dinero) y la imagen de boleta (CPU).
--
-- Solución: un contador genérico en la DB, compartido por todas las instancias
-- y que sobrevive cold starts. Una fila por impacto; la ventana se evalúa con
-- `at > now() - interval`. `rate_limit_hit` es atómico (una sola sentencia) y
-- devuelve true si el impacto ENTRA en el cupo, false si ya se pasó.
--
-- Trade-off (igual que 016): la poda la dispara el propio `rate_limit_hit` en
-- cada llamada (no hay cron en serverless), y la tabla se autolimita a la
-- ventana viva. El coste es un round-trip a la DB por petición limitada; a
-- cambio, el límite vale igual en todas las instancias.
--
-- Fail-open deliberado: si la DB no responde, los llamadores dejan pasar la
-- petición. Un límite es defensa en profundidad, no una llave que deje fuera a
-- usuarios legítimos por un incidente de infraestructura (mismo criterio que
-- `_login_locked`).
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS rate_limit_hits (
    id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key text NOT NULL,
    at  timestamptz NOT NULL DEFAULT now()
);

-- El índice sirve tanto a la ventana (key, at) como a la poda global (at).
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_key ON rate_limit_hits (key, at);
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_at ON rate_limit_hits (at);

-- Registra un impacto y dice si ENTRA en el cupo.
--   * true  -> permitido (se registró el impacto).
--   * false -> excedido (NO se registró: si contara, la ventana se llenaría de
--              los propios rechazos y el bloqueo se autoextendería sin fin).
-- La poda va en la MISMA sentencia que el conteo para que la tabla no crezca
-- sin cron: se borran las filas fuera de la ventana antes de evaluar.
CREATE OR REPLACE FUNCTION rate_limit_hit(
    p_key text,
    p_max_hits int,
    p_window_seconds int
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    v_count int;
BEGIN
    -- Poda perezosa: solo la ventana viva importa. El corte es por `at`, no por
    -- `key`: así también se limpian las claves de otros endpoints ya vencidas.
    DELETE FROM rate_limit_hits
     WHERE at < now() - make_interval(secs => p_window_seconds);

    SELECT count(*) INTO v_count
      FROM rate_limit_hits
     WHERE key = p_key
       AND at > now() - make_interval(secs => p_window_seconds);

    IF v_count >= p_max_hits THEN
        RETURN false;
    END IF;

    INSERT INTO rate_limit_hits (key) VALUES (p_key);
    RETURN true;
END;
$$;

-- Poda explícita (la usa el worker/tests; `rate_limit_hit` ya poda sola).
CREATE OR REPLACE FUNCTION prune_rate_limit_hits(
    p_window_seconds int DEFAULT 3600
)
RETURNS void
LANGUAGE sql
AS $$
    DELETE FROM rate_limit_hits
     WHERE at < now() - make_interval(secs => p_window_seconds);
$$;

-- =============================================================================
-- Prueba funcional con rollback total: si algo falla, revierte TODO y el
-- COMMIT no se ejecuta.
-- =============================================================================
DO $$
DECLARE
    v_key text := 'test:rate:041:' || txid_current()::text;
    i     int;
BEGIN
    -- Los primeros 3 impactos entran; el 4to (cupo 3) ya no.
    FOR i IN 1..3 LOOP
        IF NOT rate_limit_hit(v_key, 3, 60) THEN
            RAISE EXCEPTION 'TEST_FAIL blocked_too_early_at_%', i;
        END IF;
    END LOOP;
    IF rate_limit_hit(v_key, 3, 60) THEN
        RAISE EXCEPTION 'TEST_FAIL not_blocked_after_cap';
    END IF;

    -- Un rechazo NO se registra: si contara, la ventana se autoextendería.
    IF (SELECT count(*) FROM rate_limit_hits WHERE key = v_key) <> 3 THEN
        RAISE EXCEPTION 'TEST_FAIL rejected_hit_was_counted';
    END IF;

    -- Otra clave no se ve afectada por esta.
    IF NOT rate_limit_hit(v_key || ':other', 1, 60) THEN
        RAISE EXCEPTION 'TEST_FAIL key_isolation_broken';
    END IF;

    -- Ventana 0: todo impacto queda fuera de la ventana -> siempre permite.
    IF NOT rate_limit_hit(v_key, 1, 0) THEN
        RAISE EXCEPTION 'TEST_FAIL zero_window_should_allow';
    END IF;

    DELETE FROM rate_limit_hits WHERE key LIKE v_key || '%';
    RAISE NOTICE 'OK_TEST';
END $$;

COMMIT;
