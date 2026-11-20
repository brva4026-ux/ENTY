-- =============================================================================
-- Migración 054: registrar salidas y leer la ocupación real.
--
-- Sin egreso no hay aforo que valga: si nadie puede salir, "personas dentro"
-- solo crece y el tope de capacidad bloquea el recinto para siempre. Esta
-- migración añade la otra mitad del movimiento.
--
-- `register_exit` es la contraparte de `redeem_ticket`. Es idempotente por
-- diseño: salir dos veces no descuenta dos veces, porque la segunda encuentra
-- `state = 'outside'` y devuelve 'ALREADY_OUTSIDE' sin tocar nada. Eso importa
-- porque el operador de puerta repite el escaneo todo el tiempo.
--
-- `event_occupancy` es la única fuente de verdad para el tablero: devuelve
-- las cifras separadas que el prompt exige (emitidos, únicos admitidos,
-- dentro, salidas, rechazos) en vez de un solo número que se confunde.
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) register_exit: la persona sale del recinto.
--
-- Toma el mismo lock del evento que redeem_ticket, en el mismo orden
-- (evento -> presencia), para que una salida y un ingreso simultáneos no
-- puedan cruzarse y dejar la cuenta mal.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_exit(
    p_event_id bigint,
    p_raw_token text,
    p_by_user_id bigint DEFAULT NULL::bigint,
    p_exited_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
    p_door_id text DEFAULT NULL::text
) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_ticket   tickets%ROWTYPE;
    v_hash     text;
    v_when     timestamptz;
    v_door     text;
    v_presence ticket_presence%ROWTYPE;
BEGIN
    IF p_raw_token IS NULL OR length(p_raw_token) < 8 THEN
        RAISE EXCEPTION 'invalid_token_format';
    END IF;

    v_when := COALESCE(p_exited_at, now());
    IF v_when > now() + INTERVAL '5 minutes'
       OR v_when < now() - INTERVAL '7 days' THEN
        v_when := now();
    END IF;
    v_door := NULLIF(btrim(p_door_id), '');

    IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_event_id) THEN
        RAISE EXCEPTION 'event_not_found';
    END IF;

    -- Mismo orden de locks que redeem_ticket: evento primero.
    PERFORM 1 FROM events WHERE id = p_event_id FOR UPDATE;

    v_hash := encode(digest(p_raw_token, 'sha256'), 'hex');
    SELECT * INTO v_ticket FROM tickets WHERE token_hash = v_hash;
    IF NOT FOUND THEN
        RETURN 'NOT_FOUND';
    END IF;
    IF v_ticket.event_id <> p_event_id THEN
        RETURN 'INVALID_EVENT';
    END IF;

    SELECT * INTO v_presence FROM ticket_presence WHERE ticket_id = v_ticket.id;
    IF NOT FOUND OR v_presence.state <> 'inside' THEN
        -- Ya estaba afuera (o nunca entró): no se descuenta nada. Es la
        -- respuesta correcta para un operador que repite el escaneo.
        RETURN 'ALREADY_OUTSIDE';
    END IF;

    UPDATE ticket_presence
       SET state = 'outside',
           last_out_at = v_when,
           last_out_door = v_door,
           updated_at = now()
     WHERE ticket_id = v_ticket.id AND state = 'inside';

    -- Traza: la salida es un evento de auditoría igual que el ingreso. Se
    -- guarda en `redemptions` con su propio outcome para que el CSV y el
    -- tablero la vean sin una tabla nueva que aprender.
    INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
    VALUES (v_ticket.id, p_event_id, p_by_user_id, 'exit', v_when, v_door);

    RETURN 'EXITED';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) event_occupancy: las cifras del tablero, separadas como corresponde.
--
--   issued          boletas vigentes emitidas (el techo de lo vendible)
--   unique_admitted personas distintas que alguna vez entraron
--   inside          personas adentro AHORA (la que manda para el aforo)
--   exits           salidas registradas
--   reentries       admisiones que no fueron la primera de esa boleta
--   rejected        escaneos rechazados (para ver qué falla en la puerta)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.event_occupancy(p_event_id bigint)
RETURNS TABLE (
    capacity        integer,
    issued          bigint,
    unique_admitted bigint,
    inside          bigint,
    exits           bigint,
    reentries       bigint,
    rejected        bigint
)
    LANGUAGE sql
    STABLE
    AS $$
    SELECT
        e.capacity::integer,
        (SELECT count(*) FROM tickets t
          WHERE t.event_id = e.id AND t.status NOT IN ('voided', 'refunded'))::bigint,
        (SELECT count(*) FROM ticket_presence tp
          WHERE tp.event_id = e.id AND tp.admissions > 0)::bigint,
        (SELECT count(*) FROM ticket_presence tp
          WHERE tp.event_id = e.id AND tp.state = 'inside')::bigint,
        (SELECT count(*) FROM redemptions r
          WHERE r.event_id = e.id AND r.outcome = 'exit')::bigint,
        (SELECT COALESCE(sum(GREATEST(tp.admissions - 1, 0)), 0) FROM ticket_presence tp
          WHERE tp.event_id = e.id)::bigint,
        (SELECT count(*) FROM redemptions r
          WHERE r.event_id = e.id
            AND r.outcome NOT IN ('granted', 'granted_forced', 'exit'))::bigint
    FROM events e
    WHERE e.id = p_event_id;
$$;

COMMIT;
