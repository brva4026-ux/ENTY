-- 018: media (flyer subido desde el navegador).
--
-- El admin no siempre tiene un enlace para el flyer del evento: ahora sube el
-- archivo y el backend lo guarda aqui; la imagen se sirve con GET /media/{id}.
-- Solo se guardan bytes de imagen (jpeg/png/webp) que el navegador pinta con
-- <img>: nunca se ejecuta nada del contenido.
--
-- Vercel serverless no tiene disco persistente y contratar S3/R2 para un
-- flyer es sobredimensionado a este tamano: la DB es el storage.
CREATE TABLE IF NOT EXISTS media (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id    bigint NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    mime        text   NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
    bytes       bytea  NOT NULL,
    size_bytes  integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 600000),
    created_by  bigint NOT NULL REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);
