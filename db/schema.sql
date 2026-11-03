BEGIN;

-- ============================================================================
-- TicketFlow — ESQUEMA COMPLETO (v2, consolidado)
-- ============================================================================
-- Fuente UNICA de verdad: este archivo + las migraciones de db/migrations/ en
-- orden (002..020) reproducen EXACTAMENTE la misma base. Aplicar ambos es
-- seguro en cualquier estado:
--   * instalacion nueva: schema.sql crea todo; las migraciones quedan en
--     no-ops (todas son idempotentes: IF NOT EXISTS / OR REPLACE).
--   * instalacion existente: schema.sql es idempotente; las migraciones
--     siguen funcionando como siempre.
--
-- Como se consolido (sep-2026): se aplico schema.sql + las 20 migraciones
-- sobre una Postgres 16 limpia y el resultado se reverifico con pg_dump
-- --schema-only. El test backend/tests/test_schema_drift.py compara este
-- archivo contra el dump del Postgres local y falla si la base y el archivo
-- se separan (nada entra a produccion sin pasar por aca).
--
-- Contenido: 28 tablas (con audit_log de la mig 019, ticket_payments de la mig
-- 023, analytics_events de la mig 031 y user_preferences de la mig 032), enums
-- user_role / ticket_status, extension pgcrypto, 25 funciones de negocio y sus
-- triggers.
-- La logica transaccional (emit_ticket / redeem_ticket / reissue_ticket /
-- set_event_status / void_ticket / lockout / notificaciones) vive AQUI, en
-- la DB; los routers solo traducen parametros y errores SQL a HTTP.
--
-- Reglas del esquema:
--   * Multi-tenant desde el dia uno: todo cuelga de venues.
--   * El aforo es intocable por concurrencia: emit_ticket y redeem_ticket
--     usan compare-and-swap dentro de una transaccion.
--   * Todo intento de escaneo (exitoso o no) queda en redemptions.
--   * De la boleta solo se guarda el SHA-256 del token (tickets.token_hash).
-- ============================================================================

--
-- PostgreSQL database dump
--

-- Dumped from database version 16.9
-- Dumped by pg_dump version 16.9

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
-- NOTA: pg_dump emite set_config('search_path', '', false) (vacío POR
-- SESION). Todo este archivo está calificado con public., así que se crea
-- bien, pero dejaría rota la sesión para la SIGUIENTE SQL no-calificada
-- (migraciones, smoke test). Se restaura el search_path estándar aquí.
SELECT pg_catalog.set_config('search_path', 'public', false);

SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

--
-- Name: ticket_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ticket_status AS ENUM (
    'issued',
    'voided',
    'refunded',
    'redeemed'
);

--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'super_admin',
    'admin',
    'promotor',
    'bouncer'
);

--
-- Name: approve_ticket_payment(text, text, text, bigint, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approve_ticket_payment(p_reference text, p_transaction_id text, p_status text, p_amount_in_cents bigint, p_raw_token text, p_payload jsonb DEFAULT NULL::jsonb) RETURNS bigint
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
        v_payment.customer_email
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

--
-- Name: auto_close_expired_events(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_close_expired_events() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    -- Tolerancia de "la noche se estiró": ends_at es una estimación del
    -- organizador, no una orden de desalojo. Sin ella, un bar que cierra más
    -- tarde de lo previsto veía EVENT_NOT_LIVE en boletas válidas.
    v_grace  interval := interval '6 hours';
    v_closed integer;
    c record;
BEGIN
    -- live -> ended (la noche termino, nadie pulso "Terminar")
    WITH closed AS (
        UPDATE events
           SET status = 'ended', updated_at = now()
         WHERE status = 'live'
           AND ends_at IS NOT NULL
           AND ends_at + v_grace < now()
        RETURNING 1
    )
    SELECT count(*) INTO v_closed FROM closed;

    -- published vencido -> cancelled (venta que vencio sin abrir puertas).
    -- OJO: NO es 'ended'. El trigger events_check_transition (mig 005) solo
    -- acepta published -> live | cancelled; un UPDATE a 'ended' lanzaba
    -- invalid_transition y el GET /events entero moria en la watchdog con
    -- un 500 la primera vez que existia un published vencido en datos reales
    -- (en CI nunca ocurría: los tests pasan por live antes de vencer).
    --
    -- El FOR captura cada fila cerrada: acumula el conteo Y deja el aviso
    -- (in-app + push via notify_venue_admins). El admin NO descubre un
    -- cancelado mirando la franja; un solo UPDATE hace el cierre, así que
    -- no hay doble-pasada que devuelva 0 filas al notificar.
    FOR c IN
        UPDATE events
           SET status = 'cancelled', updated_at = now()
         WHERE status = 'published'
           AND ends_at IS NOT NULL
           AND ends_at + v_grace < now()
        RETURNING id, venue_id, name
    LOOP
        v_closed := v_closed + 1;
        PERFORM notify_venue_admins(
            c.venue_id,
            'event_autoclosed',
            'Evento cerrado automáticamente',
            c.name || ' tenía la venta vencida y nadie lo cerró: pasó a cancelado.',
            '/admin?event=' || c.id
        );
    END LOOP;

    RETURN v_closed;
END;
$$;

--
-- Name: claim_waitlist(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_waitlist(p_claim_token_hash text, p_new_raw_token text) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_row       event_waitlist%ROWTYPE;
    v_event     events%ROWTYPE;
    v_alloc_ok  boolean := false;
    v_ticket_id bigint;
    v_gone      boolean := false;
BEGIN
    IF p_new_raw_token IS NULL OR length(p_new_raw_token) < 8 THEN
        RAISE EXCEPTION 'invalid_token_format';
    END IF;

    SELECT * INTO v_row FROM event_waitlist
     WHERE token_hash = p_claim_token_hash
     FOR UPDATE;
    IF NOT FOUND OR v_row.status <> 'offered' THEN
        RAISE EXCEPTION 'waitlist_offer_expired';
    END IF;

    SELECT * INTO v_event FROM events WHERE id = v_row.event_id;
    IF v_event.status NOT IN ('published', 'live') THEN
        RAISE EXCEPTION 'event_not_open_for_sales';
    END IF;

    -- Ventana: si la oferta ya vencio, expirarla y ofrecer al siguiente.
    IF v_row.offered_at IS NULL
       OR v_row.offered_at + (v_event.waitlist_offer_minutes * INTERVAL '1 minute') < now() THEN
        UPDATE event_waitlist SET status = 'expired' WHERE id = v_row.id;
        PERFORM offer_next_waitlist_spot(
            v_row.event_id, v_row.offered_ticket_type_id, v_row.offered_allocation_id
        );
        RAISE EXCEPTION 'waitlist_offer_expired';
    END IF;

    IF v_row.offered_ticket_type_id IS NULL THEN
        v_gone := true;
    ELSE
        IF v_row.offered_allocation_id IS NOT NULL THEN
            SELECT is_active INTO v_alloc_ok
              FROM promoter_allocations WHERE id = v_row.offered_allocation_id;
        END IF;

        -- Emitir la boleta NUEVA. Primero contra el cupo liberado; si el
        -- cupo ya no existe o no tiene lugar (alguien emitio mientras
        -- tanto), venta directa del mismo tipo; si tampoco hay, el lugar
        -- se fue: expira y se re-ofrece al siguiente.
        BEGIN
            IF v_alloc_ok THEN
                v_ticket_id := emit_ticket(v_row.event_id, v_row.offered_ticket_type_id,
                                           v_row.offered_allocation_id, NULL,
                                           v_row.name, p_new_raw_token,
                                           v_row.phone, NULL);
            ELSE
                v_ticket_id := emit_ticket(v_row.event_id, v_row.offered_ticket_type_id,
                                           NULL, NULL,
                                           v_row.name, p_new_raw_token,
                                           v_row.phone, NULL);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM LIKE '%quota%' OR SQLERRM LIKE '%sold_out%'
               OR SQLERRM LIKE '%capacity%' OR SQLERRM LIKE '%inactive%' THEN
                v_gone := true;
            ELSE
                RAISE;
            END IF;
        END;
    END IF;

    IF v_gone THEN
        UPDATE event_waitlist SET status = 'expired' WHERE id = v_row.id;
        PERFORM offer_next_waitlist_spot(
            v_row.event_id, v_row.offered_ticket_type_id, v_row.offered_allocation_id
        );
        RAISE EXCEPTION 'waitlist_spot_gone';
    END IF;

    UPDATE event_waitlist
       SET status = 'claimed',
           claimed_ticket_id = v_ticket_id,
           claimed_at = now()
     WHERE id = v_row.id;

    RETURN v_ticket_id;
END;
$$;

--
-- Name: clear_login_failures(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.clear_login_failures(p_email text, p_ip text) RETURNS void
    LANGUAGE sql
    AS $$
    DELETE FROM login_attempts
     WHERE email_norm = lower(p_email) AND ip = p_ip;
$$;

--
-- Name: correct_ticket_contact(bigint, text, text, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.correct_ticket_contact(p_ticket_id bigint, p_new_name text, p_new_phone text, p_by_user_id bigint, p_reason text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE
    v_ticket tickets%ROWTYPE;
    v_event_status text;
    v_old_name  text;
    v_old_phone text;
BEGIN
    IF p_new_name IS NULL AND p_new_phone IS NULL THEN
        RAISE EXCEPTION 'nothing_to_update';
    END IF;

    SELECT * INTO v_ticket FROM tickets WHERE id = p_ticket_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_not_found'; END IF;

    SELECT status INTO v_event_status FROM events WHERE id = v_ticket.event_id;
    IF v_event_status = 'ended' OR v_event_status = 'cancelled' THEN
        RAISE EXCEPTION 'event_closed';
    END IF;

    -- Solo boletas vigentes: una usada ya ocurrió; una anulada/reembolsada es
    -- historia (y "corregir" una anulada podría reactivarla de facto).
    IF v_ticket.status <> 'issued' THEN
        RAISE EXCEPTION 'cannot_edit_ticket_status';
    END IF;

    v_old_name  := v_ticket.customer_name;
    v_old_phone := v_ticket.customer_phone;

    IF p_new_name IS NOT NULL THEN
        IF length(btrim(p_new_name)) = 0 THEN
            RAISE EXCEPTION 'invalid_name';
        END IF;
        UPDATE tickets SET customer_name = btrim(p_new_name) WHERE id = p_ticket_id;
    END IF;

    IF p_new_phone IS NOT NULL THEN
        IF length(btrim(p_new_phone)) = 0
           OR btrim(p_new_phone) !~ '^[0-9+ ()-]{7,20}$' THEN
            RAISE EXCEPTION 'invalid_phone';
        END IF;
        UPDATE tickets SET customer_phone = btrim(p_new_phone) WHERE id = p_ticket_id;
    END IF;

    INSERT INTO ticket_contact_edits (
        ticket_id, edited_by_user_id, old_name, new_name, old_phone, new_phone, reason
    ) VALUES (
        p_ticket_id, p_by_user_id, v_old_name,
        CASE WHEN p_new_name IS NULL THEN v_old_name ELSE btrim(p_new_name) END,
        v_old_phone,
        CASE WHEN p_new_phone IS NULL THEN v_old_phone ELSE btrim(p_new_phone) END,
        p_reason
    );
END;
$_$;

--
-- Name: delete_promoter_allocation(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_promoter_allocation(p_allocation_id bigint) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_id      bigint;
    v_tickets bigint;
BEGIN
    SELECT id INTO v_id FROM promoter_allocations WHERE id = p_allocation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'allocation_not_found'; END IF;

    SELECT count(*) INTO v_tickets FROM tickets WHERE allocation_id = p_allocation_id;

    IF v_tickets = 0 THEN
        -- tickets.allocation_id es ON DELETE SET NULL: sin boletas, el borrado
        -- no pierde nada.
        DELETE FROM promoter_allocations WHERE id = p_allocation_id;
        RETURN FALSE;
    END IF;

    -- Con historial: se archiva para no perder de quién era cada boleta
    -- (lo usa el reporte por promotor).
    UPDATE promoter_allocations SET is_active = FALSE WHERE id = p_allocation_id;
    RETURN TRUE;
END;
$$;

--
-- Name: delete_ticket_type(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_ticket_type(p_type_id bigint) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_id      bigint;
    v_tickets bigint;
BEGIN
    SELECT id INTO v_id FROM ticket_types WHERE id = p_type_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_type_not_found'; END IF;

    SELECT count(*) INTO v_tickets FROM tickets WHERE ticket_type_id = p_type_id;

    IF v_tickets = 0 THEN
        -- Sin boletas: se puede borrar de verdad. Las asignaciones de promotor
        -- de este tipo caen en cascada, y no pueden tener boletas (una boleta
        -- de este tipo la referenciaría a él también).
        DELETE FROM ticket_types WHERE id = p_type_id;
        RETURN FALSE;
    END IF;

    UPDATE ticket_types SET is_active = FALSE WHERE id = p_type_id;
    RETURN TRUE;
END;
$$;

--
-- Name: emit_ticket(bigint, bigint, bigint, bigint, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.emit_ticket(p_event_id bigint, p_ticket_type_id bigint, p_allocation_id bigint, p_sold_by_user_id bigint, p_customer_name text, p_raw_token text, p_customer_phone text DEFAULT NULL::text, p_customer_email text DEFAULT NULL::text) RETURNS bigint
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
        price_cents_snapshot
    ) VALUES (
        p_event_id, p_ticket_type_id, p_allocation_id, p_sold_by_user_id,
        p_customer_name, p_customer_phone, p_customer_email, v_token_hash,
        v_type.price_cents
    ) RETURNING id INTO v_ticket_id;

    RETURN v_ticket_id;
END;
$$;

--
-- Name: events_check_capacity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.events_check_capacity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    active_issued bigint;
BEGIN
    IF NEW.capacity IS DISTINCT FROM OLD.capacity THEN
        SELECT count(*) INTO active_issued
          FROM tickets t
         WHERE t.event_id = NEW.id
           AND t.status <> 'voided'
           AND t.status <> 'refunded';
        IF NEW.capacity < active_issued THEN
            RAISE EXCEPTION 'capacity_cannot_be_below_issued (capacity=%, issued=%)',
                NEW.capacity, active_issued;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

--
-- Name: events_check_transition(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.events_check_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;  -- sin cambio real de estado: no es una transición
    END IF;

    IF NOT (
        (OLD.status = 'draft'     AND NEW.status IN ('published', 'cancelled')) OR
        (OLD.status = 'published' AND NEW.status IN ('live', 'cancelled')) OR
        (OLD.status = 'live'      AND NEW.status = 'ended') OR
        -- Reapertura: la noche se estiró más que la gracia, o el cierre fue un
        -- error. El admin vuelve a poner la puerta en marcha.
        (OLD.status = 'ended'     AND NEW.status = 'live')
    ) THEN
        RAISE EXCEPTION 'invalid_transition (% -> %)', OLD.status, NEW.status;
    END IF;

    RETURN NEW;
END;
$$;

--
-- Name: expire_waitlist_offers(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_waitlist_offers() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_expired integer := 0;
    v_row     record;
BEGIN
    FOR v_row IN
        SELECT w.id, w.event_id, w.offered_ticket_type_id, w.offered_allocation_id
          FROM event_waitlist w
          JOIN events e ON e.id = w.event_id
         WHERE w.status = 'offered'
           AND w.offered_at + (e.waitlist_offer_minutes * INTERVAL '1 minute') < now()
         FOR UPDATE OF w SKIP LOCKED
    LOOP
        UPDATE event_waitlist SET status = 'expired' WHERE id = v_row.id;
        PERFORM offer_next_waitlist_spot(
            v_row.event_id, v_row.offered_ticket_type_id, v_row.offered_allocation_id
        );
        v_expired := v_expired + 1;
    END LOOP;
    RETURN v_expired;
END;
$$;

--
-- Name: join_waitlist(bigint, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.join_waitlist(p_event_id bigint, p_name text, p_phone text, p_raw_token text) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_event    events%ROWTYPE;
    v_active   bigint;
    v_total    bigint;
    v_existing event_waitlist%ROWTYPE;
BEGIN
    IF p_raw_token IS NULL OR length(p_raw_token) < 8 THEN
        RAISE EXCEPTION 'invalid_token_format';
    END IF;
    IF p_name IS NULL OR btrim(p_name) = '' THEN
        RAISE EXCEPTION 'invalid_name';
    END IF;
    IF p_phone IS NULL OR btrim(p_phone) = '' THEN
        RAISE EXCEPTION 'invalid_phone';
    END IF;

    SELECT * INTO v_event FROM events WHERE id = p_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'event_not_found';
    END IF;
    IF v_event.status NOT IN ('published', 'live') THEN
        RAISE EXCEPTION 'event_not_open';
    END IF;

    -- Gate DICE: la lista existe cuando NO hay boletas. Con lugar libre el
    -- publico compra directo, no hace fila.
    SELECT count(*) INTO v_active FROM tickets
     WHERE event_id = p_event_id AND status NOT IN ('voided', 'refunded');
    SELECT COALESCE(SUM(quantity), 0) INTO v_total FROM ticket_types WHERE event_id = p_event_id;
    IF v_active < LEAST(v_total, v_event.capacity::bigint) THEN
        RAISE EXCEPTION 'waitlist_not_needed';
    END IF;

    SELECT * INTO v_existing FROM event_waitlist
     WHERE event_id = p_event_id AND phone = btrim(p_phone);
    IF FOUND THEN
        UPDATE event_waitlist SET name = btrim(p_name) WHERE id = v_existing.id;
        RETURN (SELECT count(*) FROM event_waitlist w
                 WHERE w.event_id = p_event_id AND w.status = 'waiting'
                   AND (w.created_at, w.id) < (v_existing.created_at, v_existing.id)) + 1;
    END IF;

    INSERT INTO event_waitlist (event_id, name, phone, token_hash)
    VALUES (p_event_id, btrim(p_name), btrim(p_phone),
            encode(digest(p_raw_token, 'sha256'), 'hex'));

    -- Ultimo en llegar: mi posicion es el total de la fila viva.
    RETURN (SELECT count(*) FROM event_waitlist w
             WHERE w.event_id = p_event_id AND w.status = 'waiting');
END;
$$;

--
-- Name: leave_waitlist(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.leave_waitlist(p_expected_token_hash text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_row event_waitlist%ROWTYPE;
BEGIN
    SELECT * INTO v_row FROM event_waitlist
     WHERE token_hash = p_expected_token_hash
     FOR UPDATE;
    IF NOT FOUND OR v_row.status NOT IN ('waiting', 'offered') THEN
        RAISE EXCEPTION 'waitlist_entry_not_found';
    END IF;

    UPDATE event_waitlist SET status = 'left' WHERE id = v_row.id;

    IF v_row.status = 'offered' THEN
        PERFORM offer_next_waitlist_spot(
            v_row.event_id, v_row.offered_ticket_type_id, v_row.offered_allocation_id
        );
    END IF;
END;
$$;

--
-- Name: legal_missing_acceptances(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.legal_missing_acceptances(p_user_id bigint) RETURNS TABLE(slug text, version text, title text, url text)
    LANGUAGE sql STABLE
    AS $$
    SELECT d.slug, d.version, d.title, d.url
      FROM legal_documents d
     WHERE d.requires_acceptance
       -- Solo la version MAS RECIENTE de cada documento: la que rige hoy. Se
       -- compara por created_at y no por texto de version ('10.0' < '9.0' en
       -- orden alfabetico) ni por effective_date (una version futura ya
       -- cargada pediria aceptacion antes de regir).
       AND d.created_at = (
             SELECT max(d2.created_at) FROM legal_documents d2 WHERE d2.slug = d.slug
           )
       AND NOT EXISTS (
             SELECT 1 FROM legal_acceptances a
              WHERE a.user_id = p_user_id
                AND a.document_slug = d.slug
                AND a.document_version = d.version
           )
     ORDER BY d.slug
$$;


--
-- Name: login_locked(text, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.login_locked(p_email text, p_ip text, p_max_failures integer DEFAULT 8, p_window_minutes integer DEFAULT 15) RETURNS boolean
    LANGUAGE sql
    AS $$
    SELECT (
        SELECT count(*)
          FROM login_attempts
         WHERE email_norm = lower(p_email)
           AND at > now() - make_interval(mins => p_window_minutes)
    ) >= p_max_failures
    OR (
        SELECT count(*)
          FROM login_attempts
         WHERE ip = p_ip
           AND at > now() - make_interval(mins => p_window_minutes)
    ) >= p_max_failures;
$$;

--
-- Name: notify_door_anomaly(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_door_anomaly() RETURNS trigger
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

--
-- Name: notify_invitation_accepted(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_invitation_accepted() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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

--
-- Name: notify_payout_lifecycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_payout_lifecycle() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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

--
-- Name: notify_ticket_reissued(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_ticket_reissued() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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

--
-- Name: notify_user(bigint, bigint, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_user(p_user_id bigint, p_venue_id bigint, p_kind text, p_title text, p_body text, p_link text DEFAULT NULL::text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    WITH n AS (
        INSERT INTO notifications(user_id, venue_id, kind, title, body, link)
        VALUES (p_user_id, p_venue_id, p_kind, p_title, p_body, p_link)
        RETURNING id
    )
    INSERT INTO push_outbox(notification_id)
    SELECT id FROM n;
$$;

--
-- Name: notify_venue_admins(bigint, text, text, text, text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_venue_admins(p_venue_id bigint, p_kind text, p_title text, p_body text, p_link text DEFAULT NULL::text, p_exclude bigint DEFAULT NULL::bigint) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
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

--
-- Name: offer_next_waitlist_spot(bigint, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.offer_next_waitlist_spot(p_event_id bigint, p_ticket_type_id bigint, p_allocation_id bigint) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_offered bigint;
    v_venue   bigint;
BEGIN
    UPDATE event_waitlist
       SET status = 'offered',
           offered_at = now(),
           offered_ticket_type_id = p_ticket_type_id,
           offered_allocation_id = p_allocation_id
     WHERE id = (
        SELECT id FROM event_waitlist
         WHERE event_id = p_event_id AND status = 'waiting'
         ORDER BY created_at, id
         LIMIT 1 FOR UPDATE SKIP LOCKED
     )
    RETURNING id INTO v_offered;

    IF v_offered IS NULL THEN
        RETURN 0;
    END IF;

    -- Avisar a los admins: el lugar libero circula de nuevo. El fan no tiene
    -- cuenta (sin push posible): su canal es su pagina de estado, que hace
    -- polling y muestra la ventana de reclamo.
    SELECT venue_id INTO v_venue FROM events WHERE id = p_event_id;
    PERFORM notify_venue_admins(v_venue, 'waitlist_offered',
        'Lugar ofrecido a la lista',
        'Se libero un lugar y se ofrecio al primero de la fila.',
        '/admin');
    RETURN 1;
END;
$$;

--
-- Name: prune_login_attempts(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prune_login_attempts(p_window_minutes integer DEFAULT 60) RETURNS void
    LANGUAGE sql
    AS $$
    DELETE FROM login_attempts
     WHERE at < now() - make_interval(mins => p_window_minutes);
$$;

--
-- Name: record_legal_acceptance(bigint, bigint, text, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_legal_acceptance(p_user_id bigint, p_venue_id bigint, p_slug text, p_version text, p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_ip text DEFAULT 'unknown'::text, p_user_agent text DEFAULT NULL::text) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    inserted int := 0;
BEGIN
    INSERT INTO legal_acceptances
        (user_id, venue_id, document_slug, document_version,
         subject_email, subject_phone, ip, user_agent)
    VALUES
        (p_user_id, p_venue_id, p_slug, p_version,
         p_email, p_phone, COALESCE(p_ip, 'unknown'), p_user_agent)
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS inserted = ROW_COUNT;
    RETURN inserted;
END;
$$;


--
-- Name: redeem_ticket(bigint, text, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.redeem_ticket(p_event_id bigint, p_raw_token text, p_scanned_by_user_id bigint, p_expected_ticket_type_id bigint DEFAULT NULL::bigint, p_scanned_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_ticket tickets%ROWTYPE;
    v_token_hash text;
    v_event_status text;
    v_event_starts_at timestamptz;
    v_event_unlock integer;
    v_scanned_at timestamptz;
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

    -- Guardia: el evento del escaneo debe existir (migración 006). Sin esto,
    -- el INSERT del log rompe la FK y el escáner recibe un 500 opaco.
    IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_event_id) THEN
        RAISE EXCEPTION 'event_not_found';
    END IF;

    v_token_hash := encode(digest(p_raw_token, 'sha256'), 'hex');

    SELECT * INTO v_ticket FROM tickets WHERE token_hash = v_token_hash;
    IF NOT FOUND THEN
        -- ticket_id NULL: el escaneo existe como huella, sin boleta asociada
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (NULL, p_event_id, p_scanned_by_user_id, 'not_found', v_scanned_at);
        RETURN 'NOT_FOUND';
    END IF;

    IF v_ticket.event_id <> p_event_id THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'invalid_event', v_scanned_at);
        RETURN 'INVALID_EVENT';
    END IF;

    SELECT status, starts_at, qr_unlock_minutes
      INTO v_event_status, v_event_starts_at, v_event_unlock
      FROM events WHERE id = p_event_id;
    IF v_event_status <> 'live' AND v_event_status <> 'published' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'event_not_live', v_scanned_at);
        RETURN 'EVENT_NOT_LIVE';
    END IF;

    -- Ventana de activación (mig 013): el QR "existe" desde
    -- starts_at - unlock minutos. Antes, rechazo sin consumir.
    IF v_event_starts_at - (v_event_unlock * INTERVAL '1 minute') > now() THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'not_active', v_scanned_at);
        RETURN 'NOT_ACTIVE';
    END IF;

    -- Filtro de fila: con tipo esperado, una boleta válida de otro tipo NO
    -- entra y NO se consume (podrá entrar por la fila correcta después).
    IF p_expected_ticket_type_id IS NOT NULL
       AND v_ticket.ticket_type_id <> p_expected_ticket_type_id THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'wrong_type', v_scanned_at);
        RETURN 'WRONG_TYPE';
    END IF;

    IF v_ticket.status = 'voided' OR v_ticket.status = 'refunded' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'not_valid', v_scanned_at);
        RETURN 'NOT_VALID';
    END IF;

    IF v_ticket.status = 'redeemed' THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'already_redeemed', v_scanned_at);
        RETURN 'ALREADY_REDEEMED';
    END IF;

    -- Compare-and-swap: exactamente UNA de las filas concurrentes sera afectada.
    UPDATE tickets
       SET status = 'redeemed', redeemed_at = v_scanned_at, redeemed_by_user_id = p_scanned_by_user_id
     WHERE id = v_ticket.id AND status = 'issued';

    IF NOT FOUND THEN
        INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
        VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'already_redeemed', v_scanned_at);
        RETURN 'ALREADY_REDEEMED';
    END IF;

    INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome, scanned_at)
    VALUES (v_ticket.id, p_event_id, p_scanned_by_user_id, 'granted', v_scanned_at);
    RETURN 'GRANTED';
END;
$$;

--
-- Name: register_login_failure(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_login_failure(p_email text, p_ip text) RETURNS void
    LANGUAGE sql
    AS $$
    INSERT INTO login_attempts (email_norm, ip)
    VALUES (lower(p_email), p_ip);
$$;

--
-- Name: reissue_ticket(bigint, text, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reissue_ticket(p_ticket_id bigint, p_new_raw_token text, p_by_user_id bigint, p_reason text DEFAULT NULL::text) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_ticket     tickets%ROWTYPE;
    v_event_status text;
    v_new_hash   text;
BEGIN
    IF p_new_raw_token IS NULL OR length(p_new_raw_token) < 8 THEN
        RAISE EXCEPTION 'invalid_token_format';
    END IF;

    SELECT * INTO v_ticket FROM tickets WHERE id = p_ticket_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_not_found'; END IF;

    SELECT status INTO v_event_status FROM events WHERE id = v_ticket.event_id;
    IF v_event_status = 'ended' OR v_event_status = 'cancelled' THEN
        RAISE EXCEPTION 'event_closed';
    END IF;

    -- Una boleta ya usada no se reemite: la entrada ya ocurrió y un token nuevo
    -- sería una segunda entrada gratis.
    IF v_ticket.status = 'redeemed' THEN
        RAISE EXCEPTION 'cannot_reissue_redeemed';
    END IF;
    -- Anulada/reembolsada: dejaría de estar anulada si se le diera token vivo.
    IF v_ticket.status <> 'issued' THEN
        RAISE EXCEPTION 'cannot_reissue_ticket';
    END IF;

    v_new_hash := encode(digest(p_new_raw_token, 'sha256'), 'hex');

    -- Compare-and-swap: dos reemisiones concurrentes no pueden quedar ambas
    -- "vigentes"; la segunda falla y el llamador reintenta.
    UPDATE tickets
       SET token_hash = v_new_hash, updated_at = now()
     WHERE id = p_ticket_id AND status = 'issued';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'cannot_reissue_ticket';
    END IF;

    INSERT INTO ticket_reissues (
        ticket_id, reissued_by_user_id, old_token_hash, new_token_hash, reason
    ) VALUES (
        p_ticket_id, p_by_user_id, v_ticket.token_hash, v_new_hash, p_reason
    );

    RETURN v_ticket.event_id;
END;
$$;

--
-- Name: return_ticket(bigint, text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.return_ticket(p_ticket_id bigint, p_expected_token_hash text DEFAULT NULL::text, p_by_user_id bigint DEFAULT NULL::bigint) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_ticket      tickets%ROWTYPE;
    v_event       events%ROWTYPE;
    v_return_hash text;
BEGIN
    SELECT * INTO v_ticket FROM tickets WHERE id = p_ticket_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ticket_not_found';
    END IF;

    -- Carrera con reissue: el invitado actua con el token de SU enlace; si
    -- la boleta ya roto token (reenvio), su credencial esta muerta y no
    -- puede matar la boleta nueva. El staff pasa NULL: manda su rol.
    IF p_expected_token_hash IS NOT NULL
       AND v_ticket.token_hash <> p_expected_token_hash THEN
        RAISE EXCEPTION 'token_stale';
    END IF;

    SELECT * INTO v_event FROM events WHERE id = v_ticket.event_id;
    IF v_event.status IN ('ended', 'cancelled') THEN
        RAISE EXCEPTION 'event_closed';
    END IF;

    IF v_ticket.status = 'voided' THEN
        -- Ya anulada: si fue DEVUELTA (hay auditoria) es idempotente; si fue
        -- anulada por staff, no hay nada que devolver y se lo decimos.
        IF EXISTS (SELECT 1 FROM ticket_returns WHERE ticket_id = v_ticket.id) THEN
            RETURN v_ticket.event_id;
        END IF;
        RAISE EXCEPTION 'cannot_return_ticket';
    END IF;

    -- Solo una boleta vigente se devuelve: una usada ya entro (el lugar se
    -- lo quedo alguien) y una reembolsada ya no cuenta en aforo.
    IF v_ticket.status <> 'issued' THEN
        RAISE EXCEPTION 'cannot_return_ticket';
    END IF;

    -- Ventana limite (E1-2): devolver es para ANTES de que el QR se active.
    -- Ventana CERRADA (unlock <= now) => rechazo: a esa altura el cupo ya es
    -- compromiso de puerta (cobija lista).
    IF (v_event.starts_at - (v_event.qr_unlock_minutes * INTERVAL '1 minute')) <= now() THEN
        RAISE EXCEPTION 'return_window_closed';
    END IF;

    -- Compare-and-swap: dos devoluciones concurrentes no pueden ambas
    -- anular; la segunda no encuentra la fila 'issued' y muere.
    UPDATE tickets
       SET status = 'voided',
           voided_at = now(),
           updated_at = now()
     WHERE id = v_ticket.id AND status = 'issued';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'cannot_return_ticket';
    END IF;

    -- Auditar con la credencial que hizo la devolucion: el hash del token
    -- vigente (invitado) o la marca de quien actuo (staff).
    v_return_hash := coalesce(
        p_expected_token_hash,
        'staff::' || coalesce(p_by_user_id::text, 'system')
    );
    INSERT INTO ticket_returns (ticket_id, event_id, returned_token_hash, returned_by_user_id)
    VALUES (v_ticket.id, v_ticket.event_id, v_return_hash, p_by_user_id)
    ON CONFLICT (ticket_id, returned_token_hash) DO NOTHING;

    -- Avisar al promotor/admin que la emitio: su cupo se libero y puede
    -- reasignarlo. Sin notificacion el promotor se entera cuando el invitado
    -- le escribe, y la cara del promotor es el producto.
    IF v_ticket.sold_by_user_id IS NOT NULL THEN
        PERFORM notify_user(
            v_ticket.sold_by_user_id, v_event.venue_id, 'ticket_returned',
            'Boleta devuelta',
            coalesce(v_ticket.customer_name, 'Un invitado') ||
            ' devolvio su boleta. Tu cupo se libero: puedes usarlo con alguien mas.',
            '/panel'
        );
    END IF;

    -- Lista de espera (E2): el lugar libre se ofrece al primero de la fila,
    -- con el tipo y el cupo de la boleta devuelta como el lugar heredable.
    PERFORM offer_next_waitlist_spot(
        v_event.id, v_ticket.ticket_type_id, v_ticket.allocation_id
    );

    RETURN v_ticket.event_id;
END;
$$;

--
-- Name: set_event_status(bigint, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_event_status(p_event_id bigint, p_from text, p_to text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_count integer;
    v_issued bigint;
    v_types_total bigint;
    v_over text;
BEGIN
    SELECT count(*) INTO v_count
      FROM events
     WHERE id = p_event_id
       AND status = p_from;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'invalid_transition';
    END IF;

    -- Al abrir (o reabrir) puertas: la suma de quantities de los tipos debe
    -- cubrir las boletas ya emitidas. Si el admin redujo tipos por debajo de
    -- lo vendido, la puerta no abre con sobreventa. Aplica a CUALQUIER
    -- entrada a 'live' (published -> live y la reapertura ended -> live).
    IF p_to = 'live' THEN
        SELECT count(*) INTO v_issued
          FROM tickets
         WHERE event_id = p_event_id
           AND status NOT IN ('voided', 'refunded');

        SELECT COALESCE(SUM(quantity), 0) INTO v_types_total
          FROM ticket_types
         WHERE event_id = p_event_id;

        IF v_issued > v_types_total THEN
            RAISE EXCEPTION 'capacity_below_issued (issued=%, types_total=%)',
                v_issued, v_types_total;
        END IF;

        -- Ninguna localidad puede tener más boletas vivas que su inventario.
        SELECT tt.name INTO v_over
          FROM ticket_types tt
         WHERE tt.event_id = p_event_id
           AND (SELECT count(*) FROM tickets t
                 WHERE t.event_id = p_event_id
                   AND t.ticket_type_id = tt.id
                   AND t.status NOT IN ('voided', 'refunded')) > tt.quantity
         LIMIT 1;
        IF v_over IS NOT NULL THEN
            RAISE EXCEPTION 'ticket_type_oversold (%)', v_over;
        END IF;
    END IF;

    UPDATE events
       SET status = p_to, updated_at = now()
     WHERE id = p_event_id AND status = p_from;
END;
$$;

--
-- Name: tickets_check_active_refs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tickets_check_active_refs() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_type_active  boolean;
    v_alloc_active boolean;
BEGIN
    SELECT is_active INTO v_type_active FROM ticket_types WHERE id = NEW.ticket_type_id;
    IF v_type_active IS NOT TRUE THEN
        RAISE EXCEPTION 'ticket_type_inactive';
    END IF;

    IF NEW.allocation_id IS NOT NULL THEN
        SELECT is_active INTO v_alloc_active
          FROM promoter_allocations WHERE id = NEW.allocation_id;
        IF v_alloc_active IS NOT TRUE THEN
            RAISE EXCEPTION 'allocation_inactive';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

--
-- Name: update_event(bigint, text, text, text, timestamp with time zone, timestamp with time zone, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_event(p_event_id bigint, p_name text, p_description text, p_flyer_url text, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_event_timezone text, p_capacity integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_id            bigint;
    v_status        text;
    v_active_issued bigint;
BEGIN
    SELECT id, status INTO v_id, v_status
      FROM events WHERE id = p_event_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found'; END IF;

    IF p_name IS NULL OR btrim(p_name) = '' THEN
        RAISE EXCEPTION 'invalid_name';
    END IF;
    IF p_capacity IS NULL OR p_capacity <= 0 THEN
        RAISE EXCEPTION 'invalid_capacity';
    END IF;

    -- La ventana se re-valida en la DB también al editar.
    IF p_ends_at IS NOT NULL AND p_ends_at <= p_starts_at THEN
        RAISE EXCEPTION 'invalid_window';
    END IF;

    -- No mover fechas al pasado si el evento aún no empezó. (Un evento live/ended
    -- puede mantener su starts_at original; el caller no envía cambios de fecha
    -- para esos estados, pero la regla es de DB y vale para cualquier camino.)
    IF v_status IN ('draft', 'published') AND p_starts_at < now() THEN
        RAISE EXCEPTION 'starts_at_in_past';
    END IF;

    -- Aforo nunca por debajo de las boletas activas (no anuladas/reembolsadas).
    -- Mismo criterio que emit_ticket() usa para rechazar sobreventa.
    SELECT count(*) INTO v_active_issued
      FROM tickets
     WHERE event_id = p_event_id
       AND status NOT IN ('voided', 'refunded');
    IF p_capacity < v_active_issued THEN
        RAISE EXCEPTION 'capacity_cannot_be_below_issued (capacity=%, issued=%)',
            p_capacity, v_active_issued;
    END IF;

    UPDATE events
       SET name           = p_name,
           description    = p_description,
           flyer_url      = p_flyer_url,
           starts_at      = p_starts_at,
           ends_at        = p_ends_at,
           event_timezone = p_event_timezone,
           capacity       = p_capacity,
           updated_at     = now()
     WHERE id = p_event_id;
END;
$$;

--
-- Name: update_promoter_allocation(bigint, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_promoter_allocation(p_allocation_id bigint, p_capacity integer, p_is_active boolean) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_id   bigint;
    v_used bigint;
BEGIN
    SELECT id INTO v_id FROM promoter_allocations WHERE id = p_allocation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'allocation_not_found'; END IF;

    IF p_capacity IS NULL OR p_capacity < 0 THEN
        RAISE EXCEPTION 'invalid_capacity';
    END IF;

    SELECT count(*) INTO v_used
      FROM tickets
     WHERE allocation_id = p_allocation_id
       AND status NOT IN ('voided', 'refunded');

    IF p_capacity < v_used THEN
        RAISE EXCEPTION 'capacity_below_used (capacity=%, used=%)', p_capacity, v_used;
    END IF;

    UPDATE promoter_allocations
       SET capacity  = p_capacity,
           is_active = p_is_active
     WHERE id = p_allocation_id;
END;
$$;

--
-- Name: update_ticket_type(bigint, text, bigint, integer, boolean, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_ticket_type(p_type_id bigint, p_name text, p_price_cents bigint, p_quantity integer, p_is_courtesy boolean, p_is_active boolean) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_id     bigint;
    v_issued bigint;
BEGIN
    SELECT id INTO v_id FROM ticket_types WHERE id = p_type_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_type_not_found'; END IF;

    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'invalid_quantity';
    END IF;

    SELECT count(*) INTO v_issued
      FROM tickets
     WHERE ticket_type_id = p_type_id
       AND status NOT IN ('voided', 'refunded');

    IF p_quantity < v_issued THEN
        RAISE EXCEPTION 'quantity_below_issued (quantity=%, issued=%)', p_quantity, v_issued;
    END IF;

    UPDATE ticket_types
       SET name        = p_name,
           price_cents = p_price_cents,
           quantity    = p_quantity,
           is_courtesy = p_is_courtesy,
           is_active   = p_is_active
     WHERE id = p_type_id;
END;
$$;

--
-- Name: void_ticket(bigint, text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.void_ticket(p_ticket_id bigint, p_reason text, p_by_user_id bigint) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_ticket tickets%ROWTYPE;
    v_status text;
BEGIN
    SELECT * INTO v_ticket FROM tickets WHERE id = p_ticket_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_not_found'; END IF;

    -- Solo el evento dueño hace falta para validar venue en el endpoint.
    SELECT status INTO v_status FROM events WHERE id = v_ticket.event_id;
    IF v_status = 'ended' OR v_status = 'cancelled' THEN
        RAISE EXCEPTION 'event_closed';
    END IF;

    IF v_ticket.status = 'redeemed' THEN
        RAISE EXCEPTION 'cannot_void_redeemed';
    END IF;
    IF v_ticket.status = 'voided' THEN
        RETURN v_ticket.event_id;   -- idempotente
    END IF;

    UPDATE tickets
       SET status = 'voided', voided_at = now(), updated_at = now()
     WHERE id = p_ticket_id AND status IN ('issued', 'refunded');

    IF NOT FOUND THEN
        RAISE EXCEPTION 'cannot_void_ticket';
    END IF;

    RETURN v_ticket.event_id;
END;
$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: analytics_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_events (
    id bigint NOT NULL,
    name text NOT NULL,
    session_id text NOT NULL,
    path text,
    event_id bigint,
    props jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analytics_events_name_check CHECK ((name = ANY (ARRAY['view_home'::text, 'view_event'::text, 'checkout_start'::text]))),
    CONSTRAINT analytics_events_path_check CHECK (((path IS NULL) OR (length(path) <= 200))),
    CONSTRAINT analytics_events_session_id_check CHECK (((length(session_id) >= 8) AND (length(session_id) <= 64)))
);


--
-- Name: analytics_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.analytics_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.analytics_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    venue_id bigint NOT NULL,
    actor_id bigint,
    kind text NOT NULL,
    entity text NOT NULL,
    entity_id bigint,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: door_sync_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.door_sync_receipts (
    event_id bigint NOT NULL,
    scan_id uuid NOT NULL,
    outcome text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: event_waitlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_waitlist (
    id bigint NOT NULL,
    event_id bigint NOT NULL,
    name text NOT NULL,
    phone text NOT NULL,
    token_hash text NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    offered_at timestamp with time zone,
    offered_ticket_type_id bigint,
    offered_allocation_id bigint,
    claimed_ticket_id bigint,
    claimed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_waitlist_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'offered'::text, 'claimed'::text, 'expired'::text, 'left'::text])))
);

--
-- Name: event_waitlist_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.event_waitlist ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.event_waitlist_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id bigint NOT NULL,
    venue_id bigint NOT NULL,
    name text NOT NULL,
    description text,
    flyer_url text,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone,
    event_timezone text DEFAULT 'America/Bogota'::text NOT NULL,
    capacity integer NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    qr_unlock_minutes integer DEFAULT 60 NOT NULL,
    waitlist_offer_minutes integer DEFAULT 10 NOT NULL,
    location text,
    CONSTRAINT events_capacity_check CHECK ((capacity > 0)),
    CONSTRAINT events_qr_unlock_minutes_check CHECK ((qr_unlock_minutes >= 0)),
    CONSTRAINT events_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'live'::text, 'ended'::text, 'cancelled'::text]))),
    CONSTRAINT events_waitlist_offer_minutes_check CHECK ((waitlist_offer_minutes >= 1))
);

--
-- Name: events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: legal_acceptances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legal_acceptances (
    id bigint NOT NULL,
    user_id bigint,
    venue_id bigint,
    document_slug text NOT NULL,
    document_version text NOT NULL,
    subject_email text,
    subject_phone text,
    ip text DEFAULT 'unknown'::text NOT NULL,
    user_agent text,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT legal_acceptances_subject_check CHECK (((user_id IS NOT NULL) OR (subject_email IS NOT NULL) OR (subject_phone IS NOT NULL)))
);


--
-- Name: legal_acceptances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.legal_acceptances ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.legal_acceptances_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: legal_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legal_documents (
    id bigint NOT NULL,
    slug text NOT NULL,
    version text NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    requires_acceptance boolean DEFAULT true NOT NULL,
    effective_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT legal_documents_slug_check CHECK ((slug ~ '^[a-z0-9-]+$'::text)),
    CONSTRAINT legal_documents_version_check CHECK ((version ~ '^[0-9]+\.[0-9]+$'::text))
);


--
-- Name: legal_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.legal_documents ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.legal_documents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: login_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_attempts (
    id bigint NOT NULL,
    email_norm text NOT NULL,
    ip text DEFAULT 'unknown'::text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: login_attempts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.login_attempts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.login_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media (
    id bigint NOT NULL,
    venue_id bigint NOT NULL,
    mime text NOT NULL,
    bytes bytea NOT NULL,
    size_bytes integer NOT NULL,
    created_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_mime_check CHECK ((mime = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/webp'::text]))),
    CONSTRAINT media_size_bytes_check CHECK (((size_bytes > 0) AND (size_bytes <= 600000)))
);

--
-- Name: media_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.media ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.media_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    venue_id bigint NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    link text,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notifications_kind_check CHECK ((kind = ANY (ARRAY['payout_created'::text, 'payout_reviewed'::text, 'payout_disputed'::text, 'invitation_accepted'::text, 'ticket_reissued'::text, 'ticket_returned'::text, 'waitlist_offered'::text, 'payment_approved'::text, 'event_autoclosed'::text, 'door_anomaly'::text])))
);

--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.notifications ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    request_ip text
);

--
-- Name: password_reset_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.password_reset_tokens ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.password_reset_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: promoter_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promoter_allocations (
    id bigint NOT NULL,
    event_id bigint NOT NULL,
    ticket_type_id bigint NOT NULL,
    promoter_id bigint NOT NULL,
    capacity integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT promoter_allocations_capacity_check CHECK ((capacity >= 0))
);

--
-- Name: promoter_allocations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.promoter_allocations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.promoter_allocations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: promoter_payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promoter_payouts (
    id bigint NOT NULL,
    venue_id bigint NOT NULL,
    promoter_id bigint NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    tickets_count integer DEFAULT 0 NOT NULL,
    revenue_cents bigint DEFAULT 0 NOT NULL,
    commission_pct numeric(5,2) DEFAULT 0 NOT NULL,
    commission_cents bigint DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    paid_cents bigint,
    paid_at timestamp with time zone,
    disputed_reason text,
    reviewed_by bigint,
    reviewed_at timestamp with time zone,
    review_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT promoter_payouts_check CHECK ((period_end >= period_start)),
    CONSTRAINT promoter_payouts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'disputed'::text, 'paid'::text, 'rejected'::text])))
);

--
-- Name: promoter_payouts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.promoter_payouts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.promoter_payouts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: push_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_outbox (
    id bigint NOT NULL,
    notification_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);

--
-- Name: push_outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.push_outbox ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.push_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id bigint NOT NULL,
    user_id bigint,
    venue_id bigint NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: push_subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.push_subscriptions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.push_subscriptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.redemptions (
    id bigint NOT NULL,
    ticket_id bigint,
    event_id bigint NOT NULL,
    scanned_by_user_id bigint,
    outcome text NOT NULL,
    scanned_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: redemptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.redemptions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.redemptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: event_staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_staff (
    id bigint NOT NULL,
    event_id bigint NOT NULL,
    user_id bigint NOT NULL,
    role text NOT NULL,
    shift_start timestamp with time zone,
    shift_end timestamp with time zone,
    assigned_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_staff_shift_check CHECK (((shift_end IS NULL) OR (shift_start IS NULL) OR (shift_end > shift_start))),
    CONSTRAINT event_staff_role_check CHECK ((role = ANY (ARRAY['bouncer'::text, 'promotor'::text]))),
    CONSTRAINT event_staff_unique UNIQUE (event_id, user_id)
);

--
-- Name: event_staff_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.event_staff ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.event_staff_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: event_access_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_access_tokens (
    id bigint NOT NULL,
    event_id bigint NOT NULL,
    user_id bigint NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);

--
-- Name: event_access_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.event_access_tokens ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.event_access_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: staff_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_invitations (
    id bigint NOT NULL,
    venue_id bigint NOT NULL,
    role text NOT NULL,
    full_name text NOT NULL,
    email text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_user_id bigint,
    created_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT staff_invitations_role_check CHECK ((role = ANY (ARRAY['promotor'::text, 'bouncer'::text, 'admin'::text])))
);

--
-- Name: staff_invitations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.staff_invitations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.staff_invitations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: ticket_contact_edits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_contact_edits (
    id bigint NOT NULL,
    ticket_id bigint NOT NULL,
    edited_by_user_id bigint,
    old_name text,
    new_name text,
    old_phone text,
    new_phone text,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: ticket_contact_edits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ticket_contact_edits ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ticket_contact_edits_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: ticket_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_payments (
    id bigint NOT NULL,
    venue_id bigint NOT NULL,
    event_id bigint NOT NULL,
    ticket_type_id bigint NOT NULL,
    reference text NOT NULL,
    provider text DEFAULT 'wompi'::text NOT NULL,
    provider_ref text,
    transaction_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    amount_in_cents bigint NOT NULL,
    customer_name text NOT NULL,
    customer_phone text NOT NULL,
    customer_email text,
    created_by_user_id bigint,
    approved_at timestamp with time zone,
    ticket_id bigint,
    raw_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_payments_amount_in_cents_check CHECK ((amount_in_cents > 0)),
    CONSTRAINT ticket_payments_provider_check CHECK ((provider = 'wompi'::text)),
    CONSTRAINT ticket_payments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text, 'voided'::text, 'expired'::text])))
);

--
-- Name: ticket_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ticket_payments ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ticket_payments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: ticket_reissues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_reissues (
    id bigint NOT NULL,
    ticket_id bigint NOT NULL,
    reissued_by_user_id bigint,
    old_token_hash text NOT NULL,
    new_token_hash text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: ticket_reissues_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ticket_reissues ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ticket_reissues_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: ticket_returns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_returns (
    id bigint NOT NULL,
    ticket_id bigint NOT NULL,
    event_id bigint NOT NULL,
    returned_token_hash text NOT NULL,
    returned_by_user_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: ticket_returns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ticket_returns ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ticket_returns_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: ticket_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_types (
    id bigint NOT NULL,
    event_id bigint NOT NULL,
    name text NOT NULL,
    price_cents bigint DEFAULT 0 NOT NULL,
    currency text DEFAULT 'COP'::text NOT NULL,
    quantity integer NOT NULL,
    is_courtesy boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_types_price_cents_check CHECK ((price_cents >= 0)),
    CONSTRAINT ticket_types_quantity_check CHECK ((quantity > 0))
);

--
-- Name: ticket_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ticket_types ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ticket_types_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tickets (
    id bigint NOT NULL,
    event_id bigint NOT NULL,
    ticket_type_id bigint NOT NULL,
    allocation_id bigint,
    sold_by_user_id bigint,
    customer_name text NOT NULL,
    customer_phone text,
    customer_email text,
    token_hash text NOT NULL,
    status public.ticket_status DEFAULT 'issued'::public.ticket_status NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    voided_at timestamp with time zone,
    redeemed_at timestamp with time zone,
    redeemed_by_user_id bigint,
    price_cents_snapshot bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: tickets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.tickets ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.tickets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    user_id bigint NOT NULL,
    venue_id bigint NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    step integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_preferences_key_check CHECK ((key = ANY (ARRAY['onboarding'::text, 'tutorial'::text]))),
    CONSTRAINT user_preferences_step_check CHECK (((step IS NULL) OR (step >= 0))),
    CONSTRAINT user_preferences_value_check CHECK ((value = ANY (ARRAY['pending'::text, 'accepted'::text, 'dismissed'::text, 'completed'::text])))
);


-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id bigint NOT NULL,
    email text NOT NULL,
    phone text,
    password_hash text NOT NULL,
    full_name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone,
    token_version integer DEFAULT 1 NOT NULL,
    username text,
    CONSTRAINT users_username_format CHECK (((username IS NULL) OR ((username = lower(username)) AND (username ~ '^[a-z0-9._-]{3,32}$'::text))))
);

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.users ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: venue_user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.venue_user_roles (
    venue_id bigint NOT NULL,
    user_id bigint NOT NULL,
    role public.user_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: venues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.venues (
    id bigint NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    legal_name text,
    tax_id text,
    country text DEFAULT 'CO'::text NOT NULL,
    currency text DEFAULT 'COP'::text NOT NULL,
    logo_url text,
    primary_color text,
    commission_pct numeric(5,2) DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    contact_name text,
    contact_phone text
);

--
-- Name: venues_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.venues ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.venues_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: analytics_events analytics_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_events
    ADD CONSTRAINT analytics_events_pkey PRIMARY KEY (id);



--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

--
-- Name: door_sync_receipts door_sync_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.door_sync_receipts
    ADD CONSTRAINT door_sync_receipts_pkey PRIMARY KEY (event_id, scan_id);

--
-- Name: event_waitlist event_waitlist_event_id_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_waitlist
    ADD CONSTRAINT event_waitlist_event_id_phone_key UNIQUE (event_id, phone);

--
-- Name: event_waitlist event_waitlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_waitlist
    ADD CONSTRAINT event_waitlist_pkey PRIMARY KEY (id);

--
-- Name: event_waitlist event_waitlist_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_waitlist
    ADD CONSTRAINT event_waitlist_token_hash_key UNIQUE (token_hash);

--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);

--
-- Name: legal_acceptances legal_acceptances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_acceptances
    ADD CONSTRAINT legal_acceptances_pkey PRIMARY KEY (id);


--
-- Name: legal_acceptances legal_acceptances_user_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_acceptances
    ADD CONSTRAINT legal_acceptances_user_unique UNIQUE (user_id, document_slug, document_version);


--
-- Name: legal_documents legal_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_documents
    ADD CONSTRAINT legal_documents_pkey PRIMARY KEY (id);


--
-- Name: legal_documents legal_documents_slug_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_documents
    ADD CONSTRAINT legal_documents_slug_version_unique UNIQUE (slug, version);


--
-- Name: login_attempts login_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_attempts
    ADD CONSTRAINT login_attempts_pkey PRIMARY KEY (id);

--
-- Name: media media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_pkey PRIMARY KEY (id);

--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);

--
-- Name: password_reset_tokens password_reset_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash);

--
-- Name: promoter_allocations promoter_allocations_event_id_ticket_type_id_promoter_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promoter_allocations
    ADD CONSTRAINT promoter_allocations_event_id_ticket_type_id_promoter_id_key UNIQUE (event_id, ticket_type_id, promoter_id);

--
-- Name: promoter_allocations promoter_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promoter_allocations
    ADD CONSTRAINT promoter_allocations_pkey PRIMARY KEY (id);

--
-- Name: promoter_payouts promoter_payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promoter_payouts
    ADD CONSTRAINT promoter_payouts_pkey PRIMARY KEY (id);

--
-- Name: push_outbox push_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_outbox
    ADD CONSTRAINT push_outbox_pkey PRIMARY KEY (id);

--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);

--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);

--
-- Name: redemptions redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redemptions
    ADD CONSTRAINT redemptions_pkey PRIMARY KEY (id);

--
-- Name: event_staff event_staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_staff
    ADD CONSTRAINT event_staff_pkey PRIMARY KEY (id);

--
-- Name: event_access_tokens event_access_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_access_tokens
    ADD CONSTRAINT event_access_tokens_pkey PRIMARY KEY (id);

--
-- Name: event_access_tokens event_access_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_access_tokens
    ADD CONSTRAINT event_access_tokens_token_hash_key UNIQUE (token_hash);

--
-- Name: staff_invitations staff_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_invitations
    ADD CONSTRAINT staff_invitations_pkey PRIMARY KEY (id);

--
-- Name: staff_invitations staff_invitations_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_invitations
    ADD CONSTRAINT staff_invitations_token_hash_key UNIQUE (token_hash);

--
-- Name: ticket_contact_edits ticket_contact_edits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_contact_edits
    ADD CONSTRAINT ticket_contact_edits_pkey PRIMARY KEY (id);

--
-- Name: ticket_payments ticket_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_payments
    ADD CONSTRAINT ticket_payments_pkey PRIMARY KEY (id);

--
-- Name: ticket_payments ticket_payments_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_payments
    ADD CONSTRAINT ticket_payments_reference_key UNIQUE (reference);

--
-- Name: ticket_payments ticket_payments_ticket_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_payments
    ADD CONSTRAINT ticket_payments_ticket_id_key UNIQUE (ticket_id);

--
-- Name: ticket_reissues ticket_reissues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_reissues
    ADD CONSTRAINT ticket_reissues_pkey PRIMARY KEY (id);

--
-- Name: ticket_returns ticket_returns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_returns
    ADD CONSTRAINT ticket_returns_pkey PRIMARY KEY (id);

--
-- Name: ticket_returns ticket_returns_ticket_id_returned_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_returns
    ADD CONSTRAINT ticket_returns_ticket_id_returned_token_hash_key UNIQUE (ticket_id, returned_token_hash);

--
-- Name: ticket_types ticket_types_event_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_types
    ADD CONSTRAINT ticket_types_event_id_name_key UNIQUE (event_id, name);

--
-- Name: ticket_types ticket_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_types
    ADD CONSTRAINT ticket_types_pkey PRIMARY KEY (id);

--
-- Name: tickets tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_pkey PRIMARY KEY (id);

--
-- Name: tickets tickets_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_token_hash_key UNIQUE (token_hash);

--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (user_id, venue_id, key);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Name: venue_user_roles venue_user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venue_user_roles
    ADD CONSTRAINT venue_user_roles_pkey PRIMARY KEY (venue_id, user_id, role);

--
-- Name: venues venues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venues
    ADD CONSTRAINT venues_pkey PRIMARY KEY (id);

--
-- Name: venues venues_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venues
    ADD CONSTRAINT venues_slug_key UNIQUE (slug);

--
-- Name: audit_log_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_actor_idx ON public.audit_log USING btree (actor_id, created_at DESC);

--
-- Name: audit_log_venue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_venue_idx ON public.audit_log USING btree (venue_id, created_at DESC);

--
-- Name: idx_event_waitlist_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_waitlist_queue ON public.event_waitlist USING btree (event_id, status, created_at);

--
-- Name: idx_events_ends_unended; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_ends_unended ON public.events USING btree (ends_at) WHERE (status = ANY (ARRAY['live'::text, 'published'::text]));

--
-- Name: idx_analytics_events_name_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analytics_events_name_created ON public.analytics_events USING btree (name, created_at DESC);


--
-- Name: idx_analytics_events_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analytics_events_session ON public.analytics_events USING btree (session_id);



--
-- Name: idx_event_staff_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_staff_event ON public.event_staff USING btree (event_id);

--
-- Name: idx_event_staff_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_staff_user ON public.event_staff USING btree (user_id);

--
-- Name: idx_event_tokens_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_tokens_user ON public.event_access_tokens USING btree (user_id) WHERE (revoked_at IS NULL);

--
-- Name: idx_event_tokens_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_event_tokens_active ON public.event_access_tokens USING btree (event_id, user_id) WHERE ((used_at IS NULL) AND (revoked_at IS NULL));

--
-- Name: idx_invitations_venue_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invitations_venue_open ON public.staff_invitations USING btree (venue_id) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL));

--
-- Name: idx_legal_acceptances_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_legal_acceptances_phone ON public.legal_acceptances USING btree (subject_phone) WHERE (subject_phone IS NOT NULL);


--
-- Name: idx_legal_acceptances_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_legal_acceptances_user ON public.legal_acceptances USING btree (user_id);


--
-- Name: idx_legal_acceptances_venue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_legal_acceptances_venue ON public.legal_acceptances USING btree (venue_id, document_slug);


--
-- Name: idx_login_attempts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_login_attempts_email ON public.login_attempts USING btree (email_norm, at);

--
-- Name: idx_login_attempts_ip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_login_attempts_ip ON public.login_attempts USING btree (ip, at);

--
-- Name: idx_notifications_user_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_unread ON public.notifications USING btree (user_id, created_at DESC) WHERE (read_at IS NULL);

--
-- Name: idx_notifications_venue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_venue ON public.notifications USING btree (venue_id, user_id);

--
-- Name: idx_password_reset_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_password_reset_token_hash ON public.password_reset_tokens USING btree (token_hash);

--
-- Name: idx_password_reset_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_reset_user ON public.password_reset_tokens USING btree (user_id, created_at DESC);

--
-- Name: idx_payouts_promoter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payouts_promoter ON public.promoter_payouts USING btree (promoter_id, venue_id, created_at DESC);

--
-- Name: idx_payouts_unique_period; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_payouts_unique_period ON public.promoter_payouts USING btree (venue_id, promoter_id, period_start);

--
-- Name: idx_payouts_venue_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payouts_venue_status ON public.promoter_payouts USING btree (venue_id, status, created_at DESC);

--
-- Name: idx_push_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_outbox_pending ON public.push_outbox USING btree (id) WHERE (processed_at IS NULL);

--
-- Name: idx_push_subs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subs_user ON public.push_subscriptions USING btree (user_id);

--
-- Name: idx_push_subs_venue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subs_venue ON public.push_subscriptions USING btree (venue_id);

--
-- Name: idx_redemptions_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_redemptions_event ON public.redemptions USING btree (event_id, scanned_at);

--
-- Name: idx_redemptions_scanner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_redemptions_scanner ON public.redemptions USING btree (scanned_by_user_id, scanned_at DESC);

--
-- Name: idx_redemptions_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_redemptions_ticket ON public.redemptions USING btree (ticket_id, scanned_at);

--
-- Name: idx_ticket_contact_edits_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_contact_edits_ticket ON public.ticket_contact_edits USING btree (ticket_id, created_at);

--
-- Name: idx_ticket_payments_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_payments_event ON public.ticket_payments USING btree (event_id);

--
-- Name: idx_ticket_payments_provider_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_ticket_payments_provider_ref ON public.ticket_payments USING btree (provider, provider_ref) WHERE (provider_ref IS NOT NULL);

--
-- Name: idx_ticket_payments_tx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_ticket_payments_tx ON public.ticket_payments USING btree (provider, transaction_id) WHERE (transaction_id IS NOT NULL);

--
-- Name: idx_ticket_reissues_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_reissues_ticket ON public.ticket_reissues USING btree (ticket_id, created_at);

--
-- Name: idx_ticket_returns_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_returns_event ON public.ticket_returns USING btree (event_id, created_at);

--
-- Name: idx_tickets_allocation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_allocation ON public.tickets USING btree (allocation_id);

--
-- Name: idx_tickets_event_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_event_status ON public.tickets USING btree (event_id, status);

--
-- Name: idx_tickets_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_phone ON public.tickets USING btree (customer_phone) WHERE (customer_phone IS NOT NULL);

--
-- Name: idx_tickets_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_token_hash ON public.tickets USING btree (token_hash);


--
-- Name: idx_user_preferences_venue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_preferences_venue ON public.user_preferences USING btree (venue_id, key);


--
-- Name: idx_users_last_login; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_last_login ON public.users USING btree (last_login_at);


--
-- Name: users_username_lower_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_username_lower_key ON public.users USING btree (lower(username)) WHERE (username IS NOT NULL);


--
-- Name: events trg_events_check_capacity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_events_check_capacity BEFORE UPDATE OF capacity ON public.events FOR EACH ROW EXECUTE FUNCTION public.events_check_capacity();

--
-- Name: events trg_events_check_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_events_check_transition BEFORE UPDATE OF status ON public.events FOR EACH ROW EXECUTE FUNCTION public.events_check_transition();

--
-- Name: staff_invitations trg_invitation_accepted_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_invitation_accepted_notify AFTER UPDATE OF accepted_user_id ON public.staff_invitations FOR EACH ROW EXECUTE FUNCTION public.notify_invitation_accepted();

--
-- Name: promoter_payouts trg_payout_lifecycle_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payout_lifecycle_notify AFTER INSERT OR UPDATE OF status ON public.promoter_payouts FOR EACH ROW EXECUTE FUNCTION public.notify_payout_lifecycle();

--
-- Name: redemptions trg_redemptions_door_anomaly; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_redemptions_door_anomaly AFTER INSERT ON public.redemptions FOR EACH ROW EXECUTE FUNCTION public.notify_door_anomaly();

--
-- Name: ticket_reissues trg_ticket_reissued_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ticket_reissued_notify AFTER INSERT ON public.ticket_reissues FOR EACH ROW EXECUTE FUNCTION public.notify_ticket_reissued();

--
-- Name: tickets trg_tickets_check_active_refs; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tickets_check_active_refs BEFORE INSERT ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.tickets_check_active_refs();

--
-- Name: analytics_events analytics_events_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_events
    ADD CONSTRAINT analytics_events_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL;



--
-- Name: audit_log audit_log_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: audit_log audit_log_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;

--
-- Name: event_waitlist event_waitlist_claimed_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_waitlist
    ADD CONSTRAINT event_waitlist_claimed_ticket_id_fkey FOREIGN KEY (claimed_ticket_id) REFERENCES public.tickets(id) ON DELETE SET NULL;

--
-- Name: event_waitlist event_waitlist_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_waitlist
    ADD CONSTRAINT event_waitlist_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

--
-- Name: event_waitlist event_waitlist_offered_allocation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_waitlist
    ADD CONSTRAINT event_waitlist_offered_allocation_id_fkey FOREIGN KEY (offered_allocation_id) REFERENCES public.promoter_allocations(id) ON DELETE SET NULL;

--
-- Name: event_waitlist event_waitlist_offered_ticket_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_waitlist
    ADD CONSTRAINT event_waitlist_offered_ticket_type_id_fkey FOREIGN KEY (offered_ticket_type_id) REFERENCES public.ticket_types(id) ON DELETE SET NULL;

--
-- Name: events events_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;

--
-- Name: legal_acceptances legal_acceptances_document_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_acceptances
    ADD CONSTRAINT legal_acceptances_document_fk FOREIGN KEY (document_slug, document_version) REFERENCES public.legal_documents(slug, version);


--
-- Name: legal_acceptances legal_acceptances_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_acceptances
    ADD CONSTRAINT legal_acceptances_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: legal_acceptances legal_acceptances_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_acceptances
    ADD CONSTRAINT legal_acceptances_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE SET NULL;


--
-- Name: media media_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

--
-- Name: media media_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;

--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: notifications notifications_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;

--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: promoter_allocations promoter_allocations_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promoter_allocations
    ADD CONSTRAINT promoter_allocations_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

--
-- Name: promoter_allocations promoter_allocations_promoter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promoter_allocations
    ADD CONSTRAINT promoter_allocations_promoter_id_fkey FOREIGN KEY (promoter_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: promoter_allocations promoter_allocations_ticket_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promoter_allocations
    ADD CONSTRAINT promoter_allocations_ticket_type_id_fkey FOREIGN KEY (ticket_type_id) REFERENCES public.ticket_types(id) ON DELETE CASCADE;

--
-- Name: promoter_payouts promoter_payouts_promoter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promoter_payouts
    ADD CONSTRAINT promoter_payouts_promoter_id_fkey FOREIGN KEY (promoter_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: promoter_payouts promoter_payouts_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promoter_payouts
    ADD CONSTRAINT promoter_payouts_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: promoter_payouts promoter_payouts_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promoter_payouts
    ADD CONSTRAINT promoter_payouts_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;

--
-- Name: push_outbox push_outbox_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_outbox
    ADD CONSTRAINT push_outbox_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE CASCADE;

--
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: push_subscriptions push_subscriptions_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;

--
-- Name: redemptions redemptions_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redemptions
    ADD CONSTRAINT redemptions_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

--
-- Name: redemptions redemptions_scanned_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redemptions
    ADD CONSTRAINT redemptions_scanned_by_user_id_fkey FOREIGN KEY (scanned_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: redemptions redemptions_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.redemptions
    ADD CONSTRAINT redemptions_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;

--
-- Name: staff_invitations staff_invitations_accepted_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_invitations
    ADD CONSTRAINT staff_invitations_accepted_user_id_fkey FOREIGN KEY (accepted_user_id) REFERENCES public.users(id);

--
-- Name: staff_invitations staff_invitations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_invitations
    ADD CONSTRAINT staff_invitations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

--
-- Name: event_staff event_staff_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_staff
    ADD CONSTRAINT event_staff_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

--
-- Name: event_staff event_staff_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_staff
    ADD CONSTRAINT event_staff_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: event_staff event_staff_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_staff
    ADD CONSTRAINT event_staff_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id);

--
-- Name: event_access_tokens event_access_tokens_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_access_tokens
    ADD CONSTRAINT event_access_tokens_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

--
-- Name: event_access_tokens event_access_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_access_tokens
    ADD CONSTRAINT event_access_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: event_access_tokens event_access_tokens_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_access_tokens
    ADD CONSTRAINT event_access_tokens_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

--
-- Name: staff_invitations staff_invitations_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_invitations
    ADD CONSTRAINT staff_invitations_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;

--
-- Name: ticket_contact_edits ticket_contact_edits_edited_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_contact_edits
    ADD CONSTRAINT ticket_contact_edits_edited_by_user_id_fkey FOREIGN KEY (edited_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: ticket_contact_edits ticket_contact_edits_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_contact_edits
    ADD CONSTRAINT ticket_contact_edits_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;

--
-- Name: ticket_payments ticket_payments_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_payments
    ADD CONSTRAINT ticket_payments_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);

--
-- Name: ticket_payments ticket_payments_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_payments
    ADD CONSTRAINT ticket_payments_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id);

--
-- Name: ticket_payments ticket_payments_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_payments
    ADD CONSTRAINT ticket_payments_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id);

--
-- Name: ticket_payments ticket_payments_ticket_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_payments
    ADD CONSTRAINT ticket_payments_ticket_type_id_fkey FOREIGN KEY (ticket_type_id) REFERENCES public.ticket_types(id);

--
-- Name: ticket_payments ticket_payments_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_payments
    ADD CONSTRAINT ticket_payments_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id);

--
-- Name: ticket_reissues ticket_reissues_reissued_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_reissues
    ADD CONSTRAINT ticket_reissues_reissued_by_user_id_fkey FOREIGN KEY (reissued_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: ticket_reissues ticket_reissues_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_reissues
    ADD CONSTRAINT ticket_reissues_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;

--
-- Name: ticket_returns ticket_returns_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_returns
    ADD CONSTRAINT ticket_returns_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

--
-- Name: ticket_returns ticket_returns_returned_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_returns
    ADD CONSTRAINT ticket_returns_returned_by_user_id_fkey FOREIGN KEY (returned_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: ticket_returns ticket_returns_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_returns
    ADD CONSTRAINT ticket_returns_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;

--
-- Name: ticket_types ticket_types_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_types
    ADD CONSTRAINT ticket_types_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

--
-- Name: tickets tickets_allocation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_allocation_id_fkey FOREIGN KEY (allocation_id) REFERENCES public.promoter_allocations(id) ON DELETE SET NULL;

--
-- Name: tickets tickets_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

--
-- Name: tickets tickets_redeemed_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_redeemed_by_user_id_fkey FOREIGN KEY (redeemed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: tickets tickets_sold_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_sold_by_user_id_fkey FOREIGN KEY (sold_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: tickets tickets_ticket_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_ticket_type_id_fkey FOREIGN KEY (ticket_type_id) REFERENCES public.ticket_types(id) ON DELETE RESTRICT;

--
-- Name: user_preferences user_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_preferences user_preferences_venue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;


--
-- Name: venue_user_roles venue_user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venue_user_roles
    ADD CONSTRAINT venue_user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: venue_user_roles venue_user_roles_venue_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venue_user_roles
    ADD CONSTRAINT venue_user_roles_venue_fk FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;

--
-- PostgreSQL database dump complete
--

COMMIT;
