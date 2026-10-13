-- =============================================================================
-- Smoke test del esquema: valida los 5 invariantes criticos
--   1. Cupo del promotor respetado (no sobre-emite su canasta)
--   2. Cupo del ticket_type respetado
--   3. Aforo global del evento respetado
--   4. Doble redencion: solo la primera gana (compare-and-swap)
--   5. Anular (void) libera cupo para que otro pueda emitir
--
-- Uso:  psql "$DATABASE_URL" -f tests/smoke.sql
-- Termina con error (ON_ERROR_STOP) si algo no cumple el invariante.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET off

BEGIN;

-- Escenario de prueba ---------------------------------------------------------
INSERT INTO users (email, password_hash, full_name)
VALUES ('admin@bar.test', 'x', 'Admin Bar'),
       ('promotor1@bar.test', 'x', 'Promo Uno'),
       ('promotor2@bar.test', 'x', 'Promo Dos'),
       ('bouncer@bar.test', 'x', 'Bouncer')
ON CONFLICT (email) DO NOTHING;

INSERT INTO venues (name, slug)
VALUES ('Bar Esquina', 'bar-esquina')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO venue_user_roles (venue_id, user_id, role)
SELECT v.id, u.id, 'admin' FROM venues v, users u WHERE v.slug='bar-esquina' AND u.email='admin@bar.test'
ON CONFLICT DO NOTHING;

-- starts_at a +5 min: la ventana de activacion del QR (mig 013, default
-- qr_unlock_minutes=60) abre ANTES del evento, asi que redeem_ticket responde
-- GRANTED. Con +7 dias (como estaba) el QR aun no activa y el smoke moria en
-- el paso 3 con NOT_ACTIVE.
INSERT INTO events (venue_id, name, starts_at, capacity, status)
SELECT id, 'SMOKE-TEST: Noche Electrónica', now() + interval '5 minutes', 100, 'published' FROM venues WHERE slug='bar-esquina'
ON CONFLICT DO NOTHING;

-- Tipos: General (pago) y Cortesía (cupo: 5 de Promo1 + 3 de Promo2 = 8).
INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy)
SELECT id, 'General', 30000, 80, FALSE FROM events WHERE name='SMOKE-TEST: Noche Electrónica'
ON CONFLICT (event_id, name) DO NOTHING;
INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy)
SELECT id, 'Cortesia', 0, 8, TRUE FROM events WHERE name='SMOKE-TEST: Noche Electrónica'
ON CONFLICT (event_id, name) DO NOTHING;

-- Cupos: Promo1 tiene 5 cortesias, Promo2 tiene 3, y 10 venta directa maximos.
INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity)
SELECT e.id, tt.id, p.id, 5
FROM events e, ticket_types tt, users p
WHERE e.name='SMOKE-TEST: Noche Electrónica' AND tt.name='Cortesia' AND p.email='promotor1@bar.test'
ON CONFLICT DO NOTHING;
INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity)
SELECT e.id, tt.id, p.id, 3
FROM events e, ticket_types tt, users p
WHERE e.name='SMOKE-TEST: Noche Electrónica' AND tt.name='Cortesia' AND p.email='promotor2@bar.test'
ON CONFLICT DO NOTHING;
INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity)
SELECT e.id, tt.id, p.id, 10
FROM events e, ticket_types tt, users p
WHERE e.name='SMOKE-TEST: Noche Electrónica' AND tt.name='General' AND p.email='promotor1@bar.test'
ON CONFLICT DO NOTHING;

-- 1) Emite 5/5 del cupo de Promo1 (Cortesia) ---------------------------------
DO $$
DECLARE
    v_ev bigint; v_tt bigint; v_prom bigint; v_alloc bigint;
BEGIN
    SELECT id INTO v_ev FROM events WHERE name='SMOKE-TEST: Noche Electrónica';
    SELECT id INTO v_tt FROM ticket_types WHERE name='Cortesia' AND event_id=v_ev;
    SELECT id INTO v_prom FROM users WHERE email='promotor1@bar.test';
    SELECT id INTO v_alloc FROM promoter_allocations WHERE promoter_id=v_prom AND ticket_type_id=v_tt;
    FOR i IN 1..5 LOOP
        PERFORM emit_ticket(v_ev, v_tt, v_alloc, v_prom,
                           'Cliente Foto '||i, 'promo1-token-'||i, '31'||i||'000000', NULL);
    END LOOP;
END;
$$;

-- Intento 6 de Promo1: DEBE fallar con promoter_quota_exceeded
DO $$
DECLARE
    v_ev bigint; v_tt bigint; v_alloc bigint; v_prom bigint;
BEGIN
    SELECT id INTO v_ev FROM events WHERE name='SMOKE-TEST: Noche Electrónica';
    SELECT id INTO v_tt FROM ticket_types WHERE name='Cortesia';
    SELECT promoter_allocations.id INTO v_alloc FROM promoter_allocations
      JOIN users u ON u.id=promoter_allocations.promoter_id
     WHERE u.email='promotor1@bar.test';
    SELECT id INTO v_prom FROM users WHERE email='promotor1@bar.test';
    BEGIN
        PERFORM emit_ticket(v_ev, v_tt, v_alloc, v_prom, 'Exceso', 'promo1-token-6', NULL, NULL);
        RAISE EXCEPTION 'TEST_FAIL: Esperaba promoter_quota_exceeded';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = 'P0001' AND SQLERRM LIKE '%promoter_quota_exceeded%' THEN
            RAISE NOTICE 'OK: cupo de promotor respeta el limite';
        ELSE
            RAISE;
        END IF;
    END;
END;
$$;

-- Venta directa de General por Promo1 (no usa cupo) ---------------------------
DO $$
DECLARE v_ev bigint; v_tt bigint; v_prom bigint;
BEGIN
    SELECT id INTO v_ev FROM events WHERE name='SMOKE-TEST: Noche Electrónica';
    SELECT id INTO v_tt FROM ticket_types WHERE name='General';
    SELECT id INTO v_prom FROM users WHERE email='promotor1@bar.test';
    FOR i IN 1..10 LOOP
        PERFORM emit_ticket(v_ev, v_tt, NULL, v_prom,
                           'Buyer '||i, 'venta-token-'||i, '300'||i||'0000', 'buyer'||i||'@x.co');
    END LOOP;
END;
$$;

-- 2) Emitir la cortesia 11 (sobre cupo de tipo) DEBE fallar -------------------
DO $$
DECLARE v_ev bigint; v_tt bigint;
BEGIN
    SELECT id INTO v_ev FROM events WHERE name='SMOKE-TEST: Noche Electrónica';
    SELECT id INTO v_tt FROM ticket_types WHERE name='Cortesia';
    BEGIN
        PERFORM emit_ticket(
            v_ev, v_tt, NULL,
            (SELECT id FROM users WHERE email='promotor2@bar.test'),
            'Cortesia 11', 'ticket-type-overflow', NULL, NULL);
        RAISE EXCEPTION 'TEST_FAIL: Esperaba ticket_type_sold_out';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = 'P0001' AND SQLERRM LIKE '%ticket_type_sold_out%' THEN
            RAISE NOTICE 'OK: cupo del tipo de boleta respetado';
        ELSE
            RAISE;
        END IF;
    END;
END;
$$;

-- 3) Redencion doble ----------------------------------------------------------
DO $$
DECLARE v_ev bigint; v_tok text; v_first text; v_second text;
BEGIN
    SELECT id INTO v_ev FROM events WHERE name='SMOKE-TEST: Noche Electrónica';
    v_tok := 'venta-token-1';
    v_first  := redeem_ticket(v_ev, v_tok, (SELECT id FROM users WHERE email='bouncer@bar.test'));
    v_second := redeem_ticket(v_ev, v_tok, (SELECT id FROM users WHERE email='bouncer@bar.test'));

    IF v_first <> 'GRANTED' THEN RAISE EXCEPTION 'TEST_FAIL: Primera redencion deberia GRANTED (era %)', v_first; END IF;
    IF v_second <> 'ALREADY_REDEEMED' THEN RAISE EXCEPTION 'TEST_FAIL: Segunda redencion deberia ALREADY_REDEEMED (era %)', v_second; END IF;
    RAISE NOTICE 'OK: doble redencion bloqueada (1a=% , 2a=%)', v_first, v_second;
END;
$$;

-- Token inexistente -----------------------------------------------------------
DO $$
DECLARE v_res text;
BEGIN
    v_res := redeem_ticket(
        (SELECT id FROM events WHERE name='SMOKE-TEST: Noche Electrónica'),
        'token-inexistente-xyz', (SELECT id FROM users WHERE email='bouncer@bar.test'));
    IF v_res <> 'NOT_FOUND' THEN RAISE EXCEPTION 'TEST_FAIL: Token inexistente deberia NOT_FOUND (era %)', v_res; END IF;
    RAISE NOTICE 'OK: token inexistente -> NOT_FOUND';
END;
$$;

-- 4) Anular libera cupo -------------------------------------------------------
DO $$
DECLARE v_ticket bigint;
BEGIN
    SELECT id INTO v_ticket FROM tickets WHERE customer_name='Cliente Foto 5' LIMIT 1;
    UPDATE tickets SET status='voided', voided_at=now() WHERE id=v_ticket;
    RAISE NOTICE 'OK: boleta % anulada', v_ticket;
END;
$$;

-- 5) Aforo global: bajar capacity por debajo de emitidas DEBE fallar ----------
DO $$
BEGIN
    BEGIN
        UPDATE events SET capacity=1 WHERE name='SMOKE-TEST: Noche Electrónica';
        RAISE EXCEPTION 'TEST_FAIL: Esperaba capacity_cannot_be_below_issued';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = 'P0001' AND SQLERRM LIKE '%capacity_cannot_be_below_issued%' THEN
            RAISE NOTICE 'OK: aforo no baja de emitidas';
        ELSE
            RAISE;
        END IF;
    END;
END;
$$;

SELECT 'SMOKE TEST OK' AS resultado;

ROLLBACK;