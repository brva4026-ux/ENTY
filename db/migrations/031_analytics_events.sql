-- 031: embudo de producto (vitrina -> compra).
--
-- Problema: la app no medía nada. Se podía saber cuántas boletas se vendieron
-- (tickets, ticket_payments) pero no cuánta gente llegó a la vitrina, cuánta
-- abrió un evento ni cuánta empezó un checkout. Sin eso, cualquier cambio de
-- portada o de precio se decide a ciegas.
--
-- Decisiones:
--   * Primer partido de la casa: no se integra un SaaS. El CSP de la app es
--     `script-src 'self'` (vercel.json): un script de terceros obligaría a
--     abrir el CSP y a un banner de cookies. Estos eventos se envían al propio
--     backend y viven en la misma DB, sin cookies ni identificadores
--     personales.
--   * Minimización: solo el nombre del evento del embudo (CHECK cerrado), un
--     id de sesión aleatorio (sessionStorage: muere al cerrar la pestaña), la
--     ruta y el id del evento de catálogo. NI IP, NI user id, NI texto libre.
--     `props` queda para datos acotados (p. ej. el filtro usado), nunca
--     contacto del fan.
--   * El último paso del embudo NO se duplica aquí: la compra pagada vive en
--     ticket_payments (mig 023), que es la única fuente de verdad del dinero.
--     Copiarla como evento de navegador daría un número que no cuadra con la
--     caja.
--   * `event_id` con ON DELETE SET NULL: borrar un evento no debe borrar el
--     histórico del embudo (se pierde el detalle, no el total).

BEGIN;

CREATE TABLE IF NOT EXISTS analytics_events (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       text NOT NULL
               CHECK (name IN ('view_home', 'view_event', 'checkout_start')),
    -- Id aleatorio por pestaña, generado en el cliente. No identifica a nadie
    -- entre visitas ni entre dispositivos: sirve para contar SESIONES únicas.
    session_id text NOT NULL CHECK (length(session_id) BETWEEN 8 AND 64),
    path       text CHECK (path IS NULL OR length(path) <= 200),
    event_id   bigint REFERENCES events(id) ON DELETE SET NULL,
    props      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- El embudo se consulta siempre por ventana de tiempo + nombre del paso.
CREATE INDEX IF NOT EXISTS idx_analytics_events_name_created
    ON analytics_events (name, created_at DESC);

-- La sesión se cruza con eventos de una venue: este índice evita escanear la
-- tabla cuando el embudo se pide por evento/venue.
CREATE INDEX IF NOT EXISTS idx_analytics_events_session
    ON analytics_events (session_id);

COMMIT;
