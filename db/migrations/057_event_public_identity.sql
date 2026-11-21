-- =============================================================================
-- 057 — Identidad pública del evento: video, mapa confirmado y contacto.
-- =============================================================================
-- La ficha pública ya tenía afiche, descripción, lugar y lineup (043). Le
-- faltaba lo que el organizador necesita para darle identidad propia a CADA
-- evento y para que alguien que llega desde WhatsApp sepa qué es, dónde es y
-- a quién escribir:
--
--   1. video_url    — clip promocional opcional (MP4/WebM). No se sube a
--                     `media` porque esa tabla es de imágenes (600 KB) y
--                     Vercel limita el cuerpo de la función; el organizador
--                     publica el clip en su hosting y pega el enlace.
--   2. location_url — enlace de mapa que el organizador CONFIRMA (Google
--                     Maps/OpenStreetMap). Sin él, la ficha muestra la
--                     dirección en texto pero no inventa un mapa aproximado.
--   3. contact_name / contact_phone — contacto público por evento. NULL cae
--                     al contacto del local (venues.contact_*), así los
--                     eventos publicados antes de esta migración no cambian.
--
-- Idempotente: safe re-run (ADD COLUMN IF NOT EXISTS). Todas las columnas son
-- NULLables: ningún evento existente necesita backfill.
-- =============================================================================

BEGIN;

ALTER TABLE events ADD COLUMN IF NOT EXISTS video_url text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS location_url text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS contact_name text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS contact_phone text;

COMMENT ON COLUMN events.video_url IS
    'Clip promocional opcional (MP4/WebM). URL pública https; la ficha lo reproduce dentro de la página.';
COMMENT ON COLUMN events.location_url IS
    'Enlace de mapa confirmado por el organizador (Google Maps/OSM). NULL = solo mostrar la dirección.';
COMMENT ON COLUMN events.contact_name IS
    'Nombre del contacto público de ESTE evento. NULL = usar venues.contact_name.';
COMMENT ON COLUMN events.contact_phone IS
    'WhatsApp público de ESTE evento. NULL = usar venues.contact_phone.';

COMMIT;
