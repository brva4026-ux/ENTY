-- 027: el aviso de duplicados lleva a la NOCHE exacta, no al panel a secas.
--
-- mig 026 ya avisa al admin cuando el MISMO ticket se reescanea 3+ veces en 5
-- min (firma de un QR reenviado). Pero el link del aviso era '/admin': al
-- tocarlo, el admin caia en la lista de eventos y tenia que buscar a mano
-- CUAL de las noches esta en puerta. Con 20+ noches abiertas, el aviso
-- senalaba el problema pero no llevaba a el.
--
-- El link pasa a '/admin?event=<id>': un solo toque monta el backstage de esa
-- noche, donde la salud de puerta (duplicados/rechazos) ya se muestra en vivo.
-- El resto del comportamiento (umbral por tasa, aviso al CRUZAR, una vez por
-- rafaga) no cambia.
--
-- Idempotente sobre un schema.sql ya consolidado (test de drift): CREATE OR
-- REPLACE con el MISMO cuerpo que schema.sql.

BEGIN;

CREATE OR REPLACE FUNCTION notify_door_anomaly() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_n        int;
    v_venue_id bigint;
    v_name     text;
    v_window    constant int := 5;
    v_threshold constant int := 3;
BEGIN
    IF NEW.outcome <> 'already_redeemed' OR NEW.ticket_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT e.venue_id, e.name INTO v_venue_id, v_name
    FROM events e WHERE e.id = NEW.event_id;
    IF v_venue_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT count(*) INTO v_n
    FROM redemptions
    WHERE ticket_id = NEW.ticket_id
      AND outcome = 'already_redeemed'
      AND scanned_at >= now() - (v_window * INTERVAL '1 minute');

    -- Se avisa al CRUZAR el umbral, una sola vez por rafaga. El link apunta a
    -- la noche del escaneo para que un toque abra su backstage.
    IF v_n = v_threshold THEN
        PERFORM notify_venue_admins(
            v_venue_id, 'door_anomaly',
            'Duplicados en puerta',
            'La misma boleta se escaneo ' || v_n || ' veces en los ultimos '
              || v_window || ' minutos'
              || CASE WHEN v_name IS NOT NULL AND v_name <> ''
                      THEN ' (' || v_name || ')' ELSE '' END
              || '. Posible QR reenviado: revisa la puerta.',
            '/admin?event=' || NEW.event_id
        );
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
