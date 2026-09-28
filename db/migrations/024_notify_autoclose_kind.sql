-- 024: el kind 'event_autoclosed' entra al catalogo cerrado de notifications.
--
-- Bug (detectado por pytest en base desechable): la watchdog de cierre
-- automatico (mig 020) notifica a los admins con kind 'event_autoclosed',
-- pero ese kind NUNCA entro al CHECK notifications_kind_check (mig 012 lo
-- creo; 021/022/023 agregaron los suyos y nadie sumo este). Resultado: en la
-- primera publicacion vencida real, notify_venue_admins muere con
-- CheckViolation, la watchdog entera se revierte (el router la aísla con
-- rollback, pero el efecto es el mismo) y el evento vencido queda publicado
-- para siempre: venta cerrada que la franja muestra "A la venta".
--
-- Los tests test_published_vencido_no_tumba_el_listado y
-- test_sync_redeems_offline_scan (via door-snapshot) fallaban por esto.

BEGIN;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN (
        'payout_created', 'payout_reviewed', 'payout_disputed',
        'invitation_accepted', 'ticket_reissued', 'ticket_returned',
        'waitlist_offered', 'payment_approved', 'event_autoclosed'
    ));

COMMIT;
