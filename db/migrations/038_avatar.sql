-- 038: foto de perfil.
--
-- Problema: el hero del perfil muestra iniciales porque no hay foto. La
-- infraestructura de imagenes ya existe (mig 018: bytes en `media`, servidos
-- por GET /media/{id} con cache inmutable), pero esta atada al negocio:
-- `media.venue_id` es NOT NULL y la unica subida es /venues/{id}/media con
-- ensure_roles. Un avatar no pertenece a ningun negocio.
--
-- Decisiones:
--   * `media.venue_id` pasa a NULLABLE en vez de crear una tabla paralela de
--     imagenes de usuario. El almacenamiento, el limite de 600 KB, los mime
--     permitidos y el GET publico con cache ya estan resueltos y probados; una
--     segunda tabla duplicaria esa logica y sus CHECK. Las filas existentes no
--     cambian: siguen todas con su venue.
--   * La propiedad de una imagen sin negocio se apoya en `created_by` (ya
--     NOT NULL), que es el usuario que la subio. El borrado del avatar viejo
--     filtra por created_by AND venue_id IS NULL, asi nadie borra bytes ajenos.
--   * `users.avatar_url` es TEXTO con la URL relativa (/media/{id}), igual que
--     `venues.logo_url`: el resto del frontend ya sabe pintar esa forma. No se
--     acepta una URL arbitraria desde el cliente; solo la escribe el endpoint
--     de subida, que es quien inserta la fila en `media`.
--   * NULLABLE sin backfill: sin foto no hay nada que inventar, y el hero
--     sigue mostrando las iniciales con el anillo del rol.

BEGIN;

ALTER TABLE media ALTER COLUMN venue_id DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;

COMMIT;
