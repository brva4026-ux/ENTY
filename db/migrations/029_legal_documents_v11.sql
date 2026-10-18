-- 029: versiones 1.1 de los documentos legales tras el primer cierre de
-- identidad y canales de la plataforma (y el retiro de un tercero).
--
-- Dos cambios de fondo en los textos, publicados juntos:
--
-- 1. Tipografia auto-hospedada: la app ya no pide la fuente a
--    fonts.googleapis.com, asi que Google deja de recibir la IP del visitante.
--    Sale de la tabla de terceros del aviso de cookies y de la lista de
--    encargados de la politica (menos transferencias internacionales que
--    declarar, que es justo lo que la Ley 1581 exige documentar).
-- 2. Identidad declara: domicilio, correo de soporte/seguridad/habeas data y
--    telefono de la plataforma. La razon social y el NIT siguen pendientes de
--    constitucion; cuando existan se publica la 1.2 y la re-aceptacion se
--    pide sola.
--
-- Convencion de catalogo (mig 028): subir la version = INSERT de una fila
-- nueva, nunca UPDATE — la version vieja debe seguir existiendo para que las
-- aceptaciones historicas conserven su FK. La re-aceptacion se pide sola:
-- legal_missing_acceptances solo devuelve la version mas reciente de cada
-- documento, y los exigibles (terminos-plataforma, encargo-datos, privacidad)
-- vuelven a pedir consentimiento por haber cambiado. terminos-boleta NO
-- cambia: su texto no se toco, sigue rigiendo la 1.0.

INSERT INTO legal_documents (slug, version, title, url, requires_acceptance, effective_date) VALUES
    ('terminos-plataforma', '1.1', 'Términos y Condiciones de la Plataforma',     '/terminos',       true,  '2026-10-17'),
    ('cookies',             '1.1', 'Aviso de Cookies y Tecnologías Similares',    '/cookies',        false, '2026-10-17'),
    ('privacidad',          '1.1', 'Política de Tratamiento de Datos Personales', '/privacidad',     true,  '2026-10-17'),
    ('encargo-datos',       '1.1', 'Acuerdo de Encargo de Tratamiento de Datos',  '/encargo-datos',  true,  '2026-10-17')
ON CONFLICT (slug, version) DO NOTHING;
