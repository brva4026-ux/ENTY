-- Migración 014: dos piezas independientes.
--
-- 1) OUTBOX DE PUSH: las notificaciones in-app (mig 012) nacen en triggers
--    dentro de la transacción de negocio; enviar push desde ahí acoplaría la
--    red al INSERT. Patrón outbox: el trigger deja la "carta" en push_outbox
--    y un worker en el proceso API la drena (send_web_push) y marca
--    procesada. Un reinicio del server no pierde avisos: lo no procesado
--    sobrevive y se drena al arrancar.
--
-- 2) LUGAR DEL EVENTO (events.location): la boleta del invitado decía la
--    fecha y la venue, pero NO dónde es. Texto libre, opcional: la dirección
--    la escribe el admin al crear/editar el evento y viaja al preview, al
--    JPEG y a la página pública.

-- ---------------------------------------------------------------------------
-- 1) Outbox de push
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    notification_id bigint NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    processed_at    timestamptz            -- NULL = pendiente de drenar
);

-- El worker drena por orden de llegada y solo lo pendiente.
CREATE INDEX IF NOT EXISTS idx_push_outbox_pending
    ON push_outbox (id) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2) Lugar del evento
-- ---------------------------------------------------------------------------
ALTER TABLE events ADD COLUMN IF NOT EXISTS location text;

-- ---------------------------------------------------------------------------
-- 3) notify_user / notify_venue_admins dejan también la carta de push.
--    MISMAS firmas que la mig 012 (los triggers no se tocan): la única
--    diferencia es que el INSERT de notifications devuelve el id y ese id
--    alimenta push_outbox. Escribir notificación = escribir push pendiente,
--    en la MISMA transacción (atómico: o ambas o ninguna).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_user(
    p_user_id  bigint,
    p_venue_id bigint,
    p_kind     text,
    p_title    text,
    p_body     text,
    p_link     text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    WITH n AS (
        INSERT INTO notifications(user_id, venue_id, kind, title, body, link)
        VALUES (p_user_id, p_venue_id, p_kind, p_title, p_body, p_link)
        RETURNING id
    )
    INSERT INTO push_outbox(notification_id)
    SELECT id FROM n;
$$;

CREATE OR REPLACE FUNCTION notify_venue_admins(
    p_venue_id bigint,
    p_kind     text,
    p_title    text,
    p_body     text,
    p_link     text DEFAULT NULL,
    p_exclude  bigint DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    -- Todos los admins de la venue (y super_admin, rol global), menos el
    -- actor si p_exclude lo pide. Cada notificación genera SU carta de push.
    WITH admins AS (
        SELECT r.user_id
        FROM venue_user_roles r
        JOIN users u ON u.id = r.user_id AND u.is_active
        WHERE r.venue_id = p_venue_id
          AND (r.role = 'admin' OR r.role = 'super_admin')
          AND (p_exclude IS NULL OR r.user_id <> p_exclude)
    ),
    n AS (
        INSERT INTO notifications(user_id, venue_id, kind, title, body, link)
        SELECT user_id, p_venue_id, p_kind, p_title, p_body, p_link FROM admins
        RETURNING id
    )
    INSERT INTO push_outbox(notification_id)
    SELECT id FROM n;
$$;
