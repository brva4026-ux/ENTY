-- =============================================================================
-- Migración 034: la puerta sobrevive a la hora de cierre y el sync offline
-- deja de mentir.
--
-- Cinco bugs reales, encontrados operando un evento de carga (20 de equipo,
-- 50 asistentes) contra la API local:
--
--   1. GRAVE — el auto-cierre mataba la puerta. auto_close_expired_events()
--      pasaba live -> ended en cuanto vencía ends_at, y redeem_ticket() solo
--      acepta live/published: todas las boletas válidas empezaban a responder
--      EVENT_NOT_LIVE. Y 'ended' era terminal en el trigger de la mig 005, así
--      que NO había forma de reabrir. Un bar que cierra más tarde de lo
--      previsto (lo normal) dejaba a la gente afuera sin remedio.
--      Fix: ventana de gracia de 6 h antes de cerrar + reapertura ended->live.
--
--   2. El sync offline podía PERDER y FALSEAR ingresos. El cliente borraba la
--      cola completa solo si el POST respondía 200, y la respuesta era
--      agregada (sin decir qué token falló): un reintento por corte de red
--      reenviaba lo ya procesado y lo contaba como already_redeemed.
--      Fix: recibo idempotente por (event_id, scan_id) + resultado por token.
--
--   3. La cola offline no guardaba el evento: un bouncer que trabajaba dos
--      eventos mandaba los tokens del primero contra el segundo (INVALID_EVENT)
--      y la entrada real quedaba sin registrar.
--      Fix (frontend): cada item de la cola lleva su event_id.
--
--   4. El sync descartaba scanned_at: todo canje offline quedaba con la hora
--      del sync. Para una herramienta de auditoría anti-fraude, perder la hora
--      real de la puerta es perder el dato.
--      Fix: redeem_ticket() acepta p_scanned_at.
--
--   5. El rate limit en memoria de public.py nunca evictaba: crecía una
--      entrada por IP para siempre.
--      Fix (backend): evicción por ventana.
--
-- Los cuerpos de las funciones son IDÉNTICOS a db/schema.sql: el test
-- test_schema_drift exige que re-aplicar las migraciones sea un no-op sobre
-- una instalación limpia.
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) auto_close_expired_events: ventana de gracia de 6 h.
--
-- ends_at es una estimación del organizador, no una orden de desalojo: la
-- fiesta se estira y el bar sigue abierto. Sin la gracia, la puerta empezaba a
-- rechazar boletas pagadas en cuanto pasaba la hora prevista.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_close_expired_events() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    -- Tolerancia de "la noche se estiró": ends_at es una estimación del
    -- organizador, no una orden de desalojo. Sin ella, un bar que cierra más
    -- tarde de lo previsto veía EVENT_NOT_LIVE en boletas válidas.
    v_grace  interval := interval '6 hours';
    v_closed integer;
    c record;
BEGIN
    -- live -> ended (la noche termino, nadie pulso "Terminar")
    WITH closed AS (
        UPDATE events
           SET status = 'ended', updated_at = now()
         WHERE status = 'live'
           AND ends_at IS NOT NULL
           AND ends_at + v_grace < now()
        RETURNING 1
    )
    SELECT count(*) INTO v_closed FROM closed;

    -- published vencido -> cancelled (venta que vencio sin abrir puertas).
    -- OJO: NO es 'ended'. El trigger events_check_transition (mig 005) solo
    -- acepta published -> live | cancelled; un UPDATE a 'ended' lanzaba
    -- invalid_transition y el GET /events entero moria en la watchdog con
    -- un 500 la primera vez que existia un published vencido en datos reales
    -- (en CI nunca ocurría: los tests pasan por live antes de vencer).
    --
    -- El FOR captura cada fila cerrada: acumula el conteo Y deja el aviso
    -- (in-app + push via notify_venue_admins). El admin NO descubre un
    -- cancelado mirando la franja; un solo UPDATE hace el cierre, así que
    -- no hay doble-pasada que devuelva 0 filas al notificar.
    FOR c IN
        UPDATE events
           SET status = 'cancelled', updated_at = now()
         WHERE status = 'published'
           AND ends_at IS NOT NULL
           AND ends_at + v_grace < now()
        RETURNING id, venue_id, name
    LOOP
        v_closed := v_closed + 1;
        PERFORM notify_venue_admins(
            c.venue_id,
            'event_autoclosed',
            'Evento cerrado automáticamente',
            c.name || ' tenía la venta vencida y nadie lo cerró: pasó a cancelado.',
            '/admin?event=' || c.id
        );
    END LOOP;

    RETURN v_closed;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) Reapertura ended -> live. Antes 'ended' era terminal: un ends_at mal
-- cargado dejaba el evento muerto para siempre, sin puerta y sin venta.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.events_check_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;  -- sin cambio real de estado: no es una transición
    END IF;

    IF NOT (
        (OLD.status = 'draft'     AND NEW.status IN ('published', 'cancelled')) OR
        (OLD.status = 'published' AND NEW.status IN ('live', 'cancelled')) OR
        (OLD.status = 'live'      AND NEW.status = 'ended') OR
        -- Reapertura: la noche se estiró más que la gracia, o el cierre fue un
        -- error. El admin vuelve a poner la puerta en marcha.
        (OLD.status = 'ended'     AND NEW.status = 'live')
    ) THEN
        RAISE EXCEPTION 'invalid_transition (% -> %)', OLD.status, NEW.status;
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) set_event_status: la validación de inventario aplica a CUALQUIER entrada
-- a 'live' (published -> live y la reapertura ended -> live).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_event_status(p_event_id bigint, p_from text, p_to text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_count integer;
    v_issued bigint;
    v_types_total bigint;
    v_over text;
BEGIN
    SELECT count(*) INTO v_count
      FROM events
     WHERE id = p_event_id
       AND status = p_from;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'invalid_transition';
    END IF;

    -- Al abrir (o reabrir) puertas: la suma de quantities de los tipos debe
    -- cubrir las boletas ya emitidas. Si el admin redujo tipos por debajo de
    -- lo vendido, la puerta no abre con sobreventa. Aplica a CUALQUIER
    -- entrada a 'live' (published -> live y la reapertura ended -> live).
    IF p_to = 'live' THEN
        SELECT count(*) INTO v_issued
          FROM tickets
         WHERE event_id = p_event_id
           AND status NOT IN ('voided', 'refunded');

        SELECT COALESCE(SUM(quantity), 0) INTO v_types_total
          FROM ticket_types
         WHERE event_id = p_event_id;

        IF v_issued > v_types_total THEN
            RAISE EXCEPTION 'capacity_below_issued (issued=%, types_total=%)',
                v_issued, v_types_total;
        END IF;

        -- Ninguna localidad puede tener más boletas vivas que su inventario.
        SELECT tt.name INTO v_over
          FROM ticket_types tt
         WHERE tt.event_id = p_event_id
           AND (SELECT count(*) FROM tickets t
                 WHERE t.event_id = p_event_id
                   AND t.ticket_type_id = tt.id
                   AND t.status NOT IN ('voided', 'refunded')) > tt.quantity
         LIMIT 1;
        IF v_over IS NOT NULL THEN
            RAISE EXCEPTION 'ticket_type_oversold (%)', v_over;
        END IF;
    END IF;

    UPDATE events
       SET status = p_to, updated_at = now()
     WHERE id = p_event_id AND status = p_from;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) redeem_ticket acepta la hora REAL del escaneo (p_scanned_at), saneada:
-- una hora futura o de hace más de 7 días (reloj roto) cae a now().
--
-- Se suelta la firma vieja de 4 args: si convivieran las dos, una llamada de
-- 4 argumentos sería ambigua (AmbiguousFunction).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS redeem_ticket(bigint, text, bigint, bigint);

CREATE OR REPLACE FUNCTION public.redeem_ticket(p_event_id bigint, p_raw_token text, p_scanned_by_user_id bigint, p_expected_ticket_type_id bigint DEFAULT NULL::bigint, p_scanned_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_ticket tickets%ROWTYPE;
    v_token_hash text;
    v_event_status text;
    v_event_starts_at timestamptz;
    v_event_unlock integer;
    v_scanned_at timestamptz;
BEGIN
    IF p_raw_token IS NULL OR length(p_raw_token) < 8 THEN
        RAISE EXCEPTION 'invalid_token_format';
    END IF;

    -- Hora efectiva del escaneo: la del cliente (sync offline) si es
    -- plausible, now() si no. Una hora futura o de hace más de 7 días es un
    -- reloj roto, no un dato.
    v_scanned_at := COALESCE(p_scanned_at, now());
    IF v_scanned_at > now() + INTERVAL '5 minutes'
       OR v_scanned_at < now() - INTERVAL '7 days' THEN
        v_scanned_at := now();
    END IF;

    -- Guardia: el evento del escaneo debe existir (migración 006). Sin esto,
    -- el INSERT del log rompe la FK y el escáner recibe un 500 opaco.
    IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_event_id) THEN
        RAISE EXCEPTION 'event_not_found';
    END IF;

    v_token_hash := encode(digest(p_raw_token, 'sha256'), 'hex');

    SELECT * INTO v_ticket FROM tickets WHERE token_hash = v_token_hash;
    IF NOT FOUND THEN
        -- ticket_id NULL: el escaneo existe como huella, sin boleta asociada
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (NULL, p_event_id, p_scanned_by_user_id, 'not_found', v_scanned_at);
        RETURN 'NOT_FOUND';
    END IF;

    IF v_ticket.event_id <> p_event_id THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'invalid_event', v_scanned_at);
        RETURN 'INVALID_EVENT';
    END IF;

    SELECT status, starts_at, qr_unlock_minutes
      INTO v_event_status, v_event_starts_at, v_event_unlock
      FROM events WHERE id = p_event_id;
    IF v_event_status <> 'live' AND v_event_status <> 'published' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'event_not_live', v_scanned_at);
        RETURN 'EVENT_NOT_LIVE';
    END IF;

    -- Ventana de activación (mig 013): el QR "existe" desde
    -- starts_at - unlock minutos. Antes, rechazo sin consumir.
    IF v_event_starts_at - (v_event_unlock * INTERVAL '1 minute') > now() THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'not_active', v_scanned_at);
        RETURN 'NOT_ACTIVE';
    END IF;

    -- Filtro de fila: con tipo esperado, una boleta válida de otro tipo NO
    -- entra y NO se consume (podrá entrar por la fila correcta después).
    IF p_expected_ticket_type_id IS NOT NULL
       AND v_ticket.ticket_type_id <> p_expected_ticket_type_id THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'wrong_type', v_scanned_at);
        RETURN 'WRONG_TYPE';
    END IF;

    IF v_ticket.status = 'voided' OR v_ticket.status = 'refunded' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'not_valid', v_scanned_at);
        RETURN 'NOT_VALID';
    END IF;

    IF v_ticket.status = 'redeemed' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'already_redeemed', v_scanned_at);
        RETURN 'ALREADY_REDEEMED';
    END IF;

    -- Compare-and-swap: exactamente UNA de las filas concurrentes sera afectada.
    UPDATE tickets
       SET status = 'redeemed', redeemed_at = v_scanned_at, redeemed_by_user_id = p_scanned_by_user_id
     WHERE id = v_ticket.id AND status = 'issued';

    IF NOT FOUND THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'already_redeemed', v_scanned_at);
        RETURN 'ALREADY_REDEEMED';
    END IF;

    INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
    VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'granted', v_scanned_at);
    RETURN 'GRANTED';
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) Recibo idempotente del sync offline: cada item de la cola trae un scan_id
-- (uuid generado por el teléfono al escanear). El sync busca ese scan_id antes
-- de canjear: si ya está, devuelve el resultado guardado sin tocar
-- `redemptions`. Un reintento por corte de red deja de contar la misma entrada
-- dos veces.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS door_sync_receipts (
    event_id bigint NOT NULL,
    scan_id uuid NOT NULL,
    outcome text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT door_sync_receipts_pkey PRIMARY KEY (event_id, scan_id)
);

COMMIT;
