-- 036: contacto del organizador del negocio.
--
-- Problema: la pagina publica de presentacion quiere ofrecer "encarga tu
-- boleta" y hoy no tiene a quien apuntar. El catalogo publico (/public/events)
-- expone el evento y su venue, pero no un telefono: el fan que llega por un
-- enlace compartido ve la cartelera y no sabe con quien hablar para apartar un
-- cupo. El unico contacto que existe es el del ASISTENTE (tickets.customer_*),
-- que no sirve: es del comprador, no de quien vende.
--
-- Decisiones:
--   * Vive en `venues` y no en `events`. El equipo que organiza (admin,
--     puerta, revendedor) es del negocio y atiende todas sus noches; repetir
--     el mismo telefono evento por evento seria una copia que se desincroniza.
--     Si manana una noche necesita su propio encargado, se agrega ahi con su
--     propia migracion, no relajando esta.
--   * Ambos NULLABLE: un negocio que todavia no quiere publicar telefono sigue
--     operando igual, y la pagina publica simplemente no muestra el bloque de
--     encargo (nunca un boton de WhatsApp a un numero vacio).
--   * `contact_phone` en TEXTO LIBRE (no solo digitos): se guarda tal como la
--     persona lo escribe ("+57 300 123 4567") para mostrarlo legible; el
--     formato para wa.me lo normaliza el frontend (lib/whatsapp.js), que es
--     quien conoce esa regla.
--   * `contact_name` es el nombre visible del encargado ("Ana - reservas"):
--     sin el, el boton diria "Escribir" y no a quien.

BEGIN;

ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact_name text;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact_phone text;

COMMIT;
