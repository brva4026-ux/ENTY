-- 010: liquidaciones de promotores (transplante de unicall-blue).
--
-- Modelo del negocio real: el promotor trabaja a comisión y el admin le
-- paga por periodo. La liquidación nace de los datos (tickets emitidos por
-- él dentro del periodo), el admin la cierra con el monto realmente pagado
-- y el promotor puede disputarla si no cuadra. Inmutable: los ajustes son
-- otra liquidación, nunca un UPDATE silencioso (patrón payment_issues de
-- unicall-blue: prueba + revisión + resolución trazable).
ALTER TABLE venues ADD COLUMN IF NOT EXISTS commission_pct numeric(5,2)
    NOT NULL DEFAULT 0 CHECK (commission_pct >= 0 AND commission_pct <= 100);

CREATE TABLE IF NOT EXISTS promoter_payouts (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id           bigint NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    promoter_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_start       date NOT NULL,
    period_end         date NOT NULL,
    tickets_count      integer NOT NULL DEFAULT 0,
    revenue_cents      bigint NOT NULL DEFAULT 0,
    commission_pct     numeric(5,2) NOT NULL DEFAULT 0
                       CHECK (commission_pct >= 0 AND commission_pct <= 100),
    commission_cents   bigint NOT NULL DEFAULT 0,
    -- Ciclo de vida (patrón payment_issues):
    --   pending -> disputed -> paid  |  pending -> paid
    --   disputed -> rejected (el admin decide no pagar; queda trazado)
    status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','disputed','paid','rejected')),
    paid_cents         bigint,
    paid_at            timestamptz,
    disputed_reason    text,
    reviewed_by        bigint REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at        timestamptz,
    review_note        text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (period_end >= period_start)
);

-- Un promotor no puede tener dos liquidaciones que se pisen en el mismo
-- rango de fechas: el rango es la identidad del pago (rango abierto: se
-- genera el siguiente desde el día posterior al último cierre).
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_unique_period
    ON promoter_payouts (venue_id, promoter_id, period_start);

CREATE INDEX IF NOT EXISTS idx_payouts_venue_status
    ON promoter_payouts (venue_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payouts_promoter
    ON promoter_payouts (promoter_id, venue_id, created_at DESC);
