-- 019: hardening P0 de seguridad (puntos pendientes de la auditoria).
--
-- 1) token_version en users: revocar TODAS las sesiones de un usuario al
--    cambiar (o resetear) su contraseña. Los roles ya viven en la DB y se
--    re-verifican en cada request; esto cierra la ventana que quedaba para
--    el token JWT roto en la mano de alguien tras un cambio de clave.
--    Los tokens viejos (sin el claim `tver`) siguen validos hasta su
--    expiracion natural de 60 min: migracion sin loguear a todo el mundo.
-- 2) audit_log: un solo lugar para "quien hizo que" en acciones de dinero y
--    de datos personales que antes no dejaban rastro:
--      - cambio de precio/cupo de un tipo de boleta (dinero real)
--      - cambio de cupos de promotor
--      - exportaciones CSV (la base de clientes saliendo del sistema)
--    Las que ya tenian tabla propia no se duplican: redemptions (quien
--    escaneo, con outcome), ticket_reissues, ticket_contact_edits,
--    promoter_payouts.reviewed_by (quien pago la comision).
-- 3) Indice para el rate limit de escaneos por usuario: cada redeem ya
--    escribe en redemptions, asi que el limite se calcula con lo que hay.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS token_version int NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS audit_log (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id   bigint NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    actor_id   bigint REFERENCES users(id) ON DELETE SET NULL,
    kind       text NOT NULL,   -- ticket_type_change | allocation_change | export
    entity     text NOT NULL,   -- ticket_type | allocation | tickets_csv | overview_csv
    entity_id  bigint,
    details    jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_venue_idx ON audit_log (venue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor_id, created_at DESC);

-- Rate limit de puerta: escaneos recientes de un mismo usuario.
CREATE INDEX IF NOT EXISTS idx_redemptions_scanner
    ON redemptions (scanned_by_user_id, scanned_at DESC);
