-- Mig 045: el rango de una liquidación no puede pisar a otro (doble pago).
--
-- generate_payout validaba el solape leyendo max(period_end) e insertando
-- después, SIN lock: dos admins concurrentes (o un doble clic) pasaban los dos
-- y el promotor cobraba dos veces el mismo tramo de ventas. El índice único
-- idx_payouts_unique_period solo cubre period_start IDÉNTICO; un solape con
-- otro inicio (01-01..01-31 vs 01-15..02-15) pasaba limpio.
--
-- La invariante se mueve a la DB: una exclusion constraint la hace imposible
-- incluso bajo concurrencia (el índice GiST la enforcea en el INSERT, no en un
-- SELECT previo). El endpoint conserva su chequeo solo para dar un 409 legible.
--
-- btree_gist habilita el operador `=` (venue_id, promoter_id) dentro de un
-- índice GiST; sin la extensión, `EXCLUDE USING gist` con columnas escalares
-- no compila.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

ALTER TABLE public.promoter_payouts
    DROP CONSTRAINT IF EXISTS promoter_payouts_no_overlap;

ALTER TABLE public.promoter_payouts
    ADD CONSTRAINT promoter_payouts_no_overlap
    EXCLUDE USING gist (
        venue_id WITH =,
        promoter_id WITH =,
        daterange(period_start, period_end, '[]') WITH &&
    );

-- El índice único de periodo queda subsumido: dos rangos con el MISMO inicio
-- también se solapan, así que la exclusion constraint ya los rechaza.
DROP INDEX IF EXISTS public.idx_payouts_unique_period;
