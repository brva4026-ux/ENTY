-- 017: tokens de reset de contraseña (recuperación self-service).
--
-- Hoy "olvidé mi contraseña" significa "que un admin me la resetee": para el
-- dueño de un bar que contrata y rota promotores cada mes, eso es soporte
-- manual semanal. Con email transaccional (Resend) el flujo estándar es:
--   1) el usuario pide reset -> fila aquí + link por correo
--   2) abre el link -> POST /auth/reset-password con el token + la nueva
--
-- El token crudo NUNCA se guarda (misma filosofía que tickets.token_hash):
-- solo el sha256. Si la DB se filtra, los tokens no son reutilizables.
-- Un solo uso: al consumirse, la fila muere (used_at). Ventana de 60 minutos.

BEGIN;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text   NOT NULL UNIQUE,          -- sha256 del token crudo
    expires_at  timestamptz NOT NULL,             -- now() + 60 min
    used_at     timestamptz,                      -- NOT NULL = consumido
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- Trazabilidad mínima sin exponer nada: desde qué IP se pidió.
    request_ip  text
);

-- Lookup por token en el canje: único acceso caliente de la tabla.
CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_token_hash
    ON password_reset_tokens (token_hash);

-- Poda: tokens de un usuario activo (un nuevo pedido invalida los anteriores
-- a nivel lógico en el endpoint) y limpieza general de viejos.
CREATE INDEX IF NOT EXISTS idx_password_reset_user
    ON password_reset_tokens (user_id, created_at DESC);

-- Prueba funcional con rollback: crear, marcar usado, podar.
DO $$
DECLARE
    v_user  bigint;
    v_hash  text;
    v_count int;
BEGIN
    -- usuario efímero sin venue: no toca datos de negocio
    INSERT INTO users (email, password_hash, full_name)
    VALUES ('mig017-test@example.invalid', 'x', 'Mig 017 Test')
    RETURNING id INTO v_user;

    v_hash := encode(digest('token-de-prueba-017', 'sha256'), 'hex');
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (v_user, v_hash, now() + interval '60 minutes');

    -- consumir
    UPDATE password_reset_tokens SET used_at = now()
     WHERE token_hash = v_hash AND used_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'OK_TEST: consumo de token fallo';
    END IF;

    -- podar: todo lo viejo/consumido de este usuario
    DELETE FROM password_reset_tokens WHERE user_id = v_user;
    SELECT count(*) INTO v_count FROM password_reset_tokens WHERE user_id = v_user;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'OK_TEST: poda fallo';
    END IF;

    DELETE FROM users WHERE id = v_user;
EXCEPTION
    WHEN OTHERS THEN
        DELETE FROM users WHERE id = v_user;
        RAISE;
END $$;

COMMIT;
