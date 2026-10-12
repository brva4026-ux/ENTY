-- 026: aviso al admin cuando la puerta ve duplicados (posible QR reenviado).
--
-- El admin ya VE los duplicados (reporte del evento y franja), pero solo si
-- esta mirando. Un QR reenviado/clonado se detecta por su FIRMA: el MISMO
-- ticket escaneado varias veces seguidas. Este trigger convierte esa firma en
-- una notificacion in-app (y push, via notify_venue_admins).
--
-- Vive en la DB, como el resto de notificaciones (mig 012): asi cubre por
-- igual el scan en linea y la reconciliacion offline (door_sync), que inserta
-- redemptions con el mismo outcome. Ningun router tiene que acordarse.
--
-- Umbral: 3+ 'already_redeemed' del MISMO ticket en los ultimos 5 minutos. Es
-- un umbral por TASA, no acumulado: en un evento, un puñado de duplicados
-- dispersos es normal (dos personas escaneando a la vez); lo anormal es la
-- rafaga. Se avisa al CRUZAR el umbral (v_n = 3), no en cada escaneo extra,
-- para no inundar la campana.
--
-- Idempotente sobre un schema.sql ya consolidado (test de drift): la funcion
-- es CREATE OR REPLACE con el MISMO cuerpo, el CHECK se re-crea igual y el
-- trigger es IF NOT EXISTS.

BEGIN;

-- 1) El kind nuevo entra al catalogo cerrado de notifications (mig 012/024).
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN (
        'payout_created', 'payout_reviewed', 'payout_disputed',
        'invitation_accepted', 'ticket_reissued', 'ticket_returned',
        'waitlist_offered', 'payment_approved', 'event_autoclosed',
        'door_anomaly'
    ));

-- 2) La funcion del trigger.
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

    -- Se avisa al CRUZAR el umbral, una sola vez por rafaga.
    IF v_n = v_threshold THEN
        PERFORM notify_venue_admins(
            v_venue_id, 'door_anomaly',
            'Duplicados en puerta',
            'La misma boleta se escaneo ' || v_n || ' veces en los ultimos '
              || v_window || ' minutos'
              || CASE WHEN v_name IS NOT NULL AND v_name <> ''
                      THEN ' (' || v_name || ')' ELSE '' END
              || '. Posible QR reenviado: revisa la puerta.',
            '/admin'
        );
    END IF;
    RETURN NEW;
END;
$$;

-- 3) El trigger sobre cada intento de escaneo duplicado.
DROP TRIGGER IF EXISTS trg_redemptions_door_anomaly ON public.redemptions;
CREATE TRIGGER trg_redemptions_door_anomaly
    AFTER INSERT ON public.redemptions
    FOR EACH ROW EXECUTE FUNCTION public.notify_door_anomaly();

COMMIT;
