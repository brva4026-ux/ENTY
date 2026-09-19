-- =============================================================================
-- Migración 016: protección contra fuerza bruta en /auth/login (lockout real).
--
-- Problema: el lockout previo vivía en un dict en memoria del proceso. En
-- serverless (Vercel) cada instancia lambda cuenta por su lado y el dict muere
-- en cada cold start: se puede martillar /auth/login sin castigo.
--
-- Solución: el contador vive en la DB, compartido por todas las instancias y
-- sobrevive cold starts. Dos cubos independientes (bloqueado si CUALQUIERA
-- llega al umbral de 8 fallos en 15 min, sliding window):
--   * email normalizado a minúsculas: anti martillo de una cuenta.
--   * IP (x-real-ip / x-forwarded-for): anti spray de muchas cuentas.
--
-- El éxito limpia SOLO el par (email, ip): nadie desbloquea a otro.
--
-- Trade-off documentado: una IP detrás de NAT comparte el cubo de IP (lo
-- bloquea un atacante de su misma red). Es el comportamiento estándar de
-- fail2ban y compañía; el cubo por email es el que protege la cuenta.
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS login_attempts (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email_norm text NOT NULL,
    ip         text NOT NULL DEFAULT 'unknown',
    at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts (email_norm, at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts (ip, at);

-- ¿Está bloqueado este intento? Solo lectura (y poda suave de la ventana).
CREATE OR REPLACE FUNCTION login_locked(
    p_email text,
    p_ip text,
    p_max_failures int DEFAULT 8,
    p_window_minutes int DEFAULT 15
)
RETURNS boolean
LANGUAGE sql
AS $$
    SELECT (
        SELECT count(*)
          FROM login_attempts
         WHERE email_norm = lower(p_email)
           AND at > now() - make_interval(mins => p_window_minutes)
    ) >= p_max_failures
    OR (
        SELECT count(*)
          FROM login_attempts
         WHERE ip = p_ip
           AND at > now() - make_interval(mins => p_window_minutes)
    ) >= p_max_failures;
$$;

-- Registra un intento fallido.
CREATE OR REPLACE FUNCTION register_login_failure(
    p_email text,
    p_ip text
)
RETURNS void
LANGUAGE sql
AS $$
    INSERT INTO login_attempts (email_norm, ip)
    VALUES (lower(p_email), p_ip);
$$;

-- El éxito limpia SOLO el par (email, ip): un atacante desde la misma IP no
-- desbloquea la cuenta de un usuario legitimo, ni viceversa.
CREATE OR REPLACE FUNCTION clear_login_failures(
    p_email text,
    p_ip text
)
RETURNS void
LANGUAGE sql
AS $$
    DELETE FROM login_attempts
     WHERE email_norm = lower(p_email) AND ip = p_ip;
$$;

-- Poda: la tabla solo guarda la ventana reciente. La llama register para que
-- no dependa de un cron (serverless no tiene).
CREATE OR REPLACE FUNCTION prune_login_attempts(
    p_window_minutes int DEFAULT 60
)
RETURNS void
LANGUAGE sql
AS $$
    DELETE FROM login_attempts
     WHERE at < now() - make_interval(mins => p_window_minutes);
$$;

-- =============================================================================
-- Prueba funcional con rollback total: si algo falla, revierte TODO (tabla,
-- funciones y datos de prueba) y el COMMIT no se ejecuta.
-- =============================================================================
DO $$
DECLARE
    v_email    text := 'bruteforce-test@example.com';
    v_ip       text := '203.0.113.77';   -- TEST-NET-2: nunca una IP real
    v_other_ip text := '198.51.100.1';   -- TEST-NET-2
BEGIN
    -- 7 fallos: debajo del umbral, no bloquea.
    FOR i IN 1..7 LOOP
        PERFORM register_login_failure(v_email, v_ip);
    END LOOP;
    IF login_locked(v_email, v_ip) THEN
        RAISE EXCEPTION 'TEST_FAIL locked_too_early';
    END IF;

    -- El 8vo fallo dispara el lockout.
    PERFORM register_login_failure(v_email, v_ip);
    IF NOT login_locked(v_email, v_ip) THEN
        RAISE EXCEPTION 'TEST_FAIL not_locked_after_8';
    END IF;

    -- La consulta de lockout es SOLO lectura (no infla el contador).
    IF (SELECT count(*) FROM login_attempts WHERE email_norm = v_email) <> 8 THEN
        RAISE EXCEPTION 'TEST_FAIL locked_query_writes';
    END IF;

    -- Un visitante legitimo (otro email, otra IP) no queda bloqueado.
    IF login_locked('legitimo@example.com', v_other_ip) THEN
        RAISE EXCEPTION 'TEST_FAIL innocent_locked';
    END IF;

    DELETE FROM login_attempts WHERE email_norm = v_email;

    -- Anti spray: 8 emails distintos desde la MISMA IP bloquean esa IP.
    FOR i IN 1..8 LOOP
        PERFORM register_login_failure('spray-' || i || '@example.com', v_ip);
    END LOOP;
    IF NOT login_locked('nuevo@example.com', v_ip) THEN
        RAISE EXCEPTION 'TEST_FAIL ip_lockout_missing';
    END IF;

    -- clear: borra solo el par exacto.
    PERFORM register_login_failure('pair@example.com', v_ip);
    PERFORM clear_login_failures('pair@example.com', v_ip);
    IF EXISTS (SELECT 1 FROM login_attempts WHERE email_norm = 'pair@example.com') THEN
        RAISE EXCEPTION 'TEST_FAIL clear_did_not_delete';
    END IF;

    RAISE NOTICE 'OK_TEST';

    -- Autolimpieza (por si el rollback no alcanzara): los emails de prueba
    -- nunca deben quedar en la tabla real.
    DELETE FROM login_attempts
     WHERE email_norm LIKE 'bruteforce-test%'
        OR email_norm LIKE 'spray-%@example.com'
        OR email_norm IN ('pair@example.com', 'nuevo@example.com', 'legitimo@example.com');
END $$;

COMMIT;
