-- =============================================================================
-- Migración 046: retención — las tablas que crecen sin límite ahora se podan.
--
-- Problema: cinco tablas acumulan filas para siempre y ninguna tiene política
-- de borrado. En un plan de Supabase acotado, `analytics_events` y
-- `notifications` son las que primero llenan el disco; `push_outbox` marca
-- `processed_at` pero nunca borra la fila procesada; `audit_log` y
-- `door_sync_receipts` tampoco tienen tope. Sólo `login_attempts` (mig 016) y
-- `rate_limit_hits` (mig 041) se podaban, ambas con el patrón "poda perezosa":
-- sin cron en serverless, la propia llamada limpia la ventana vieja.
--
-- Solución: una función `prune_*` por tabla, cada una con una retención por
-- defecto sensata, y un único punto de entrada `prune_expired()` que las llama
-- todas. Se invoca de forma perezosa desde rutas que ya se visitan (mismo
-- criterio que `prune_login_attempts` en /auth/login y `rate_limit_hit` en
-- cada impacto). No hay cron: la poda ocurre cuando alguien pasa por una ruta
-- instrumentada, que en producción es constantemente.
--
-- Por qué por ANTIgüedad y no por "procesado":
--   * `push_outbox`: una fila procesada se borra pasado un margen amplio (7 d);
--     el margen deja ventana para diagnosticar entregas recientes.
--   * `notifications`: se borran SOLO las ya leídas y viejas (90 d). Una no
--     leída es trabajo pendiente del usuario: borrarla sería perder el aviso.
--   * `audit_log` (365 d) y `door_sync_receipts` (30 d): la ventana de
--     idempotencia del sync de puerta es de horas, no de meses.
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- Recibos idempotentes del sync offline de puerta (mig 034). La deduplicación
-- sólo importa mientras el escáner puede reenviar su cola (horas); 30 días
-- sobra. La PK es (event_id, scan_id), así que la poda por `created_at` no
-- rompe la unicidad de la ventana viva.
CREATE OR REPLACE FUNCTION prune_door_sync_receipts(
    p_days int DEFAULT 30
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    v_deleted bigint;
BEGIN
    DELETE FROM door_sync_receipts
     WHERE created_at < now() - make_interval(days => p_days);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- Bandeja de salida de push (mig 014). Sólo se podan las YA PROCESADAS: una
-- pendiente (processed_at IS NULL) es trabajo del worker y no se toca. El
-- margen de 7 días deja ventana para diagnosticar una entrega reciente.
CREATE OR REPLACE FUNCTION prune_push_outbox(
    p_days int DEFAULT 7
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    v_deleted bigint;
BEGIN
    DELETE FROM push_outbox
     WHERE processed_at IS NOT NULL
       AND processed_at < now() - make_interval(days => p_days);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- Avisos in-app (mig 012). Sólo se podan los LEÍDOS y viejos: una notificación
-- no leída es trabajo pendiente del usuario y borrarla perdería el aviso. El
-- borrado cae en cascada sobre `push_outbox` (FK ON DELETE CASCADE), que ya
-- se poda por su cuenta.
CREATE OR REPLACE FUNCTION prune_notifications(
    p_days int DEFAULT 90
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    v_deleted bigint;
BEGIN
    DELETE FROM notifications
     WHERE read_at IS NOT NULL
       AND created_at < now() - make_interval(days => p_days);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- Eventos de producto (mig 031). El embudo sólo mira una ventana de 90 días
-- (`/venues/{id}/funnel`), así que conservar más es peso muerto. Retención
-- 180 d: el doble de la ventana consultada, por si se pide un rango amplio.
CREATE OR REPLACE FUNCTION prune_analytics_events(
    p_days int DEFAULT 180
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    v_deleted bigint;
BEGIN
    DELETE FROM analytics_events
     WHERE created_at < now() - make_interval(days => p_days);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- Bitácora de auditoría. Es el registro legal/operativo, así que la retención
-- es la más larga (365 d). Se poda por antigüedad; si en el futuro una
-- obligación exige más, se sube el default sin cambiar el llamador.
CREATE OR REPLACE FUNCTION prune_audit_log(
    p_days int DEFAULT 365
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    v_deleted bigint;
BEGIN
    DELETE FROM audit_log
     WHERE created_at < now() - make_interval(days => p_days);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- Punto de entrada único: poda todo con los defaults. Devuelve el total de
-- filas borradas (útil en logs/tests). Un solo round-trip para el llamador.
CREATE OR REPLACE FUNCTION prune_expired()
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    v_total bigint := 0;
BEGIN
    v_total := v_total + prune_door_sync_receipts();
    v_total := v_total + prune_push_outbox();
    v_total := v_total + prune_notifications();
    v_total := v_total + prune_analytics_events();
    v_total := v_total + prune_audit_log();
    RETURN v_total;
END;
$$;

-- =============================================================================
-- Prueba funcional con rollback total: si algo falla, revierte TODO y el
-- COMMIT no se ejecuta.
-- =============================================================================
DO $$
DECLARE
    v_venue  bigint;
    v_user   bigint;
    v_event  bigint;
    v_n      bigint;
    v_old    timestamptz := now() - interval '400 days';
BEGIN
    -- Datos mínimos: venue, usuario, evento.
    INSERT INTO venues (name, slug) VALUES ('Retención', 'retencion-' || txid_current())
    RETURNING id INTO v_venue;
    INSERT INTO users (email, password_hash, full_name)
    VALUES ('retencion-' || txid_current() || '@test.local', 'x', 'Retención')
    RETURNING id INTO v_user;
    INSERT INTO events (venue_id, name, capacity, starts_at, ends_at)
    VALUES (v_venue, 'Evento', 10, now(), now() + interval '4 hours')
    RETURNING id INTO v_event;

    -- 1) analytics_events: una vieja (se borra) y una nueva (se queda).
    INSERT INTO analytics_events (name, session_id, created_at)
    VALUES ('view_home', 'session-aaa-1', v_old),
           ('view_home', 'session-bbb-1', now());
    v_n := prune_analytics_events(180);
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST_FAIL analytics_deleted_%', v_n;
    END IF;

    -- 2) notifications: sólo las leídas y viejas se van.
    INSERT INTO notifications (user_id, venue_id, kind, title, body, read_at, created_at)
    VALUES (v_user, v_venue, 'event_reminder', 'Vieja leída', 'x', v_old, v_old),
           (v_user, v_venue, 'event_reminder', 'Vieja sin leer', 'x', NULL, v_old),
           (v_user, v_venue, 'event_reminder', 'Nueva leída', 'x', now(), now());
    v_n := prune_notifications(90);
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST_FAIL notifications_deleted_%', v_n;
    END IF;
    -- La no leída sigue ahí aunque sea vieja.
    IF NOT EXISTS (
        SELECT 1 FROM notifications
         WHERE user_id = v_user AND title = 'Vieja sin leer'
    ) THEN
        RAISE EXCEPTION 'TEST_FAIL unread_was_deleted';
    END IF;

    -- 3) push_outbox: procesada y vieja se va; pendiente se queda.
    INSERT INTO notifications (user_id, venue_id, kind, title, body)
    VALUES (v_user, v_venue, 'event_reminder', 'Pendiente', 'x')
    RETURNING id INTO v_event;  -- reusa la variable como notification_id
    INSERT INTO push_outbox (notification_id, processed_at, created_at)
    VALUES (v_event, v_old, v_old),
           (v_event, NULL, v_old);
    v_n := prune_push_outbox(7);
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST_FAIL push_outbox_deleted_%', v_n;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM push_outbox WHERE notification_id = v_event AND processed_at IS NULL
    ) THEN
        RAISE EXCEPTION 'TEST_FAIL pending_push_was_deleted';
    END IF;

    -- 4) audit_log: vieja se va.
    INSERT INTO audit_log (venue_id, kind, entity, created_at)
    VALUES (v_venue, 'test', 'event', v_old),
           (v_venue, 'test', 'event', now());
    v_n := prune_audit_log(365);
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST_FAIL audit_deleted_%', v_n;
    END IF;

    -- 5) door_sync_receipts: vieja se va.
    INSERT INTO door_sync_receipts (event_id, scan_id, outcome, created_at)
    VALUES (v_event, gen_random_uuid(), 'ok', v_old),
           (v_event, gen_random_uuid(), 'ok', now());
    v_n := prune_door_sync_receipts(30);
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST_FAIL receipts_deleted_%', v_n;
    END IF;

    -- 6) prune_expired() no falla y devuelve un total (>= 0).
    v_n := prune_expired();
    IF v_n < 0 THEN
        RAISE EXCEPTION 'TEST_FAIL prune_expired_negative';
    END IF;

    RAISE NOTICE 'OK_TEST';
    RAISE EXCEPTION 'ROLLBACK_TEST';  -- revierte todo lo de arriba
EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'ROLLBACK_TEST' THEN
        RAISE NOTICE 'rollback ok';
    ELSE
        RAISE;
    END IF;
END $$;

COMMIT;
