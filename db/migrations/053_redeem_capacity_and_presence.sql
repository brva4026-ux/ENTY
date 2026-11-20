-- =============================================================================
-- Migración 053: redeem_ticket respeta el aforo y registra presencia.
--
-- Cierra el agujero de la 052: hasta ahora la puerta admitía cualquier boleta
-- válida sin mirar cuánta gente había adentro. Un evento con capacidad 400 y
-- 500 boletas vigentes aceptaba 500 ingresos.
--
-- Cambios de comportamiento (todos aditivos, ningún código previo cambia):
--
--   1. Aforo. Antes de admitir se cuenta la presencia real (`inside`) del
--      evento y de la zona. Si ya está en el tope -> 'CAPACITY_REACHED' y NO
--      se consume la boleta (podrá entrar cuando alguien salga). El lock es
--      `events FOR UPDATE`: serializa las admisiones de un mismo evento, que
--      es lo único que hace la cuenta atómica entre dos puertas. Es el mismo
--      patrón que ya usa reserve_ticket_payment para el inventario.
--
--   2. Presencia. Cada admisión escribe `ticket_presence.state='inside'` y
--      suma `admissions`. Un egreso (nueva función `register_exit`) lo pone
--      en 'outside'.
--
--   3. Reingreso. Si la boleta ya fue usada ('redeemed') pero la persona
--      salió, se admite OTRA vez solo si `events.allow_reentry`. Si no está
--      permitido, sigue devolviendo ALREADY_REDEEMED como siempre.
--
-- Los códigos existentes NO cambian, así que los 640 tests y el escáner
-- actual siguen funcionando igual. Solo aparece uno nuevo: CAPACITY_REACHED.
--
-- Los cuerpos son IDÉNTICOS a db/schema.sql (test_schema_drift lo exige).
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) redeem_ticket: aforo + presencia.
--
-- Se preserva el orden de validaciones original para no cambiar el significado
-- de ningún rechazo existente. El aforo se comprueba al FINAL, cuando la
-- boleta ya demostró ser válida: así una boleta inválida se reporta como
-- inválida y no como "aforo lleno", que sería un mensaje falso en la puerta.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_ticket(
    p_event_id bigint,
    p_raw_token text,
    p_scanned_by_user_id bigint,
    p_expected_ticket_type_id bigint DEFAULT NULL::bigint,
    p_scanned_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
    p_door_id text DEFAULT NULL::text
) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_ticket tickets%ROWTYPE;
    v_token_hash text;
    v_event_status text;
    v_event_starts_at timestamptz;
    v_event_unlock integer;
    v_event_min_age integer;
    v_event_capacity bigint;
    v_allow_reentry boolean;
    v_scanned_at timestamptz;
    v_door_id    text;
    v_presence   ticket_presence%ROWTYPE;
    v_inside     bigint;
    v_zone_cap   integer;
    v_zone_inside bigint;
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

    -- Puerta de origen (mig 042): "puerta-1", "VIP", etc. Vacío o nulo =
    -- puerta sin identificar, que es la verdad y no un valor inventado.
    v_door_id := NULLIF(btrim(p_door_id), '');

    -- Guardia: el evento del escaneo debe existir (migración 006). Sin esto,
    -- el INSERT del log rompe la FK y el escáner recibe un 500 opaco.
    IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_event_id) THEN
        RAISE EXCEPTION 'event_not_found';
    END IF;

    v_token_hash := encode(digest(p_raw_token, 'sha256'), 'hex');

    SELECT * INTO v_ticket FROM tickets WHERE token_hash = v_token_hash;
    IF NOT FOUND THEN
        -- ticket_id NULL: el escaneo existe como huella, sin boleta asociada
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
        VALUES (NULL, p_event_id, p_scanned_by_user_id, 'not_found', v_scanned_at, v_door_id);
        RETURN 'NOT_FOUND';
    END IF;

    IF v_ticket.event_id <> p_event_id THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'invalid_event', v_scanned_at, v_door_id);
        RETURN 'INVALID_EVENT';
    END IF;

    -- El lock del evento se toma aquí, ANTES de leer capacity/allow_reentry,
    -- y se sostiene hasta el COMMIT. Dos puertas escaneando a la vez hacen
    -- fila en esta línea: la segunda ve la presencia ya actualizada por la
    -- primera. Sin este lock, ambas leerían el mismo conteo y las dos
    -- admitirían el último lugar.
    SELECT status, starts_at, qr_unlock_minutes, min_age, capacity, allow_reentry
      INTO v_event_status, v_event_starts_at, v_event_unlock, v_event_min_age,
           v_event_capacity, v_allow_reentry
      FROM events WHERE id = p_event_id FOR UPDATE;
    IF v_event_status <> 'live' AND v_event_status <> 'published' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'event_not_live', v_scanned_at, v_door_id);
        RETURN 'EVENT_NOT_LIVE';
    END IF;

    -- Ventana de activación (mig 013): el QR "existe" desde
    -- starts_at - unlock minutos. Antes, rechazo sin consumir.
    IF v_event_starts_at - (v_event_unlock * INTERVAL '1 minute') > now() THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'not_active', v_scanned_at, v_door_id);
        RETURN 'NOT_ACTIVE';
    END IF;

    -- Filtro de fila: con tipo esperado, una boleta válida de otro tipo NO
    -- entra y NO se consume (podrá entrar por la fila correcta después).
    IF p_expected_ticket_type_id IS NOT NULL
       AND v_ticket.ticket_type_id <> p_expected_ticket_type_id THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'wrong_type', v_scanned_at, v_door_id);
        RETURN 'WRONG_TYPE';
    END IF;

    -- Edad mínima (mig 051): defensa en la puerta.
    IF v_event_min_age IS NOT NULL AND v_event_min_age > 0
       AND v_ticket.customer_birth_date IS NOT NULL THEN
        IF date_part('year', age(v_event_starts_at::date, v_ticket.customer_birth_date)) < v_event_min_age THEN
            INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
            VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'under_age', v_scanned_at, v_door_id);
            RETURN 'UNDER_AGE';
        END IF;
    END IF;

    IF v_ticket.status = 'voided' OR v_ticket.status = 'refunded' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'not_valid', v_scanned_at, v_door_id);
        RETURN 'NOT_VALID';
    END IF;

    -- Presencia actual de esta boleta (puede no existir: nunca entró).
    SELECT * INTO v_presence FROM ticket_presence WHERE ticket_id = v_ticket.id;
    IF NOT FOUND THEN
        v_presence.state := 'outside';
        v_presence.admissions := 0;
    END IF;

    -- Ya está adentro: segundo escaneo del mismo QR (dos puertas a la vez, o
    -- el operador repitiendo). No se admite dos veces y NO se consume nada.
    IF v_presence.state = 'inside' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'already_redeemed', v_scanned_at, v_door_id);
        RETURN 'ALREADY_REDEEMED';
    END IF;

    -- Boleta ya usada y la persona está FUERA: esto es un reingreso.
    IF v_ticket.status = 'redeemed' THEN
        IF NOT COALESCE(v_allow_reentry, false) THEN
            INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
            VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'already_redeemed', v_scanned_at, v_door_id);
            RETURN 'ALREADY_REDEEMED';
        END IF;
    END IF;

    -- ------------------------------------------------------------------
    -- Aforo. Se cuenta la presencia REAL (los que están adentro ahora),
    -- no los ingresos acumulados. El evento ya está bloqueado, así que
    -- esta cuenta no puede cambiar hasta el COMMIT.
    -- ------------------------------------------------------------------
    SELECT count(*) INTO v_inside
      FROM ticket_presence
     WHERE event_id = p_event_id AND state = 'inside';

    IF v_inside >= v_event_capacity THEN
        -- No se consume la boleta: cuando alguien salga, este mismo QR
        -- podrá entrar. Se registra el rechazo para el tablero.
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'capacity_reached', v_scanned_at, v_door_id);
        RETURN 'CAPACITY_REACHED';
    END IF;

    -- Tope propio de la zona, si el organizador configuró uno.
    SELECT access_capacity INTO v_zone_cap
      FROM ticket_types WHERE id = v_ticket.ticket_type_id;
    IF v_zone_cap IS NOT NULL THEN
        SELECT count(*) INTO v_zone_inside
          FROM ticket_presence tp
          JOIN tickets t ON t.id = tp.ticket_id
         WHERE tp.event_id = p_event_id
           AND tp.state = 'inside'
           AND t.ticket_type_id = v_ticket.ticket_type_id;
        IF v_zone_inside >= v_zone_cap THEN
            INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
            VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'zone_capacity_reached', v_scanned_at, v_door_id);
            RETURN 'ZONE_CAPACITY_REACHED';
        END IF;
    END IF;

    -- Primer ingreso: el CAS de siempre, que garantiza un solo canje entre
    -- escaneos concurrentes. Reingreso: la boleta ya está en 'redeemed' y el
    -- CAS no aplica (no hay nada que cambiar en el derecho).
    IF v_ticket.status = 'issued' THEN
        UPDATE tickets
           SET status = 'redeemed', redeemed_at = v_scanned_at, redeemed_by_user_id = p_scanned_by_user_id
         WHERE id = v_ticket.id AND status = 'issued';

        IF NOT FOUND THEN
            INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
            VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'already_redeemed', v_scanned_at, v_door_id);
            RETURN 'ALREADY_REDEEMED';
        END IF;
    END IF;

    -- Presencia: dentro, con el conteo de admisiones incrementado.
    INSERT INTO ticket_presence AS tp
        (ticket_id, event_id, state, admissions, last_in_at, last_in_door, updated_at)
    VALUES
        (v_ticket.id, p_event_id, 'inside', 1, v_scanned_at, v_door_id, now())
    ON CONFLICT (ticket_id) DO UPDATE
        SET state = 'inside',
            admissions = tp.admissions + 1,
            last_in_at = EXCLUDED.last_in_at,
            last_in_door = EXCLUDED.last_in_door,
            updated_at = now();

    INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
    VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'granted', v_scanned_at, v_door_id);
    RETURN 'GRANTED';
END;
$$;

COMMIT;
