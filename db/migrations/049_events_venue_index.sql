-- =============================================================================
-- Migración 049: índice por venue en `events` (la consulta más caliente del panel).
--
-- Problema: la carga del panel (admin y promotor) hace
--     SELECT ... FROM events WHERE venue_id=%s ORDER BY starts_at DESC LIMIT %s
-- y `events` solo tenía `events_pkey` y el índice parcial `idx_events_ends_unended`
-- (ends_at, para el auto-cierre). Sin un índice que empiece por `venue_id`,
-- Postgres recorre la tabla ENTERA y ordena para devolver 20 filas.
--
-- Medido sobre 60.000 eventos en 200 venues (mismo hardware):
--   sin índice -> Seq Scan + top-N heapsort ........ ~5.8 ms
--   con índice -> Index Scan ........................ ~0.3 ms   (~19x)
-- El costo crece LINEAL con la tabla, y lo paga cada carga de panel, cada
-- re-fetch del live-refresh y cada apertura de puerta (/door-snapshot usa el
-- mismo filtro por venue).
--
-- El orden de columnas importa: `venue_id` primero (igualdad) y `starts_at DESC`
-- segundo (ordena sin sort aparte). Un índice solo sobre (venue_id) sirve para
-- el filtro pero no evita el sort.
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_events_venue_starts
  ON public.events USING btree (venue_id, starts_at DESC);

COMMIT;
