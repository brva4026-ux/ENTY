-- 070: aforo por zona.
--
-- Una zona es un espacio físico del recinto (pista, terraza, VIP) con su
-- propio tope. Varias localidades pueden apuntar a la misma zona: el aforo se
-- cuenta sobre las personas realmente adentro, no sobre las boletas emitidas.
--
-- `ticket_types.zone_id` es aditivo: los tipos sin zona siguen usando el tope
-- histórico `access_capacity` de la 052. `event_zone_occupancy` es la lectura
-- que usan Administración y Puerta.

BEGIN;

CREATE TABLE IF NOT EXISTS public.event_zones (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    name text NOT NULL,
    capacity integer NOT NULL CHECK (capacity > 0),
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (event_id, name)
);

CREATE INDEX IF NOT EXISTS idx_event_zones_event
    ON public.event_zones (event_id, sort_order, id);

ALTER TABLE public.ticket_types
    ADD COLUMN IF NOT EXISTS zone_id bigint
        REFERENCES public.event_zones(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ticket_types_zone
    ON public.ticket_types (zone_id);

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
    v_zone_id    bigint;
    v_zone_name  text;
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

    -- Aforo por zona (mig 070): la zona agrupa una o varias localidades y
    -- manda sobre el tope por tipo. Si el tipo no tiene zona, se conserva el
    -- tope histórico `access_capacity` de la 052.
    SELECT z.id, z.name, z.capacity
      INTO v_zone_id, v_zone_name, v_zone_cap
      FROM event_zones z
      JOIN ticket_types tt ON tt.zone_id = z.id
     WHERE tt.id = v_ticket.ticket_type_id;

    IF v_zone_id IS NOT NULL THEN
        SELECT count(DISTINCT tp.ticket_id) INTO v_zone_inside
          FROM ticket_presence tp
          JOIN tickets t ON t.id = tp.ticket_id
          JOIN ticket_types tt ON tt.id = t.ticket_type_id
         WHERE tp.event_id = p_event_id
           AND tp.state = 'inside'
           AND tt.zone_id = v_zone_id;
        IF v_zone_inside >= v_zone_cap THEN
            INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
            VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'zone_capacity_reached', v_scanned_at, v_door_id);
            RETURN 'ZONE_CAPACITY_REACHED';
        END IF;
    ELSE
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

-- Lectura por zona para el tablero y para Puerta. `inside` cuenta personas,
-- no boletas: una persona con reingreso no ocupa dos lugares.
CREATE OR REPLACE FUNCTION public.event_zone_occupancy(p_event_id bigint)
RETURNS TABLE (
    zone_id bigint,
    name text,
    capacity integer,
    inside bigint,
    free_seats bigint,
    status text,
    sort_order integer
)
    LANGUAGE sql
    STABLE
    AS $$
    SELECT z.id,
           z.name,
           z.capacity,
           count(DISTINCT tp.ticket_id)
               FILTER (WHERE tp.state = 'inside')::bigint AS inside,
           GREATEST(
               z.capacity - count(DISTINCT tp.ticket_id)
                   FILTER (WHERE tp.state = 'inside'),
               0
           )::bigint AS free_seats,
           CASE
               WHEN count(DISTINCT tp.ticket_id)
                       FILTER (WHERE tp.state = 'inside') >= z.capacity
                   THEN 'full'
               WHEN count(DISTINCT tp.ticket_id)
                       FILTER (WHERE tp.state = 'inside') >= ceil(z.capacity * 0.9)
                   THEN 'near'
               ELSE 'open'
           END AS status,
           z.sort_order
      FROM event_zones z
      LEFT JOIN ticket_types tt ON tt.zone_id = z.id
      LEFT JOIN tickets t ON t.ticket_type_id = tt.id AND t.event_id = z.event_id
      LEFT JOIN ticket_presence tp
             ON tp.ticket_id = t.id
            AND tp.event_id = z.event_id
            AND tp.state = 'inside'
     WHERE z.event_id = p_event_id
     GROUP BY z.id, z.name, z.capacity, z.sort_order
     ORDER BY z.sort_order, z.name;
$$;

COMMIT;
