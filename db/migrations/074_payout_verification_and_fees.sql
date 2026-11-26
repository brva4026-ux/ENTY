-- 074: habilitar cobros con responsable verificado y comisión de Enty.
--
-- Dos frentes que van juntos porque tocan el mismo dinero:
--
-- 1. Un negocio puede crear y publicar eventos desde el primer día, pero no
--    puede vender en línea hasta que Enty revise quién responde y a dónde
--    llega el dinero. Los negocios que ya existían quedan aprobados por
--    migración para no cortar ventas el día del deploy; los nuevos arrancan
--    en `not_started`.
-- 2. La comisión de Enty se configura por evento y se congela en el cobro.
--    No se recalcula al reportar: un cambio de tarifa no reescribe la
--    historia.

BEGIN;

CREATE TABLE IF NOT EXISTS public.venue_payout_profiles (
    venue_id bigint PRIMARY KEY REFERENCES public.venues(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'not_started'
        CHECK (status IN ('not_started','pending','approved','rejected')),
    legal_name text,
    tax_id text,
    contact_name text,
    contact_phone text,
    contact_email text,
    bank_name text,
    bank_account_type text
        CHECK (bank_account_type IS NULL OR bank_account_type IN ('ahorros','corriente','billetera')),
    bank_account_last4 text
        CHECK (bank_account_last4 IS NULL OR bank_account_last4 ~ '^[0-9]{4}$'),
    payout_provider text,
    payout_account_ref text,
    missing_items text[] NOT NULL DEFAULT '{}'::text[],
    review_note text,
    submitted_at timestamp with time zone,
    reviewed_at timestamp with time zone,
    reviewed_by_user_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_venue_payout_profiles_status
    ON public.venue_payout_profiles (status);

-- Los negocios que ya vendían no se apagan por una migración. La revisión
-- aplica a los que se den de alta después de este deploy.
INSERT INTO public.venue_payout_profiles
    (venue_id, status, legal_name, tax_id, reviewed_at, review_note)
SELECT id, 'approved', legal_name, tax_id, now(),
       'Negocio existente: aprobado durante la migración 074'
  FROM public.venues
ON CONFLICT (venue_id) DO NOTHING;

ALTER TABLE public.event_fee_config
    ADD COLUMN IF NOT EXISTS platform_fee_bps integer NOT NULL DEFAULT 0
        CHECK (platform_fee_bps >= 0 AND platform_fee_bps <= 10000),
    ADD COLUMN IF NOT EXISTS platform_fee_fixed_cents bigint NOT NULL DEFAULT 0
        CHECK (platform_fee_fixed_cents >= 0),
    ADD COLUMN IF NOT EXISTS platform_fee_payer text NOT NULL DEFAULT 'organizer'
        CHECK (platform_fee_payer IN ('organizer','buyer'));

ALTER TABLE public.ticket_payments
    ADD COLUMN IF NOT EXISTS platform_fee_cents bigint NOT NULL DEFAULT 0
        CHECK (platform_fee_cents >= 0),
    ADD COLUMN IF NOT EXISTS organizer_net_cents bigint NOT NULL DEFAULT 0
        CHECK (organizer_net_cents >= 0),
    ADD COLUMN IF NOT EXISTS fee_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
