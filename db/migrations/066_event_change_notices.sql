-- 066: avisos de cambio de evento para quienes ya compraron.
--
-- Un cambio de fecha, lugar o condiciones después de vender no puede quedar
-- solo en el panel: el comprador tiene que verlo al abrir su boleta. Guardamos
-- el aviso con el texto ya armado (anterior -> nuevo + qué hacer) y el impacto
-- en compras. La comunicación automática por correo/WhatsApp depende de los
-- canales configurados; este registro es la fuente que la app muestra y que
-- Administración puede copiar para enviar.

CREATE TABLE IF NOT EXISTS public.event_change_notices (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id bigint NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
    event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('updated', 'cancelled')),
    title text NOT NULL,
    message text NOT NULL,
    old_values jsonb NOT NULL DEFAULT '{}'::jsonb,
    new_values jsonb NOT NULL DEFAULT '{}'::jsonb,
    affected_tickets integer NOT NULL DEFAULT 0,
    affected_buyers integer NOT NULL DEFAULT 0,
    created_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_change_notices_event
    ON public.event_change_notices (event_id, created_at DESC);
