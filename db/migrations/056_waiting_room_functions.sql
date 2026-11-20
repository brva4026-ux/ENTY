-- =============================================================================
-- Migración 056: funciones de la sala de espera.
--
-- Dos operaciones:
--
--   join_waiting_room(evento, sesion) -> estado + pase (si le toca)
--   require_waiting_pass(evento, pase) -> deja pasar o revienta
--
-- El control de caudal es lo delicado. La tentación es "contar cuantos
-- pases vigentes hay y si hay menos que la tanda, admitir". Eso tiene una
-- carrera: dos peticiones cuentan 49, ambas ven lugar, ambas admiten, y
-- entran 51. Como el conteo y la admisión son dos statements, la ventana
-- existe siempre.
--
-- La solución es serializar por evento con un lock asesor (advisory lock):
-- la admisión de una tanda es una sección crítica por evento, y el lock se
-- toma sobre el ID del evento, no sobre filas. Así el caudal es exacto y no
-- se bloquean las lecturas de otros eventos.
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- join_waiting_room: entra a la fila (o refresca su estado) y reparte pases.
--
-- Devuelve una fila con:
--   status          waiting | admitted | used
--   pass            el token crudo SOLO cuando recién se le otorga; NULL si
--                   todavía no le toca
--   queue_position  cuántos tiene delante (solo en 'waiting')
--   expires_at      cuándo vence el pase

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.join_waiting_room(
    p_event_id bigint,
    p_session_hash text
) RETURNS TABLE (
    status text,
    pass text,
    queue_position integer,
    expires_at timestamptz
)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_event    events%ROWTYPE;
    v_row      event_waiting_room%ROWTYPE;
    v_exists   boolean;
    v_active   integer;
    v_ahead    integer;
    v_new_pass text;
    v_expires  timestamptz;
BEGIN
    IF p_session_hash IS NULL OR length(p_session_hash) < 16 THEN
        RAISE EXCEPTION 'invalid_session';
    END IF;

    SELECT * INTO v_event FROM events WHERE id = p_event_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found'; END IF;

    -- Sala apagada: el fan pasa directo. Devolver 'admitted' sin pase deja
    -- el flujo de compra intacto (require_waiting_pass no se llama).
    IF NOT v_event.waiting_room_enabled THEN
        RETURN QUERY SELECT 'admitted'::text, NULL::text, 0, NULL::timestamptz;
        RETURN;
    END IF;

    -- Sección crítica POR EVENTO: el caudal se calcula y se aplica sin que
    -- otra petición del mismo evento se cuele en el medio.
    PERFORM pg_advisory_xact_lock(hashtextextended('waiting_room:' || p_event_id::text, 0));

    SELECT * INTO v_row FROM event_waiting_room wr
     WHERE wr.event_id = p_event_id AND wr.session_hash = p_session_hash
     FOR UPDATE;
    -- Se guarda aparte: cualquier SELECT posterior pisa FOUND.
    v_exists := FOUND;

    -- Ya compró: no vuelve a la fila.
    IF v_exists AND v_row.status = 'used' THEN
        RETURN QUERY SELECT 'used'::text, NULL::text, 0, NULL::timestamptz;
        RETURN;
    END IF;

    -- Pase vigente: se le devuelve el estado, sin repartir otro.
    IF v_exists AND v_row.status = 'admitted' AND v_row.pass_expires_at > now() THEN
        RETURN QUERY SELECT 'admitted'::text, NULL::text, 0, v_row.pass_expires_at;
        RETURN;
    END IF;

    -- Pase vencido sin comprar: se marca y se reencola conservando su lugar.
    IF v_exists AND v_row.status = 'admitted' THEN
        UPDATE event_waiting_room SET status = 'expired', updated_at = now()
         WHERE id = v_row.id;
    END IF;

    -- Cuántos pases vigentes hay ahora mismo en este evento.
    SELECT count(*) INTO v_active FROM event_waiting_room wr
     WHERE wr.event_id = p_event_id AND wr.status = 'admitted'
       AND wr.pass_expires_at > now();

    -- Hay lugar en la tanda: se admite ya.
    IF v_active < v_event.waiting_room_batch THEN
        v_new_pass := encode(gen_random_bytes(24), 'hex');
        v_expires  := now() + (v_event.waiting_room_pass_minutes * INTERVAL '1 minute');
        IF v_exists THEN
            UPDATE event_waiting_room
               SET status = 'admitted',
                   pass_hash = encode(digest(v_new_pass, 'sha256'), 'hex'),
                   admitted_at = now(),
                   pass_expires_at = v_expires,
                   updated_at = now()
             WHERE id = v_row.id;
        ELSE
            INSERT INTO event_waiting_room
                (event_id, session_hash, status, pass_hash, admitted_at, pass_expires_at)
            VALUES
                (p_event_id, p_session_hash, 'admitted',
                 encode(digest(v_new_pass, 'sha256'), 'hex'), now(), v_expires);
        END IF;
        RETURN QUERY SELECT 'admitted'::text, v_new_pass, 0, v_expires;
        RETURN;
    END IF;

    -- Tanda llena: a la fila. El pase anterior ya no sirve.
    IF NOT v_exists THEN
        INSERT INTO event_waiting_room (event_id, session_hash, status)
        VALUES (p_event_id, p_session_hash, 'waiting')
        RETURNING * INTO v_row;
    ELSIF v_row.status <> 'waiting' THEN
        UPDATE event_waiting_room
           SET status = 'waiting', pass_hash = NULL, pass_expires_at = NULL,
               updated_at = now()
         WHERE id = v_row.id;
    END IF;

    SELECT count(*) INTO v_ahead FROM event_waiting_room wr
     WHERE wr.event_id = p_event_id AND wr.status = 'waiting'
       AND wr.created_at < v_row.created_at;

    RETURN QUERY SELECT 'waiting'::text, NULL::text, v_ahead::integer, NULL::timestamptz;
END;
$$;

-- ---------------------------------------------------------------------------
-- require_waiting_pass: el portero del checkout.
--
-- Se llama SOLO si el evento tiene la sala activa. Si el pase no existe, es
-- de otra sesión o venció, revienta: sin esto la sala sería decorativa,
-- porque cualquiera podría llamar al checkout directo saltándose la fila.
--
-- No consume el pase: lo consume `consume_waiting_pass` cuando la compra
-- sale bien. Un fan que abre el checkout y abandona conserva su pase hasta
-- que vence.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.require_waiting_pass(
    p_event_id bigint,
    p_pass text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_enabled boolean;
    v_ok      boolean;
BEGIN
    SELECT waiting_room_enabled INTO v_enabled FROM events WHERE id = p_event_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'event_not_found'; END IF;
    IF NOT v_enabled THEN RETURN; END IF;  -- sala apagada: no exige nada

    IF p_pass IS NULL OR length(p_pass) < 8 THEN
        RAISE EXCEPTION 'waiting_pass_required';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM event_waiting_room
         WHERE event_id = p_event_id
           AND pass_hash = encode(digest(p_pass, 'sha256'), 'hex')
           AND status = 'admitted'
           AND pass_expires_at > now()
    ) INTO v_ok;

    IF NOT v_ok THEN
        RAISE EXCEPTION 'waiting_pass_invalid';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- consume_waiting_pass: la compra salió bien, el pase se gasta.
--
-- Idempotente: si ya estaba usado, no hace nada. El pase no se borra (queda
-- la traza de que esa sesión sí pasó la sala).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_waiting_pass(
    p_event_id bigint,
    p_pass text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE event_waiting_room
       SET status = 'used', used_at = now(), updated_at = now()
     WHERE event_id = p_event_id
       AND pass_hash = encode(digest(p_pass, 'sha256'), 'hex')
       AND status = 'admitted';
END;
$$;

-- ---------------------------------------------------------------------------
-- waiting_room_status: para que el frontend muestre la posición sin repartir
-- pases. Lo llama el polling de la pantalla de espera.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.waiting_room_status(
    p_event_id bigint,
    p_session_hash text
) RETURNS TABLE (
    status text,
    queue_position integer,
    expires_at timestamptz
)
    LANGUAGE plpgsql
    STABLE
    AS $$
DECLARE
    v_row event_waiting_room%ROWTYPE;
    v_ahead integer;
BEGIN
    SELECT * INTO v_row FROM event_waiting_room
     WHERE event_id = p_event_id AND session_hash = p_session_hash;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'waiting'::text, NULL::integer, NULL::timestamptz;
        RETURN;
    END IF;

    IF v_row.status = 'waiting' THEN
        SELECT count(*) INTO v_ahead FROM event_waiting_room wr
         WHERE wr.event_id = p_event_id AND wr.status = 'waiting'
           AND wr.created_at < v_row.created_at;
        RETURN QUERY SELECT 'waiting'::text, v_ahead::integer, NULL::timestamptz;
    ELSIF v_row.status = 'admitted' AND v_row.pass_expires_at > now() THEN
        RETURN QUERY SELECT 'admitted'::text, 0, v_row.pass_expires_at;
    ELSE
        RETURN QUERY SELECT 'expired'::text, NULL::integer, NULL::timestamptz;
    END IF;
END;
$$;

COMMIT;
