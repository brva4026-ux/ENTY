-- =============================================================================
-- Migración 042: lo que faltaba para OPERAR la noche.
--
-- Cuatro huecos del día del evento, todos verificados en el código antes de
-- escribir esto:
--
-- 1. MEDIO DE PAGO. `tickets` guarda `price_cents_snapshot` (lo que DEBÍA
--    cobrarse), pero nada dice si entró en efectivo, por transferencia o por
--    la pasarela. El "Recaudo" del cierre es una suma de precios, no un arqueo:
--    el admin no puede saber cuánto efectivo debería haber en la caja. Los
--    cobros online son trazables por `ticket_payments`; la venta directa (la
--    taquilla) no dejaba rastro. Se agrega `payment_method`.
--
-- 2. AVISO DE AFORO. `emit_ticket` frena al llegar al aforo, pero la PUERTA
--    nunca lo mira: `redeem_ticket` valida la boleta, el estado del evento y la
--    ventana del QR, y nada más. Con venta en puerta + online a la vez, el
--    aforo físico se puede pasar sin que nada avise. Un trigger convierte el
--    cruce de 80%/90% en una notificación (mismo patrón que la 026).
--
-- 3. MULTI-PUERTA. `redemptions` registra QUIÉN escaneó, pero no DÓNDE. Con
--    dos accesos no se puede medir el rendimiento de cada puerta ni balancear
--    el personal. Se agrega `door_id`, tomado de la sesión (`app.door_id`), así
--    que los INSERT existentes de `redeem_ticket` lo heredan sin tocarse.
--
-- 4. TURNO DEL STAFF. `event_staff.shift_start/shift_end` se guardaban y se
--    mostraban, pero nadie los evaluaba: una función a medias que da falsa
--    sensación de control. El gate vive en el router (necesita los roles para
--    el override del admin), no acá.
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Medio de pago de la boleta
-- ---------------------------------------------------------------------------
-- NULLABLE a propósito: las boletas ya emitidas por venta directa no tienen
-- forma de saber retrospectivamente si fueron efectivo o transferencia, y
-- inventar el dato sería peor que no tenerlo. La UI de cierre agrupa el NULL
-- como "sin especificar"; toda emisión NUEVA sí queda clasificada.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS payment_method text;

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_payment_method_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_payment_method_check
    CHECK (payment_method IS NULL OR payment_method IN
           ('online', 'efectivo', 'transferencia', 'cortesia'));

-- Backfill honesto: lo que SÍ se puede deducir.
--   * precio 0 -> cortesía (una boleta gratis es cortesía por definición).
UPDATE tickets SET payment_method = 'cortesia'
 WHERE payment_method IS NULL AND price_cents_snapshot = 0;

--   * con un cobro aprobado en `ticket_payments` -> online.
UPDATE tickets SET payment_method = 'online'
 WHERE payment_method IS NULL AND price_cents_snapshot > 0
   AND EXISTS (
       SELECT 1 FROM ticket_payments p
        WHERE p.ticket_id = tickets.id AND p.status = 'approved'
   );
-- El resto (venta directa histórica de pago) queda NULL: no se adivina.

-- Índice para el desglose de caja del cierre (agrupa por medio en un evento).
CREATE INDEX IF NOT EXISTS idx_tickets_event_payment_method
    ON tickets (event_id, payment_method);

-- ---------------------------------------------------------------------------
-- 2) `emit_ticket` clasifica el medio de pago
-- ---------------------------------------------------------------------------
-- OJO: CREATE OR REPLACE FUNCTION NO reemplaza al agregar un parámetro —
-- crea una SOBRECARGA. Con las dos firmas vivas, la llamada de 8 argumentos
-- (la de los tests, el seed y la waitlist) sería AMBIGUA y reventaría con
-- "function is not unique". Hay que tirar la firma vieja primero. Es seguro:
-- PL/pgSQL no crea dependencias duras sobre las funciones que llama.
DROP FUNCTION IF EXISTS public.emit_ticket(
    bigint, bigint, bigint, bigint, text, text, text, text
);

-- El parámetro va AL FINAL con DEFAULT: las llamadas existentes (tests,
-- waitlist, payments) siguen funcionando sin cambios.
CREATE OR REPLACE FUNCTION public.emit_ticket(p_event_id bigint, p_ticket_type_id bigint, p_allocation_id bigint, p_sold_by_user_id bigint, p_customer_name text, p_raw_token text, p_customer_phone text DEFAULT NULL::text, p_customer_email text DEFAULT NULL::text, p_payment_method text DEFAULT NULL::text) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_type           ticket_types%ROWTYPE;
    v_alloc          promoter_allocations%ROWTYPE;
    v_used_in_alloc  bigint;
    v_used_in_type   bigint;
    v_used_total     bigint;
    v_event_capacity bigint;
    v_status_allowed text;
    v_token_hash     text;
    v_ticket_id      bigint;
    v_payment_method text;
BEGIN
    -- Bloquea la localidad: serializa emisiones concurrentes contra su cupo.
    SELECT * INTO v_type FROM ticket_types WHERE id = p_ticket_type_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_type_not_found'; END IF;
    IF v_type.event_id <> p_event_id THEN
        RAISE EXCEPTION 'ticket_type_not_in_event';
    END IF;

    IF v_type.price_cents > 0 AND p_allocation_id IS NOT NULL THEN
        RAISE EXCEPTION 'paid_ticket_tied_to_promoter_allocation: usar venta directa para boletas de pago';
    END IF;

    -- Medio de pago: una boleta gratis es cortesía por definición (no hay
    -- dinero que conciliar). Una de pago sin método explícito se asume venta
    -- directa en efectivo (la taquilla es el caso por defecto del bar).
    IF v_type.price_cents = 0 THEN
        v_payment_method := 'cortesia';
    ELSE
        v_payment_method := COALESCE(p_payment_method, 'efectivo');
        IF v_payment_method NOT IN ('online', 'efectivo', 'transferencia') THEN
            RAISE EXCEPTION 'invalid_payment_method';
        END IF;
    END IF;

    -- 1) Bloquear el evento: serializa emisiones concurrentes y valida estado.
    SELECT capacity, status INTO v_event_capacity, v_status_allowed
      FROM events WHERE id = p_event_id FOR UPDATE;
    IF v_status_allowed NOT IN ('published', 'live') THEN
        RAISE EXCEPTION 'event_not_open_for_sales';
    END IF;

    -- 2) Cupo del promotor (si aplica): bloquear fila y validar capacidad.
    IF p_allocation_id IS NOT NULL THEN
        SELECT * INTO v_alloc FROM promoter_allocations WHERE id = p_allocation_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'allocation_not_found'; END IF;
        SELECT count(*) INTO v_used_in_alloc
          FROM tickets
         WHERE allocation_id = p_allocation_id
           AND status NOT IN ('voided', 'refunded');
        IF v_used_in_alloc >= v_alloc.capacity THEN
            RAISE EXCEPTION 'promoter_quota_exceeded';
        END IF;
    END IF;

    -- 3) Inventario DE ESTA LOCALIDAD (mig 033): el tope es el suyo, no la
    -- suma de todas. Antes, una localidad chica se podía sobrevender con el
    -- sobrante de las demás.
    SELECT count(*) INTO v_used_in_type
      FROM tickets
     WHERE event_id = p_event_id
       AND ticket_type_id = p_ticket_type_id
       AND status NOT IN ('voided', 'refunded');
    IF v_used_in_type >= v_type.quantity THEN
        RAISE EXCEPTION 'ticket_type_sold_out';
    END IF;

    -- 3b) Aforo físico del evento (tope distinto del inventario por localidad).
    SELECT count(*) INTO v_used_total
      FROM tickets
     WHERE event_id = p_event_id
       AND status NOT IN ('voided', 'refunded');
    IF v_used_total >= v_event_capacity THEN
        RAISE EXCEPTION 'event_at_capacity';
    END IF;

    v_token_hash := encode(digest(p_raw_token, 'sha256'), 'hex');

    INSERT INTO tickets (
        event_id, ticket_type_id, allocation_id, sold_by_user_id,
        customer_name, customer_phone, customer_email, token_hash,
        price_cents_snapshot, payment_method
    ) VALUES (
        p_event_id, p_ticket_type_id, p_allocation_id, p_sold_by_user_id,
        p_customer_name, p_customer_phone, p_customer_email, v_token_hash,
        v_type.price_cents, v_payment_method
    ) RETURNING id INTO v_ticket_id;

    RETURN v_ticket_id;
END;
$$;

-- La pasarela SÍ sabe el medio: los cobros aprobados son 'online'.
CREATE OR REPLACE FUNCTION public.approve_ticket_payment(p_reference text, p_transaction_id text, p_status text, p_amount_in_cents bigint, p_raw_token text, p_payload jsonb DEFAULT NULL::jsonb) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_payment  ticket_payments%ROWTYPE;
    v_ticket   bigint;
    v_event    events%ROWTYPE;
    v_type     ticket_types%ROWTYPE;
BEGIN
    SELECT * INTO v_payment FROM ticket_payments
     WHERE reference = p_reference
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'payment_not_found';
    END IF;

    -- Idempotencia: el reintento del webhook llega aqui con el cobro ya
    -- aprobado. Devolver el MISMO ticket_id sin tocar nada.
    IF v_payment.status = 'approved' THEN
        RETURN v_payment.ticket_id;
    END IF;

    IF p_status <> 'APPROVED' THEN
        -- Estados finales no aprobados (DECLINED/VOIDED/ERROR) e
        -- intermedios: quedan auditados, no emiten. El cobro muere y el
        -- bar crea uno nuevo (una referencia no se reutiliza).
        UPDATE ticket_payments
           SET transaction_id = COALESCE(p_transaction_id, transaction_id),
               status = CASE p_status
                            WHEN 'DECLINED' THEN 'declined'
                            WHEN 'VOIDED'   THEN 'voided'
                            WHEN 'ERROR'    THEN 'expired'
                            ELSE status
                        END,
               raw_payload = COALESCE(p_payload, raw_payload)
         WHERE id = v_payment.id;
        RETURN NULL;
    END IF;

    -- Un cobro que ya termino mal no revive (Wompi no pasa de un estado
    -- final a APPROVED; si llegara a pasar, el 409 de la API lo hace
    -- visible en lugar de emitir gratis).
    IF v_payment.status <> 'pending' THEN
        RAISE EXCEPTION 'payment_not_approvable';
    END IF;

    -- El monto pagado debe ser EXACTAMENTE el cobrado.
    IF p_amount_in_cents <> v_payment.amount_in_cents THEN
        RAISE EXCEPTION 'payment_amount_mismatch';
    END IF;

    SELECT * INTO v_event FROM events WHERE id = v_payment.event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'event_not_found';
    END IF;
    -- Misma guardia que emit_ticket: un evento cerrado no vende (si el fan
    -- pago tarde, el dinero esta pero la boleta no se emite: el 409 deja
    -- la situacion visible para resolverla a mano).
    IF v_event.status NOT IN ('published', 'live') THEN
        RAISE EXCEPTION 'event_not_open_for_sales';
    END IF;

    SELECT * INTO v_type FROM ticket_types WHERE id = v_payment.ticket_type_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ticket_type_not_found';
    END IF;

    -- Emision de venta directa: cupo NULL (una boleta de pago no usa cupo
    -- de promotor) y created_by = quien creo el cobro (reportes "vendida
    -- por"). La DB jamas devuelve el token: lo guarda hasheado.
    v_ticket := emit_ticket(
        v_payment.event_id,
        v_payment.ticket_type_id,
        NULL,
        v_payment.created_by_user_id,
        v_payment.customer_name,
        p_raw_token,
        v_payment.customer_phone,
        v_payment.customer_email,
        'online'
    );

    UPDATE ticket_payments
       SET status = 'approved',
           transaction_id = COALESCE(p_transaction_id, transaction_id),
           approved_at = now(),
           ticket_id = v_ticket,
           raw_payload = COALESCE(p_payload, raw_payload)
     WHERE id = v_payment.id;

    PERFORM notify_venue_admins(
        v_payment.venue_id,
        'payment_approved',
        'Pago aprobado',
        format(
            'Pago de %s aprobado por Wompi: la boleta esta lista para entregar en el listado del evento.',
            v_payment.customer_name
        ),
        format('/admin?event=%s&tab=entradas', v_payment.event_id)
    );

    RETURN v_ticket;
END
$$;

-- ---------------------------------------------------------------------------
-- 3) Multi-puerta: `door_id` en cada intento de escaneo
-- ---------------------------------------------------------------------------
-- `redeem_ticket` gana un parámetro `p_door_id` (al final, con DEFAULT) y lo
-- escribe en cada una de sus 9 ramas de log. Se pasa explícito desde el router
-- en vez de leerlo de un GUC de sesión: con `autocommit=True` y pooling de
-- conexiones (Supabase/PgBouncer), un `SET LOCAL` no tiene una transacción que
-- lo acote y se filtraría entre requests. Un parámetro no tiene ese riesgo y
-- además es testeable.
--
-- OJO: CREATE OR REPLACE no reemplaza al agregar parámetros (crea sobrecarga),
-- así que se tira la firma vieja de 5 argumentos primero.
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS door_id text;

CREATE INDEX IF NOT EXISTS idx_redemptions_event_door
    ON redemptions (event_id, door_id);

DROP FUNCTION IF EXISTS public.redeem_ticket(
    bigint, text, bigint, bigint, timestamp with time zone
);

-- El cuerpo completo, con el nuevo parámetro al final.
CREATE OR REPLACE FUNCTION public.redeem_ticket(p_event_id bigint, p_raw_token text, p_scanned_by_user_id bigint, p_expected_ticket_type_id bigint DEFAULT NULL::bigint, p_scanned_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_door_id text DEFAULT NULL::text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_ticket tickets%ROWTYPE;
    v_token_hash text;
    v_event_status text;
    v_event_starts_at timestamptz;
    v_event_unlock integer;
    v_scanned_at timestamptz;
    v_door_id    text;
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

    SELECT status, starts_at, qr_unlock_minutes
      INTO v_event_status, v_event_starts_at, v_event_unlock
      FROM events WHERE id = p_event_id;
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

    IF v_ticket.status = 'voided' OR v_ticket.status = 'refunded' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'not_valid', v_scanned_at, v_door_id);
        RETURN 'NOT_VALID';
    END IF;

    IF v_ticket.status = 'redeemed' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'already_redeemed', v_scanned_at, v_door_id);
        RETURN 'ALREADY_REDEEMED';
    END IF;

    -- Compare-and-swap: exactamente UNA de las filas concurrentes sera afectada.
    UPDATE tickets
       SET status = 'redeemed', redeemed_at = v_scanned_at, redeemed_by_user_id = p_scanned_by_user_id
     WHERE id = v_ticket.id AND status = 'issued';

    IF NOT FOUND THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'already_redeemed', v_scanned_at, v_door_id);
        RETURN 'ALREADY_REDEEMED';
    END IF;

    INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at, door_id)
    VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'granted', v_scanned_at, v_door_id);
    RETURN 'GRANTED';
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) Aviso de aforo: 80% y 90% al cruzar el umbral
-- ---------------------------------------------------------------------------
-- Entra al catálogo cerrado de notifications (mig 012/024/026).
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN (
        'payout_created', 'payout_reviewed', 'payout_disputed',
        'invitation_accepted', 'ticket_reissued', 'ticket_returned',
        'waitlist_offered', 'payment_approved', 'event_autoclosed',
        'door_anomaly', 'capacity_alert'
    ));

-- Se avisa al CRUZAR el umbral (una sola vez por umbral), no en cada ingreso
-- posterior: si contara cada uno, la campana se llenaría a partir del 80%.
-- El conteo es de INGRESOS (granted), que es lo que ocupa el aforo físico.
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
            '/admin'
        );
    ELSIF v_granted = v_80 THEN
        PERFORM notify_venue_admins(
            v_venue_id, 'capacity_alert',
            'Aforo al 80%',
            'Ya entraron ' || v_granted || ' de ' || v_capacity
              || CASE WHEN v_name IS NOT NULL AND v_name <> '' 
                      THEN ' (' || v_name || ')' ELSE '' END
              || '. Queda poco cupo en la puerta.',
            '/admin'
        );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_redemptions_capacity_alert ON public.redemptions;
CREATE TRIGGER trg_redemptions_capacity_alert
    AFTER INSERT ON public.redemptions
    FOR EACH ROW EXECUTE FUNCTION public.notify_capacity_alert();

-- =============================================================================
-- Prueba funcional con rollback total.
-- =============================================================================
DO $$
DECLARE
    v_venue  bigint;
    v_event  bigint;
    v_type   bigint;
    v_tt     bigint;
    v_ticket bigint;
    v_method text;
    v_door   text;
    v_admin  bigint;
    v_tag    text := md5(random()::text);
BEGIN
    INSERT INTO venues (name, slug)
        VALUES ('test-ops-042-' || v_tag, 'test-ops-042-' || v_tag)
        RETURNING id INTO v_venue;
    -- El aviso de aforo sale por notify_venue_admins: sin un admin en la venue
    -- no habría destinatario y la prueba no probaría el aviso.
    INSERT INTO users (email, password_hash, full_name)
        VALUES ('ops-042-' || v_tag || '@example.com', 'x', 'Admin 042')
        RETURNING id INTO v_admin;
    INSERT INTO venue_user_roles (venue_id, user_id, role)
        VALUES (v_venue, v_admin, 'admin');
    INSERT INTO events (venue_id, name, starts_at, capacity, status)
        VALUES (v_venue, 'Noche 042', now(), 10, 'live')
        RETURNING id INTO v_event;
    INSERT INTO ticket_types (event_id, name, price_cents, quantity)
        VALUES (v_event, 'General', 5000, 100)
        RETURNING id INTO v_type;
    INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy)
        VALUES (v_event, 'Cortesía', 0, 100, TRUE)
        RETURNING id INTO v_tt;

    -- Venta directa sin método explícito -> efectivo.
    v_ticket := emit_ticket(v_event, v_type, NULL, NULL, 'A', 'tok-042-a', NULL, NULL);
    SELECT payment_method INTO v_method FROM tickets WHERE id = v_ticket;
    IF v_method <> 'efectivo' THEN
        RAISE EXCEPTION 'TEST_FAIL default_paid_not_efectivo: %', v_method;
    END IF;

    -- Transferencia explícita.
    v_ticket := emit_ticket(v_event, v_type, NULL, NULL, 'B', 'tok-042-b', NULL, NULL, 'transferencia');
    SELECT payment_method INTO v_method FROM tickets WHERE id = v_ticket;
    IF v_method <> 'transferencia' THEN
        RAISE EXCEPTION 'TEST_FAIL explicit_method_ignored: %', v_method;
    END IF;

    -- Boleta gratis -> cortesía, aunque pidan otra cosa.
    v_ticket := emit_ticket(v_event, v_tt, NULL, NULL, 'C', 'tok-042-c', NULL, NULL, 'efectivo');
    SELECT payment_method INTO v_method FROM tickets WHERE id = v_ticket;
    IF v_method <> 'cortesia' THEN
        RAISE EXCEPTION 'TEST_FAIL free_ticket_not_cortesia: %', v_method;
    END IF;

    -- Método inválido en una boleta de pago -> rechazo.
    BEGIN
        PERFORM emit_ticket(v_event, v_type, NULL, NULL, 'D', 'tok-042-d', NULL, NULL, 'bitcoin');
        RAISE EXCEPTION 'TEST_FAIL invalid_method_accepted';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'invalid_payment_method' THEN RAISE; END IF;
    END;

    -- door_id: sin valor queda NULL; con valor se registra en el log.
    PERFORM redeem_ticket(v_event, 'tok-042-a', NULL, NULL, NULL);
    SELECT door_id INTO v_door FROM redemptions
     WHERE event_id = v_event AND outcome = 'granted' ORDER BY id DESC LIMIT 1;
    IF v_door IS NOT NULL THEN
        RAISE EXCEPTION 'TEST_FAIL door_id_without_param: %', v_door;
    END IF;

    PERFORM redeem_ticket(v_event, 'tok-042-b', NULL, NULL, NULL, 'puerta-2');
    SELECT door_id INTO v_door FROM redemptions
     WHERE event_id = v_event AND outcome = 'granted' ORDER BY id DESC LIMIT 1;
    IF v_door <> 'puerta-2' THEN
        RAISE EXCEPTION 'TEST_FAIL door_id_not_recorded: %', v_door;
    END IF;

    -- Aviso de aforo: aforo 10 -> 80% = 8, 90% = 9. Al 8vo ingreso avisa 80%.
    -- Ya van 2; faltan 6 para llegar a 8.
    FOR i IN 1..6 LOOP
        v_ticket := emit_ticket(v_event, v_type, NULL, NULL, 'G' || i,
                                'tok-042-g' || i, NULL, NULL);
        PERFORM redeem_ticket(v_event, 'tok-042-g' || i, NULL, NULL, NULL);
    END LOOP;
    IF (SELECT count(*) FROM notifications
         WHERE venue_id = v_venue AND kind = 'capacity_alert'
           AND title = 'Aforo al 80%') <> 1 THEN
        RAISE EXCEPTION 'TEST_FAIL no_80pct_alert';
    END IF;

    -- El 9no ingreso cruza el 90%.
    v_ticket := emit_ticket(v_event, v_type, NULL, NULL, 'G9', 'tok-042-g9',
                            NULL, NULL);
    PERFORM redeem_ticket(v_event, 'tok-042-g9', NULL, NULL, NULL);
    IF (SELECT count(*) FROM notifications
         WHERE venue_id = v_venue AND kind = 'capacity_alert'
           AND title = 'Aforo al 90%') <> 1 THEN
        RAISE EXCEPTION 'TEST_FAIL no_90pct_alert';
    END IF;

    RAISE NOTICE 'OK_TEST';

    -- Autolimpieza (mismo criterio que la 015): el CASCADE arrastra eventos,
    -- boletas, redenciones y notificaciones de esta venue de prueba.
    DELETE FROM venues WHERE id = v_venue;
    DELETE FROM users WHERE id = v_admin;
END $$;

COMMIT;
