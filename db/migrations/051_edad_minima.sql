-- =============================================================================
-- Migración 051: edad mínima REAL (antes era solo un dato de la ficha).
--
-- Contexto: `events.min_age` existía desde la mig 043 y se mostraba en la
-- ficha pública ("Edad mínima: 18+"), pero NO se validaba en ningún punto:
-- ni al comprar, ni en la puerta. Cualquier persona de cualquier edad entraba
-- a cualquier evento. Una prueba con 20 personas de 8 a 78 años lo confirmó:
-- 15 ingresos que debían rechazarse (un niño de 8 años entró a un "21+").
--
-- El problema de fondo: no había de dónde saber la edad. `users` no guarda
-- fecha de nacimiento y el checkout solo pedía nombre y teléfono. Sin capturar
-- el dato, "18+" es decoración.
--
-- Qué hace esta migración:
--   1. Guarda `customer_birth_date` en la boleta y en el cobro (ticket_payments)
--      para poder auditar y para que la puerta tenga una segunda barrera.
--   2. `emit_ticket` valida la edad AL EMITIR (es donde se conoce la fecha,
--      la declara el comprador) contra la FECHA DEL EVENTO — quien cumple los
--      años antes de la fiesta entra. Sin fecha de nacimiento no hay nada que
--      verificar (venta de taquilla a ciegas): se permite, como antes.
--   3. `reserve_ticket_payment` valida ANTES de cobrar: rechazar al fan antes
--      de que pague evita un pago en 'paid_unfulfilled' y un reembolso manual.
--   4. `approve_ticket_payment` propaga la fecha del cobro a la boleta.
--   5. `redeem_ticket` valida también en la puerta: una boleta emitida antes
--      de activar la restricción (o con la fecha cambiada después) no entra.
--
-- Código de error nuevo: `under_age_restriction`.
--
-- Idempotente: safe re-run (ADD COLUMN IF NOT EXISTS + DROP de la firma vieja
-- + CREATE OR REPLACE de la nueva, como la mig 042).
-- =============================================================================

BEGIN;

-- 1) Dónde vive la fecha de nacimiento declarada por el comprador.
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS customer_birth_date date;
ALTER TABLE public.ticket_payments
  ADD COLUMN IF NOT EXISTS customer_birth_date date;

-- 2) emit_ticket: firma nueva (ganó p_customer_birth_date al final).
--    CREATE OR REPLACE NO cambia la firma: hay que soltar la vieja primero.
DROP FUNCTION IF EXISTS public.emit_ticket(
    bigint, bigint, bigint, bigint, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.emit_ticket(p_event_id bigint, p_ticket_type_id bigint, p_allocation_id bigint, p_sold_by_user_id bigint, p_customer_name text, p_raw_token text, p_customer_phone text DEFAULT NULL::text, p_customer_email text DEFAULT NULL::text, p_payment_method text DEFAULT NULL::text, p_customer_birth_date date DEFAULT NULL::date) RETURNS bigint
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
    v_event_min_age  integer;
    v_event_starts_at timestamptz;
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
    SELECT capacity, status, min_age, starts_at
      INTO v_event_capacity, v_status_allowed, v_event_min_age, v_event_starts_at
      FROM events WHERE id = p_event_id FOR UPDATE;
    IF v_status_allowed NOT IN ('published', 'live') THEN
        RAISE EXCEPTION 'event_not_open_for_sales';
    END IF;

    -- 1b) Edad mínima del evento (mig 051): la restricción se aplica AL
    -- EMITIR, no al escanear, porque la fecha de nacimiento solo se conoce
    -- aquí (es el comprador quien la declara). Se compara contra la fecha de
    -- inicio del evento, no contra hoy: quien cumple los años antes de la
    -- fiesta puede entrar. Sin fecha de nacimiento no hay verificación
    -- posible (venta de taquilla a ciegas): se permite, como antes.
    IF v_event_min_age IS NOT NULL AND v_event_min_age > 0
       AND p_customer_birth_date IS NOT NULL THEN
        IF date_part('year', age(v_event_starts_at::date, p_customer_birth_date)) < v_event_min_age THEN
            RAISE EXCEPTION 'under_age_restriction';
        END IF;
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
    v_used_in_type := v_used_in_type + (SELECT count(*) FROM ticket_payments
     WHERE ticket_type_id=p_ticket_type_id AND status='pending' AND reservation_expires_at > now());
    IF v_used_in_type >= v_type.quantity THEN
        RAISE EXCEPTION 'ticket_type_sold_out';
    END IF;

    -- 3b) Aforo físico del evento (tope distinto del inventario por localidad).
    SELECT count(*) INTO v_used_total
      FROM tickets
     WHERE event_id = p_event_id
       AND status NOT IN ('voided', 'refunded');
    v_used_total := v_used_total + (SELECT count(*) FROM ticket_payments
     WHERE event_id=p_event_id AND status='pending' AND reservation_expires_at > now());
    IF v_used_total >= v_event_capacity THEN
        RAISE EXCEPTION 'event_at_capacity';
    END IF;

    v_token_hash := encode(digest(p_raw_token, 'sha256'), 'hex');

    INSERT INTO tickets (
        event_id, ticket_type_id, allocation_id, sold_by_user_id,
        customer_name, customer_phone, customer_email, customer_birth_date,
        token_hash, price_cents_snapshot, payment_method
    ) VALUES (
        p_event_id, p_ticket_type_id, p_allocation_id, p_sold_by_user_id,
        p_customer_name, p_customer_phone, p_customer_email, p_customer_birth_date,
        v_token_hash, v_type.price_cents, v_payment_method
    ) RETURNING id INTO v_ticket_id;

    RETURN v_ticket_id;
END;
$$;

-- 3) reserve_ticket_payment: firma nueva (ganó p_birth_date al final).
DROP FUNCTION IF EXISTS public.reserve_ticket_payment(
    bigint, bigint, text, bigint, text, text, text, bigint, bigint, bigint, timestamptz);

CREATE OR REPLACE FUNCTION public.reserve_ticket_payment(p_event_id bigint, p_type_id bigint, p_reference text, p_amount bigint, p_name text, p_phone text, p_email text, p_user_id bigint, p_coupon_id bigint, p_discount bigint, p_expires timestamptz, p_birth_date date DEFAULT NULL::date) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_type ticket_types%ROWTYPE;
    v_event events%ROWTYPE;
    v_coupon coupons%ROWTYPE;
    v_count bigint;
    v_id bigint;
BEGIN
    -- Mismo orden de locks que emit_ticket: localidad, evento, cupon.
    SELECT * INTO v_type FROM ticket_types WHERE id=p_type_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_type_not_found'; END IF;
    IF v_type.event_id <> p_event_id THEN RAISE EXCEPTION 'ticket_type_not_in_event'; END IF;
    IF NOT v_type.is_active THEN RAISE EXCEPTION 'ticket_type_inactive'; END IF;
    SELECT * INTO v_event FROM events WHERE id=p_event_id FOR UPDATE;
    IF v_event.status NOT IN ('published','live') THEN RAISE EXCEPTION 'event_not_open_for_sales'; END IF;
    IF p_expires <= now() THEN RAISE EXCEPTION 'payment_reservation_expired'; END IF;

    -- Edad mínima (mig 051): se valida ANTES de cobrar. Cobrar y luego no
    -- poder emitir dejaria el pago en 'paid_unfulfilled' y obligaria a un
    -- reembolso manual: mejor rechazar al fan antes de que pague. Misma regla
    -- que emit_ticket (se compara contra la fecha del evento, y sin fecha de
    -- nacimiento no hay nada que verificar).
    IF v_event.min_age IS NOT NULL AND v_event.min_age > 0
       AND p_birth_date IS NOT NULL THEN
        IF date_part('year', age(v_event.starts_at::date, p_birth_date)) < v_event.min_age THEN
            RAISE EXCEPTION 'under_age_restriction';
        END IF;
    END IF;

    SELECT count(*) INTO v_count FROM tickets
     WHERE ticket_type_id=p_type_id AND status NOT IN ('voided','refunded');
    v_count := v_count + (SELECT count(*) FROM ticket_payments
     WHERE ticket_type_id=p_type_id AND status='pending' AND reservation_expires_at > now());
    IF v_count >= v_type.quantity THEN RAISE EXCEPTION 'ticket_type_sold_out'; END IF;
    SELECT count(*) INTO v_count FROM tickets
     WHERE event_id=p_event_id AND status NOT IN ('voided','refunded');
    v_count := v_count + (SELECT count(*) FROM ticket_payments
     WHERE event_id=p_event_id AND status='pending' AND reservation_expires_at > now());
    IF v_count >= v_event.capacity THEN RAISE EXCEPTION 'event_at_capacity'; END IF;

    IF p_coupon_id IS NOT NULL THEN
        SELECT * INTO v_coupon FROM coupons WHERE id=p_coupon_id AND event_id=p_event_id FOR UPDATE;
        IF NOT FOUND OR NOT v_coupon.is_active OR v_coupon.expires_at <= now() THEN
            RAISE EXCEPTION 'coupon_unavailable';
        END IF;
        SELECT count(*) INTO v_count FROM ticket_payments
         WHERE coupon_id=p_coupon_id AND status='pending' AND reservation_expires_at > now();
        IF v_coupon.max_uses IS NOT NULL AND v_coupon.used_count + v_count >= v_coupon.max_uses THEN
            RAISE EXCEPTION 'coupon_unavailable';
        END IF;
    END IF;
    INSERT INTO ticket_payments (venue_id,event_id,ticket_type_id,reference,
        amount_in_cents,customer_name,customer_phone,customer_email,created_by_user_id,
        coupon_id,discount_in_cents,reservation_expires_at,customer_birth_date)
    VALUES (v_event.venue_id,p_event_id,p_type_id,p_reference,p_amount,p_name,p_phone,
        p_email,p_user_id,p_coupon_id,p_discount,p_expires,p_birth_date) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- 4) approve_ticket_payment: misma firma, cambia el cuerpo (propaga la fecha
--    del cobro a la boleta al emitir).

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
    IF v_payment.status IN ('approved', 'paid_unfulfilled') THEN
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

    BEGIN
        -- Libera solo NUESTRA reserva dentro de esta transaccion; los locks
        -- de emit_ticket protegen las demas ventas. Un error revierte el bloque.
        UPDATE ticket_payments SET reservation_expires_at=NULL WHERE id=v_payment.id;
        IF v_payment.coupon_id IS NOT NULL THEN
            PERFORM 1 FROM ticket_types WHERE id=v_payment.ticket_type_id FOR UPDATE;
            PERFORM 1 FROM events WHERE id=v_payment.event_id FOR UPDATE;
            PERFORM 1 FROM coupons WHERE id=v_payment.coupon_id FOR UPDATE;
            IF EXISTS (SELECT 1 FROM coupons c WHERE c.id=v_payment.coupon_id
                       AND c.max_uses IS NOT NULL AND c.used_count +
                         (SELECT count(*) FROM ticket_payments p WHERE p.coupon_id=c.id
                          AND p.status='pending' AND p.reservation_expires_at > now()) >= c.max_uses) THEN
                RAISE EXCEPTION 'coupon_unavailable';
            END IF;
        END IF;
        v_ticket := emit_ticket(v_payment.event_id, v_payment.ticket_type_id, NULL,
            v_payment.created_by_user_id, v_payment.customer_name, p_raw_token,
            v_payment.customer_phone, v_payment.customer_email, 'online',
            v_payment.customer_birth_date);
        -- El monto historico siempre es lo realmente pagado, incluso si un
        -- admin negocio un precio o cambio la tarifa despues de crear el link.
        UPDATE tickets SET price_cents_snapshot=v_payment.amount_in_cents WHERE id=v_ticket;
        IF v_payment.coupon_id IS NOT NULL THEN
            UPDATE coupons SET used_count=used_count+1 WHERE id=v_payment.coupon_id;
        END IF;
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT IN ('ticket_type_sold_out','event_at_capacity',
            'event_not_open_for_sales','ticket_type_inactive','coupon_unavailable') THEN
            RAISE;
        END IF;
        UPDATE ticket_payments SET status='paid_unfulfilled',
            reservation_expires_at=NULL, transaction_id=p_transaction_id,
            approved_at=now(), raw_payload=p_payload, fulfillment_error=SQLERRM
         WHERE id=v_payment.id;
        PERFORM notify_venue_admins(v_payment.venue_id, 'payment_approved',
            'Pago recibido: requiere revision',
            format('El pago %s de %s se recibio sin emitir boleta. Revisar disponibilidad o gestionar reembolso. Motivo: %s',
                v_payment.reference, v_payment.customer_name, SQLERRM),
            '/admin?event=' || v_payment.event_id || '&tab=cobros');
        RETURN NULL;
    END;

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
CREATE OR REPLACE FUNCTION public.redeem_ticket(p_event_id bigint, p_raw_token text, p_scanned_by_user_id bigint, p_expected_ticket_type_id bigint DEFAULT NULL::bigint, p_scanned_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_door_id text DEFAULT NULL::text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_ticket tickets%ROWTYPE;
    v_token_hash text;
    v_event_status text;
    v_event_starts_at timestamptz;
    v_event_unlock integer;
    v_event_min_age integer;
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

    SELECT status, starts_at, qr_unlock_minutes, min_age
      INTO v_event_status, v_event_starts_at, v_event_unlock, v_event_min_age
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

    -- Edad mínima (mig 051): defensa en la puerta. La validación de verdad
    -- ocurre al emitir (ahi se conoce la fecha de nacimiento), pero una boleta
    -- emitida antes de activar la restriccion, o con la fecha cambiada despues,
    -- no debe entrar: el bouncer ve el mismo "UNDER_AGE" que ve el que compra.
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

COMMIT;
