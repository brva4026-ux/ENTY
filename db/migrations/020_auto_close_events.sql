-- 020: cierre automatico de eventos vencidos.
--
-- Bug: un evento 'live' cuyo ends_at paso quedaba "en puerta" para siempre
-- si nadie pulsaba "Terminar". La franja mentia (eventos fantasma en puerta)
-- y los KPIs del negocio (eventos activos, ingresos "en vivo") quedaban
-- distorsionados. Lo mismo un 'published' con venta vencida.
--
-- Diseno: la misma DB que impone el ciclo de vida (mig 002) aporta la
-- operacion de cierre, IDEMPOTENTE y re-ejecutable: auto_close_expired_events()
-- hace las transiciones validas live->ended y published->ended SOLO cuando
-- ends_at ya paso. Quien la llame (watchdog en lecturas, cron futuro)
-- puede repetirla sin miedo: si no hay vencidos, no hace nada.
--
-- Criterio de vencimiento: SOLO eventos con ends_at definido (el asistente
-- de creacion siempre lo fija por duracion). Un evento SIN fecha de cierre
-- no se cierra solo: el sistema no adivina cuando termina la fiesta, y un
-- cierre erroneo cortaria la venta/escaneo con gente adentro.

BEGIN;

-- Cierra los eventos vencidos. Devuelve cuantos cerro (live y published).
CREATE OR REPLACE FUNCTION auto_close_expired_events()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_closed integer;
BEGIN
    -- live -> ended (la noche termino, nadie pulso "Terminar")
    WITH closed AS (
        UPDATE events
           SET status = 'ended', updated_at = now()
         WHERE status = 'live'
           AND ends_at IS NOT NULL
           AND ends_at < now()
        RETURNING 1
    )
    SELECT count(*) INTO v_closed FROM closed;

    -- published vencido -> cancelled (venta que vencio sin abrir puertas).
    -- OJO: NO es 'ended'. El trigger events_check_transition (mig 005) solo
    -- acepta published -> live | cancelled; un UPDATE a 'ended' lanzaba
    -- invalid_transition y el GET /events entero moria en la watchdog con
    -- un 500 la primera vez que existia un published vencido en datos reales
    -- (en CI nunca ocurría: los tests pasan por live antes de vencer).
    WITH closed AS (
        UPDATE events
           SET status = 'cancelled', updated_at = now()
         WHERE status = 'published'
           AND ends_at IS NOT NULL
           AND ends_at < now()
        RETURNING 1
    )
    SELECT v_closed + count(*) INTO v_closed FROM closed;

    RETURN v_closed;
END;
$$;

-- Index parcial: la watchdog siempre pregunta "hay vencidos?" — esto la hace
-- un index-only scan minimo en vez de un seq scan de la tabla de eventos.
CREATE INDEX IF NOT EXISTS idx_events_ends_unended
    ON events (ends_at)
    WHERE status IN ('live', 'published');

COMMIT;
