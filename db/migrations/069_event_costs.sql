-- 069: costos del evento y punto de equilibrio.
--
-- El administrador registra lo que cuesta la noche en tres etapas:
--   estimated = lo que cree que va a costar
--   committed = lo que ya contrató / le facturaron
--   paid      = lo que ya pagó
--
-- El punto de equilibrio usa `committed` cuando existe (es el costo real
-- conocido) y cae a `estimated` mientras solo hay estimaciones. El dinero
-- cobrado sale de las boletas activas menos los reembolsos, no de una
-- proyección.

CREATE TABLE IF NOT EXISTS public.event_costs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    description text NOT NULL,
    category text NOT NULL DEFAULT 'otro',
    amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
    status text NOT NULL DEFAULT 'estimated'
        CHECK (status IN ('estimated', 'committed', 'paid')),
    notes text,
    created_by_user_id bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_costs_event
    ON public.event_costs (event_id, status);

CREATE INDEX IF NOT EXISTS idx_event_costs_venue
    ON public.event_costs (venue_id, created_at DESC);
