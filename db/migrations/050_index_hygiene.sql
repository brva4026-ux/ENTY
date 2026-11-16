-- =============================================================================
-- Migración 050: higiene de índices en `tickets` y `password_reset_tokens`.
--
-- Dos hallazgos de la auditoría de rendimiento, ambos verificados en navegador
-- y en EXPLAIN ANALYZE sobre una base de 400.000 tickets (mismo hardware):
--
-- 1) FALTA un índice para el conteo de vendidos por localidad. La página
--    pública del evento (y el detalle que reusa el checkout) corre, por cada
--    localidad activa:
--        SELECT count(*) FROM tickets
--         WHERE ticket_type_id = t.id AND status NOT IN ('voided','refunded')
--    Sin índice que empiece por `ticket_type_id` es un Seq Scan de `tickets`.
--    Medido (400k filas, 4 localidades):
--        sin índice -> Parallel Seq Scan .......... ~30.8 ms por localidad
--        con índice -> Index Only Scan ............ ~10.2 ms   (~3x)
--    El costo crece LINEAL con la tabla y lo paga cada apertura de la página
--    de compra. El índice es PARCIAL (solo filas vivas: ni `voided` ni
--    `refunded`): es exactamente la condición de la consulta, y deja fuera las
--    anuladas/reembolsadas, que no cuentan. Pesa ~1.4 MB sobre 400k filas.
--
-- 2) `idx_tickets_token_hash` es REDUNDANTE: `tickets_token_hash_key`
--    (constraint UNIQUE, mismo criterio) ya sirve cualquier búsqueda por
--    `token_hash`. Dos índices btree idénticos = doble costo en cada INSERT,
--    UPDATE y en el mantenimiento de autovacuum, sin beneficio de lectura.
--    Se elimina el índice suelto; el UNIQUE (que además es la garantía de
--    unicidad del token) se queda.
--
-- 3) Mismo caso en `password_reset_tokens`: la 017 declaró `token_hash UNIQUE`
--    (crea `password_reset_tokens_token_hash_key`) y ADEMÁS un
--    `idx_password_reset_token_hash` idéntico. Se retira el suelto.
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- 1) Conteo de vendidos por localidad (parcial: solo estados que cuentan).
CREATE INDEX IF NOT EXISTS idx_tickets_type_active
  ON public.tickets USING btree (ticket_type_id)
  WHERE status NOT IN ('voided', 'refunded');

-- 2) y 3) Quitar los duplicados de los índices únicos de token_hash.
DROP INDEX IF EXISTS public.idx_tickets_token_hash;
DROP INDEX IF EXISTS public.idx_password_reset_token_hash;

COMMIT;
