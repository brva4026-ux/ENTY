-- 061: cada aviso operativo abre la pantalla donde se resuelve.
--
-- Los avisos de aforo y de boleta reemitida no decían de qué evento hablaban
-- ni llevaban al backstage correcto. La campana ya sabe mapear kind -> pestaña;
-- aquí se guarda el evento en el enlace y se agrega el nombre al cuerpo.
--
-- El recordatorio de turno del staff apuntaba a /admin, una ruta que un
-- bouncer o promotor no puede abrir. Ahora cada rol recibe su propia app.

BEGIN;

CREATE OR REPLACE FUNCTION public.notify_capacity_alert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_capacity int;
    v_venue_id bigint;
    v_name     text;
    v_granted  int;
    v_80       int;
    v_90       int;
BEGIN
    IF NEW.outcome NOT IN ('granted', 'granted_forced') THEN
        RETURN NEW;
    END IF;

    SELECT e.capacity, e.venue_id, e.name
      INTO v_capacity, v_venue_id, v_name
      FROM events e WHERE e.id = NEW.event_id;
    IF v_capacity IS NULL OR v_capacity <= 0 THEN
        RETURN NEW;
    END IF;

    SELECT count(*) INTO v_granted
      FROM redemptions
     WHERE event_id = NEW.event_id
       AND outcome IN ('granted', 'granted_forced');

    v_80 := ceil(v_capacity * 0.8);
    v_90 := ceil(v_capacity * 0.9);

    -- Se mira el 90% primero: en aforos chicos los dos umbrales pueden caer en
    -- el mismo ingreso, y avisar "90%" es el dato más urgente.
    IF v_granted = v_90 THEN
        PERFORM notify_venue_admins(
            v_venue_id, 'capacity_alert',
            'Aforo al 90%',
            'Ya entraron ' || v_granted || ' de ' || v_capacity
              || CASE WHEN v_name IS NOT NULL AND v_name <> ''
                      THEN ' (' || v_name || ')' ELSE '' END
              || '. El evento está por llenarse.',
            '/admin?event=' || NEW.event_id || '&tab=accesos'
        );
    ELSIF v_granted = v_80 THEN
        PERFORM notify_venue_admins(
            v_venue_id, 'capacity_alert',
            'Aforo al 80%',
            'Ya entraron ' || v_granted || ' de ' || v_capacity
              || CASE WHEN v_name IS NOT NULL AND v_name <> ''
                      THEN ' (' || v_name || ')' ELSE '' END
              || '. Queda poco cupo en la puerta.',
            '/admin?event=' || NEW.event_id || '&tab=accesos'
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_event_reminders() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_row   events%ROWTYPE;
    v_count integer := 0;
BEGIN
    FOR v_row IN
        SELECT * FROM events
         WHERE status IN ('published', 'live')
           AND reminded_at IS NULL
           AND starts_at > now()
           AND starts_at <= now() + INTERVAL '2 hours'
         FOR UPDATE SKIP LOCKED
    LOOP
        PERFORM notify_venue_admins(
            v_row.venue_id, 'event_reminder',
            'Tu evento empieza pronto',
            'Faltan menos de 2 horas para "' || v_row.name
              || '". Revisa equipo, aforo y puerta.',
            '/admin?event=' || v_row.id
        );

        -- El staff asignado (bouncers/promotores) también se entera.
        PERFORM notify_user(
            s.user_id, v_row.venue_id, 'event_reminder',
            'Tu turno empieza pronto',
            'Faltan menos de 2 horas para "' || v_row.name || '".',
            CASE s.role
                WHEN 'bouncer' THEN '/bouncer?evento=' || v_row.id
                WHEN 'promotor' THEN '/promotor'
                ELSE '/admin?event=' || v_row.id
            END
        )
        FROM event_staff s WHERE s.event_id = v_row.id;

        UPDATE events SET reminded_at = now() WHERE id = v_row.id;
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_ticket_reissued() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_venue_id   bigint;
    v_event_id   bigint;
    v_event_name text;
    v_customer   text;
BEGIN
    SELECT e.venue_id, e.id, e.name, t.customer_name
      INTO v_venue_id, v_event_id, v_event_name, v_customer
    FROM tickets t JOIN events e ON e.id = t.event_id
    WHERE t.id = NEW.ticket_id;

    IF v_venue_id IS NOT NULL THEN
        PERFORM notify_venue_admins(
            v_venue_id, 'ticket_reissued',
            'Boleta reemitida',
            'Se rotó el QR de la boleta de ' ||
            coalesce(v_customer, 'un invitado') ||
            CASE WHEN v_event_name IS NOT NULL AND v_event_name <> ''
                 THEN ' para "' || v_event_name || '"' ELSE '' END ||
            CASE WHEN NEW.reason IS NOT NULL AND NEW.reason <> ''
                 THEN ' (' || NEW.reason || ')' ELSE '' END || '.',
            '/admin?event=' || v_event_id || '&tab=ventas'
        );
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
