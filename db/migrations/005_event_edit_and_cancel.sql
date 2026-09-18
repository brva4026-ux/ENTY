-- =============================================================================
-- Migración 005: edición de eventos y cancelación desde published.
--
-- Reglas que protege (dinero, no cosmética):
--   1. update_event(): edición parcial con lock FOR UPDATE sobre la misma fila
--      que bloquea emit_ticket() y set_event_status(), así una emisión
--      concurrente no puede colarse entre el conteo y el UPDATE.
--   2. El aforo no puede quedar por debajo de las boletas activas ya emitidas
--      (mismo invariante que events_check_capacity y update_ticket_type).
--   3. Las fechas no se corren al pasado: starts_at debe ser futuro SIEMPRE que
--      el evento no haya empezado aún (draft/published).
--   4. La ventana (ends_at > starts_at) se re-valida al editar.
--   5. set_event_status() se amplia: 'published' -> 'cancelled' pasa a ser
--      transición válida (antes solo draft). La cancelación con boletas activas
--      se permite a nivel de estado del evento: emit_ticket() ya rechaza
--      eventos cancelled y redeem_ticket() los rechaza (no live/published), así
--      que una boleta no canjeada de un evento cancelado queda inutilizable de
--      por sí. (El flujo de reembolso masivo es otro ticket.)
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) update_event: edición parcial del evento
--    p_name / p_starts_at / p_capacity llegan siempre (NOT NULL);
--    p_description / p_ends_at / p_flyer_url / p_event_timezone pueden ser NULL
--    y el caller manda el valor vigente cuando no se editó ese campo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_event(
    p_event_id      bigint,
    p_name          text,
    p_description   text,
    p_flyer_url     text,
    p_starts_at     timestamptz,
    p_ends_at       timestamptz,
    p_event_timezone text,
    p_capacity      integer
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_id            bigint;
    v_status        text;
    v_active_issued bigint;
BEGIN
    SELECT id, status INTO v_id, v_status
      FROM events WHERE id = p_event_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found'; END IF;

    IF p_name IS NULL OR btrim(p_name) = '' THEN
        RAISE EXCEPTION 'invalid_name';
    END IF;
    IF p_capacity IS NULL OR p_capacity <= 0 THEN
        RAISE EXCEPTION 'invalid_capacity';
    END IF;

    -- La ventana se re-valida en la DB también al editar.
    IF p_ends_at IS NOT NULL AND p_ends_at <= p_starts_at THEN
        RAISE EXCEPTION 'invalid_window';
    END IF;

    -- No mover fechas al pasado si el evento aún no empezó. (Un evento live/ended
    -- puede mantener su starts_at original; el caller no envía cambios de fecha
    -- para esos estados, pero la regla es de DB y vale para cualquier camino.)
    IF v_status IN ('draft', 'published') AND p_starts_at < now() THEN
        RAISE EXCEPTION 'starts_at_in_past';
    END IF;

    -- Aforo nunca por debajo de las boletas activas (no anuladas/reembolsadas).
    -- Mismo criterio que emit_ticket() usa para rechazar sobreventa.
    SELECT count(*) INTO v_active_issued
      FROM tickets
     WHERE event_id = p_event_id
       AND status NOT IN ('voided', 'refunded');
    IF p_capacity < v_active_issued THEN
        RAISE EXCEPTION 'capacity_cannot_be_below_issued (capacity=%, issued=%)',
            p_capacity, v_active_issued;
    END IF;

    UPDATE events
       SET name           = p_name,
           description    = p_description,
           flyer_url      = p_flyer_url,
           starts_at      = p_starts_at,
           ends_at        = p_ends_at,
           event_timezone = p_event_timezone,
           capacity       = p_capacity,
           updated_at     = now()
     WHERE id = p_event_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) set_event_status: permitir cancelar desde 'published' (además de draft).
--    Se re-declara la función completa (CREATE OR REPLACE) con la lógica de la
--    003 intacta + la transición extra resuelta en el caller: el par (from, to)
--    lo decide la API, la función solo exige que el estado actual sea p_from.
--    La API manda (published, cancelled) y esto la acepta igual que (draft,
--    cancelled). No hay que cambiar nada: la función ya es genérica. Lo que SÍ
--    agregamos es un trigger genérico que impide transiciones fuera de la
--    matriz completa, para que ningún camino (scripts, console, futuros
--    endpoints) pueda saltarse las reglas:
--
--      draft     -> published | cancelled
--      published -> live | cancelled
--      live      -> ended
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION events_check_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;  -- sin cambio real de estado: no es una transición
    END IF;

    IF NOT (
        (OLD.status = 'draft'     AND NEW.status IN ('published', 'cancelled')) OR
        (OLD.status = 'published' AND NEW.status IN ('live', 'cancelled')) OR
        (OLD.status = 'live'      AND NEW.status = 'ended')
    ) THEN
        RAISE EXCEPTION 'invalid_transition (% -> %)', OLD.status, NEW.status;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_events_check_transition ON events;
CREATE TRIGGER trg_events_check_transition
    BEFORE UPDATE OF status ON events
    FOR EACH ROW EXECUTE FUNCTION events_check_transition();

COMMIT;
