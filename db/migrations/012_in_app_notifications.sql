-- 012: notificaciones in-app (transplante de unicall-blue).
--
-- Patrón tomado de unicall-blue (003_notification_events.sql): la DB escribe
-- las notificaciones con TRIGGERS sobre los eventos de negocio, así ningún
-- router tiene que acordarse de avisar. Diferencias con el original:
--   - Sin RLS ni auth.uid(): en TicketFlow la API es la única puerta y los
--     permisos se resuelven en los routers (ensure_roles).
--   - Multi-tenant: toda notificación cuelga de una venue y de un usuario.
--
-- Eventos que notificamos (los que hoy obligan al admin a estar mirando):
--   * liquidación creada            -> avisa al PROMOTOR (tiene que revisarla)
--   * liquidación revisada (pay/reject/disputa resuelta) -> avisa al PROMOTOR
--   * liquidación disputada         -> avisa al ADMIN (debe resolverla)
--   * invitación aceptada           -> avisa al ADMIN (alguien entró al equipo)
--   * boleta reemitida              -> avisa al ADMIN (uso de poder: se mata
--                                      el QR anterior; queda en ticket_reissues)

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Tabla: una fila por (usuario, evento). `read_at` distingue nueva/leída.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    venue_id    bigint NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    kind        text   NOT NULL CHECK (kind IN
                  ('payout_created', 'payout_reviewed', 'payout_disputed',
                   'invitation_accepted', 'ticket_reissued')),
    title       text   NOT NULL,
    body        text   NOT NULL,
    link        text,
    read_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Dropdown: últimas de un usuario. Parcial: las leídas caen fuera del índice.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications (user_id, created_at DESC)
    WHERE read_at IS NULL;

-- Contador no leídas por venue (campana muestra badge por venue activa).
CREATE INDEX IF NOT EXISTS idx_notifications_venue
    ON notifications (venue_id, user_id);

-- ---------------------------------------------------------------------------
-- 2) notify_user / notify_venue_admin: equivalentes de notify_staff() de
--    unicall-blue. SECURITY DEFINER + search_path fijo (misma disciplina).
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
    INSERT INTO notifications(user_id, venue_id, kind, title, body, link)
    VALUES (p_user_id, p_venue_id, p_kind, p_title, p_body, p_link);
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
    -- Todos los admins de la venue (y super_admin, rol global). Se puede
    -- excluir al actor (p.ej. el admin que acepta la invitación no se
    -- auto-notifica).
    INSERT INTO notifications(user_id, venue_id, kind, title, body, link)
    SELECT r.user_id, p_venue_id, p_kind, p_title, p_body, p_link
    FROM venue_user_roles r
    JOIN users u ON u.id = r.user_id AND u.is_active
    WHERE r.venue_id = p_venue_id
      AND (r.role = 'admin' OR r.role = 'super_admin')
      AND (p_exclude IS NULL OR r.user_id <> p_exclude);
$$;

-- ---------------------------------------------------------------------------
-- 3) Triggers. En unicall-blue disparan sobre INSERT; acá la señal es el
--    cambio de ESTADO (la fila nace pending y solo hay novedad cuando
--    muta), igual que notify_commercial_record_updated() del original.
-- ---------------------------------------------------------------------------

-- 3a) Liquidación: nace -> avisa al promotor; se revisa/disputa -> al otro.
CREATE OR REPLACE FUNCTION notify_payout_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_venue_name text;
BEGIN
    SELECT name INTO v_venue_name FROM venues WHERE id = NEW.venue_id;

    IF TG_OP = 'INSERT' THEN
        PERFORM notify_user(
            NEW.promoter_id, NEW.venue_id, 'payout_created',
            'Nueva liquidación',
            coalesce(v_venue_name, 'La venue') || ': periodo del ' ||
            to_char(NEW.period_start, 'DD/MM') || ' al ' ||
            to_char(NEW.period_end, 'DD/MM') || ' por ' ||
            (NEW.commission_cents / 100)::text || '. Revísala.',
            '/promotor?tab=liquidaciones'
        );
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NEW.status = 'disputed' THEN
            PERFORM notify_venue_admins(
                NEW.venue_id, 'payout_disputed',
                'Liquidación disputada',
                coalesce((SELECT full_name FROM users WHERE id = NEW.promoter_id), 'Un promotor') ||
                ' no está de acuerdo con el cierre del ' ||
                to_char(NEW.period_start, 'DD/MM') || ': "' ||
                coalesce(NEW.disputed_reason, 'sin detalle') || '".',
                '/admin?tab=liquidaciones'
            );
        ELSIF NEW.status = 'paid' THEN
            PERFORM notify_user(
                NEW.promoter_id, NEW.venue_id, 'payout_reviewed',
                'Liquidación pagada',
                'Tu pago del periodo al ' || to_char(NEW.period_end, 'DD/MM') ||
                ' quedó registrado' ||
                CASE WHEN NEW.paid_cents IS NOT NULL
                     THEN ' por ' || (NEW.paid_cents / 100)::text ELSE '' END || '.',
                '/promotor?tab=liquidaciones'
            );
        ELSIF NEW.status = 'rejected' THEN
            PERFORM notify_user(
                NEW.promoter_id, NEW.venue_id, 'payout_reviewed',
                'Liquidación rechazada',
                'El admin no pagó el periodo al ' ||
                to_char(NEW.period_end, 'DD/MM') || ': ' ||
                coalesce(NEW.review_note, 'revisa el detalle con tu admin.'),
                '/promotor?tab=liquidaciones'
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payout_lifecycle_notify ON promoter_payouts;
CREATE TRIGGER trg_payout_lifecycle_notify
AFTER INSERT OR UPDATE OF status ON promoter_payouts
FOR EACH ROW EXECUTE FUNCTION notify_payout_lifecycle();

-- 3b) Invitación aceptada -> avisa a los admins (el actor queda excluido).
--     accepted_user_id nace NULL y solo se llena una vez: UPDATE de ese
--     columna = canje.
CREATE OR REPLACE FUNCTION notify_invitation_accepted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.accepted_user_id IS NOT NULL
       AND NEW.accepted_user_id IS DISTINCT FROM OLD.accepted_user_id THEN
        PERFORM notify_venue_admins(
            NEW.venue_id, 'invitation_accepted',
            'Invitación aceptada',
            -- coalesce obligatorio: un NULL aqui violaria el NOT NULL de
            -- notifications.body y reviertiria el canje entero (el trigger
            -- corre en la misma transacción que el endpoint).
            coalesce(
                (SELECT full_name FROM users WHERE id = NEW.accepted_user_id),
                'Alguien'
            ) || ' entró al equipo como ' || NEW.role || '.',
            '/admin?tab=equipo',
            NEW.accepted_user_id
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invitation_accepted_notify ON staff_invitations;
CREATE TRIGGER trg_invitation_accepted_notify
AFTER UPDATE OF accepted_user_id ON staff_invitations
FOR EACH ROW EXECUTE FUNCTION notify_invitation_accepted();

-- 3c) Boleta reemitida -> avisa a los admins (el QR anterior murió).
CREATE OR REPLACE FUNCTION notify_ticket_reissued()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_venue_id   bigint;
    v_customer   text;
BEGIN
    SELECT e.venue_id, t.customer_name INTO v_venue_id, v_customer
    FROM tickets t JOIN events e ON e.id = t.event_id
    WHERE t.id = NEW.ticket_id;

    IF v_venue_id IS NOT NULL THEN
        PERFORM notify_venue_admins(
            v_venue_id, 'ticket_reissued',
            'Boleta reemitida',
            'Se rotó el QR de la boleta de ' ||
            coalesce(v_customer, 'un invitado') ||
            CASE WHEN NEW.reason IS NOT NULL AND NEW.reason <> ''
                 THEN ' (' || NEW.reason || ')' ELSE '' END || '.',
            '/admin'
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ticket_reissued_notify ON ticket_reissues;
CREATE TRIGGER trg_ticket_reissued_notify
AFTER INSERT ON ticket_reissues
FOR EACH ROW EXECUTE FUNCTION notify_ticket_reissued();

COMMIT;
