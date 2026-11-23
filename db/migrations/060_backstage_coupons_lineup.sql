-- 060: backstage operativo.
--
--   * Cupones por localidad: un TEMPRANO20 puede aplicar solo a General y no
--     a VIP. NULL = todas las localidades del evento (comportamiento previo).
--   * Lineup con imagen, hora y descripción: el cartel público deja de ser
--     solo una lista de nombres.

BEGIN;

ALTER TABLE coupons
    ADD COLUMN IF NOT EXISTS ticket_type_ids bigint[];

ALTER TABLE event_lineup
    ADD COLUMN IF NOT EXISTS image_url text,
    ADD COLUMN IF NOT EXISTS starts_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS description text;

COMMIT;
