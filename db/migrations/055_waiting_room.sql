-- =============================================================================
-- Migración 055: sala de espera virtual con pases temporales.
--
-- Esto NO es la lista de espera (mig 022, `event_waitlist`). Son problemas
-- distintos:
--
--   * `event_waitlist` = el evento esta AGOTADO y el fan deja su telefono
--     para que le ofrezcan un lugar cuando alguien devuelva el suyo. Es una
--     cola de demanda contra un stock que no existe.
--
--   * la sala de espera = el evento TIENE boletas, pero el pico de trafico
--     tumbaria la venta. Es una cola de CARGA: se deja entrar de a tandas,
--     cada fan recibe un pase que vale unos minutos, y solo con pase valido
--     puede abrir el checkout. Es lo que hace Ticketmaster cuando sale un
--     cartel grande: no vendes mas rapido, vendes sin caerte.
--
-- El pase es un token opaco de vida corta. Se guarda SOLO su hash, igual que
-- el token de la boleta: si se filtra la tabla, no se pueden fabricar pases.
--
-- Modo de uso: el evento activa la sala (`waiting_room_enabled`). Si esta
-- apagada no cambia NADA del comportamiento actual: cero riesgo de regresion.
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Configuracion por evento.
--
-- `waiting_room_enabled` apagado por defecto: la sala es una decision
-- operativa, no un comportamiento implicito.
--
-- `waiting_room_batch` es cuanta gente entra por tanda y
-- `waiting_room_pass_minutes` cuanto dura el pase. Juntos definen el caudal:
-- con tanda 50 y pase de 10 minutos, el sistema admite ~5 fans por minuto,
-- que es un ritmo que cualquier backend aguanta.
-- ---------------------------------------------------------------------------
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS waiting_room_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS waiting_room_batch integer NOT NULL DEFAULT 50;

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS waiting_room_pass_minutes integer NOT NULL DEFAULT 10;

ALTER TABLE public.events
    DROP CONSTRAINT IF EXISTS events_waiting_room_batch_check;
ALTER TABLE public.events
    ADD CONSTRAINT events_waiting_room_batch_check
    CHECK (waiting_room_batch > 0);

ALTER TABLE public.events
    DROP CONSTRAINT IF EXISTS events_waiting_room_pass_check;
ALTER TABLE public.events
    ADD CONSTRAINT events_waiting_room_pass_check
    CHECK (waiting_room_pass_minutes > 0);

-- ---------------------------------------------------------------------------
-- 2) La fila.
--
-- Una fila por visitante y evento, identificada por un token de sesion que el
-- navegador guarda. `status`:
--
--   waiting  -> en la cola, sin pase
--   admitted -> tiene pase vigente, puede comprar
--   used     -> ya compro (el pase se consumio)
--   expired  -> el pase vencio sin comprar; vuelve al final si reintenta
--
-- `position_at` no se guarda: el orden es `created_at`, que no se reescribe.
-- Guardar un numero de posicion obligaria a actualizar a todos los de atras
-- en cada admision (una escritura masiva por tanda); el orden real es la
-- secuencia de llegada.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_waiting_room (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id     bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    session_hash text NOT NULL,
    pass_hash    text,
    status       text NOT NULL DEFAULT 'waiting',
    admitted_at  timestamptz,
    pass_expires_at timestamptz,
    used_at      timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT event_waiting_room_status_check
        CHECK (status IN ('waiting', 'admitted', 'used', 'expired')),
    CONSTRAINT event_waiting_room_session_unique UNIQUE (event_id, session_hash)
);

-- La consulta caliente es "quienes estan esperando en este evento, en orden".
-- Indice parcial: solo indexa la cola viva, no los pases ya gastados.
CREATE INDEX IF NOT EXISTS ix_event_waiting_room_queue
    ON public.event_waiting_room (event_id, created_at)
    WHERE status = 'waiting';

-- Y "cuantos pases vigentes hay ahora" para calcular el caudal.
CREATE INDEX IF NOT EXISTS ix_event_waiting_room_active
    ON public.event_waiting_room (event_id, pass_expires_at)
    WHERE status = 'admitted';

COMMIT;
