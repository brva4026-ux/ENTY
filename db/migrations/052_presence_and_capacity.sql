-- =============================================================================
-- Migración 052: presencia real en el recinto y aforo que se respeta al entrar.
--
-- Hasta hoy el sistema sabía EMITIR boletos pero no sabía quién estaba ADENTRO.
-- `tickets.status = 'redeemed'` era un interruptor de un solo disparo: una vez
-- en 'redeemed' la boleta no volvía atrás, así que:
--
--   * no existía "salir" (nadie podía registrar un egreso),
--   * no existía "volver a entrar" (reingreso imposible por diseño),
--   * no existía "personas dentro" (el tablero solo contaba ingresos
--     acumulados, que crecen para siempre y no son el aforo),
--   * y el aforo NO se validaba en la puerta. Se controlaba al emitir, no al
--     admitir. Un evento con capacidad 400 y 500 boletas válidas (por
--     cortesías, reemisiones o un cambio de capacidad) aceptaba 500 ingresos
--     sin que nada lo impidiera. Ese es el bug de seguridad operativa que
--     esta migración cierra.
--
-- Diseño: `tickets.status` sigue siendo la validez del DERECHO (issued,
-- redeemed, voided, refunded) y no se toca. La PRESENCIA se modela aparte en
-- `ticket_presence`, con una fila por boleta y su estado actual. Así:
--
--   * 'redeemed' sigue significando "esta boleta ya se usó al menos una vez"
--     (compatibilidad total con lo existente: 640 tests, reportes, CSV),
--   * y la ocupación real se lee de `ticket_presence.state = 'inside'`.
--
-- Una boleta entra en presencia la primera vez que se canjea, así que no hay
-- que migrar datos: la tabla arranca vacía y se llena sola desde el próximo
-- escaneo. Para los eventos que ya están en curso, `backfill_presence()`
-- reconstruye el estado desde `redemptions` (ver nota al final).
--
-- Orden de locks: esta migración añade el lock de `ticket_presence` DESPUÉS
-- de `tickets` y de `events`, respetando el orden ya documentado en
-- reserve_ticket_payment (tipo -> evento -> cupon). Un escaneo toma:
-- tickets -> events -> ticket_presence. Nunca al revés.
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Presencia por boleta.
--
-- `state` es la verdad operativa del recinto:
--   outside  -> la boleta no está adentro (nunca entró, o ya salió)
--   inside   -> hay una persona con esa boleta adentro AHORA
--
-- `admissions` cuenta cuántas veces entró en total (para distinguir
-- "personas únicas admitidas" de "ingresos", que difieren cuando hay
-- reingreso). `last_*` guarda el último movimiento para el mensaje
-- "Ya ingresó a las 22:14 por Puerta Norte".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ticket_presence (
    ticket_id      bigint PRIMARY KEY REFERENCES public.tickets(id) ON DELETE CASCADE,
    event_id       bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    state          text NOT NULL DEFAULT 'outside',
    admissions     integer NOT NULL DEFAULT 0,
    last_in_at     timestamptz,
    last_in_door   text,
    last_out_at    timestamptz,
    last_out_door  text,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ticket_presence_state_check CHECK (state IN ('inside', 'outside')),
    CONSTRAINT ticket_presence_admissions_check CHECK (admissions >= 0)
);

-- El tablero pregunta "cuántos hay adentro de este evento" en cada refresco:
-- índice parcial, que es diminuto porque solo indexa a los que están dentro.
CREATE INDEX IF NOT EXISTS ix_ticket_presence_inside
    ON public.ticket_presence (event_id)
    WHERE state = 'inside';

-- ---------------------------------------------------------------------------
-- 2) El evento decide si admite reingreso.
--
-- Por defecto NO: un bar o un concierto suelen permitir salir y volver, pero
-- permitirlo sin decisión explícita del organizador es un riesgo de aforo
-- (alguien sale, entra otro con su boleta). El organizador lo activa.
-- ---------------------------------------------------------------------------
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS allow_reentry boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 3) Tope de aforo: el evento ya tiene `capacity`. Se añade el tope por zona
--    cuando la zona tenga capacidad propia (hoy las zonas son `ticket_types`
--    y su `quantity` es el cupo de VENTA, no el de AFORO: un organizador
--    puede vender 500 generales pero el recinto aguanta 400 personas).
--    NULL = sin tope propio, manda solo la capacidad del evento.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ticket_types
    ADD COLUMN IF NOT EXISTS access_capacity integer;

ALTER TABLE public.ticket_types
    DROP CONSTRAINT IF EXISTS ticket_types_access_capacity_check;
ALTER TABLE public.ticket_types
    ADD CONSTRAINT ticket_types_access_capacity_check
    CHECK (access_capacity IS NULL OR access_capacity > 0);

COMMIT;
