-- 028: la aceptacion de los documentos legales deja de ser un supuesto y pasa
-- a ser un HECHO con fecha, version, IP y agente de usuario.
--
-- Problema que resuelve: hasta hoy el registro creaba la cuenta sin que nadie
-- aceptara nada. Publicar los Terminos y Condiciones sin poder probar QUIEN los
-- acepto, CUANDO y QUE VERSION es lo mismo que no tenerlos: en una reclamacion
-- ante la Superintendencia de Industria y Comercio no hay con que responder.
--
-- Decisiones:
--
-- - legal_documents: el catalogo de documentos con SU VERSION vigente. El texto
--   vive en backend/app/assets/legal/*.md (una sola copia, versionada en git);
--   aqui vive la metadata que la app necesita para pedir y registrar la
--   aceptacion. Separar el texto del catalogo evita que la DB y los archivos se
--   contradigan: la version se sube en los dos al mismo tiempo o el test de
--   aceptacion lo delata.
--
-- - legal_acceptances con FK COMPUESTA a (slug, version): no se puede registrar
--   la aceptacion de una version que no existe. Un cliente no puede inventarse
--   "acepte la version 99" para saltarse el gate, y borrar un documento con
--   aceptaciones encima queda prohibido por la propia base.
--
-- - El sujeto puede ser una cuenta (user_id) o un anonimo identificado por su
--   telefono/correo (el invitado que abre su boleta sin cuenta). El CHECK exige
--   UNO de los dos: una fila de aceptacion sin forma de atribuirla no es prueba
--   de nada y no debe poder existir.
--
-- - Se guarda la IP y el user_agent porque es la evidencia que la ley espera
--   (Decreto 1377 de 2013, art. 7: autorizacion previa, expresa e informada).
--   Nunca se guarda el token crudo de la boleta, solo a que venue pertenece.

CREATE TABLE IF NOT EXISTS legal_documents (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug                text NOT NULL,
    version             text NOT NULL,
    title               text NOT NULL,
    -- Ruta publica donde la app muestra el documento.
    url                 text NOT NULL,
    -- Si exige aceptacion activa (los T&C y la politica) o solo informacion
    -- (el aviso de cookies, que se informa pero no se "acepta").
    requires_acceptance boolean NOT NULL DEFAULT true,
    effective_date      date NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT legal_documents_slug_version_unique UNIQUE (slug, version),
    CONSTRAINT legal_documents_slug_check CHECK (slug ~ '^[a-z0-9-]+$'),
    CONSTRAINT legal_documents_version_check CHECK (version ~ '^[0-9]+\.[0-9]+$')
);

CREATE TABLE IF NOT EXISTS legal_acceptances (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- ON DELETE SET NULL, no CASCADE: si la cuenta se borra, la PRUEBA de que
    -- acepto los terminos debe sobrevivir (es justamente lo que hay que poder
    -- mostrar en una reclamacion sobre datos tratados antes del borrado).
    user_id          bigint REFERENCES users(id) ON DELETE SET NULL,
    -- El venue al que pertenece la aceptacion. Permite responder "este bar
    -- acepto esta version" sin depender de que la cuenta siga viva.
    venue_id         bigint REFERENCES venues(id) ON DELETE SET NULL,
    document_slug    text   NOT NULL,
    document_version text   NOT NULL,
    -- Sujeto anonimo (invitado sin cuenta): el telefono es la identidad, igual
    -- que en la boleta. Nunca se guarda el token crudo.
    subject_email    text,
    subject_phone    text,
    ip               text   NOT NULL DEFAULT 'unknown',
    user_agent       text,
    accepted_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT legal_acceptances_document_fk
        FOREIGN KEY (document_slug, document_version)
        REFERENCES legal_documents (slug, version),
    -- Sin sujeto identificable la fila no prueba nada: no debe existir.
    CONSTRAINT legal_acceptances_subject_check
        CHECK (user_id IS NOT NULL OR subject_email IS NOT NULL OR subject_phone IS NOT NULL),
    -- Una cuenta acepta una version UNA vez. Los anonimos quedan fuera del
    -- UNIQUE (user_id NULL no colisiona en Postgres): dos invitados distintos
    -- pueden aceptar la misma version.
    CONSTRAINT legal_acceptances_user_unique UNIQUE (user_id, document_slug, document_version)
);

CREATE INDEX IF NOT EXISTS idx_legal_acceptances_user
    ON legal_acceptances (user_id);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_venue
    ON legal_acceptances (venue_id, document_slug);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_phone
    ON legal_acceptances (subject_phone) WHERE subject_phone IS NOT NULL;

COMMENT ON TABLE legal_documents IS
    'Catalogo de documentos legales con su version vigente. El texto vive en backend/app/assets/legal/*.md.';
COMMENT ON TABLE legal_acceptances IS
    'Prueba de la aceptacion: quien, cuando, que version, desde que IP y con que agente.';

-- ---------------------------------------------------------------------------
-- Catalogos vigentes. Subir la version de un documento = INSERT de una fila
-- nueva con la version nueva (nunca UPDATE: la version vieja debe seguir
-- existiendo para que las aceptaciones historicas conserven su FK).
-- ---------------------------------------------------------------------------
INSERT INTO legal_documents (slug, version, title, url, requires_acceptance, effective_date) VALUES
    ('terminos-plataforma', '1.0', 'Términos y Condiciones de la Plataforma', '/terminos', true,  '2026-10-15'),
    ('terminos-boleta',     '1.0', 'Términos y Condiciones de la Boleta',     '/terminos-boleta', true,  '2026-10-15'),
    ('privacidad',          '1.0', 'Política de Tratamiento de Datos Personales', '/privacidad', true, '2026-10-15'),
    ('cookies',             '1.0', 'Aviso de Cookies y Tecnologías Similares', '/cookies', false, '2026-10-15'),
    ('encargo-datos',       '1.0', 'Acuerdo de Encargo de Tratamiento de Datos', '/encargo-datos', true, '2026-10-15')
ON CONFLICT (slug, version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Que le falta aceptar a un usuario (version vigente de cada documento).
-- Es lo que permite pedir de nuevo la aceptacion cuando los terminos cambian:
-- sin esto, versionar seria decorativo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION legal_missing_acceptances(p_user_id bigint)
RETURNS TABLE (slug text, version text, title text, url text)
LANGUAGE sql
STABLE
AS $$
    SELECT d.slug, d.version, d.title, d.url
      FROM legal_documents d
     WHERE d.requires_acceptance
       -- Solo la version MAS RECIENTE de cada documento: la que rige hoy. Se
       -- compara por created_at y no por texto de version ('10.0' < '9.0' en
       -- orden alfabetico) ni por effective_date (una version futura ya
       -- cargada pediria aceptacion antes de regir).
       AND d.created_at = (
             SELECT max(d2.created_at) FROM legal_documents d2 WHERE d2.slug = d.slug
           )
       AND NOT EXISTS (
             SELECT 1 FROM legal_acceptances a
              WHERE a.user_id = p_user_id
                AND a.document_slug = d.slug
                AND a.document_version = d.version
           )
     ORDER BY d.slug
$$;

-- ---------------------------------------------------------------------------
-- Registrar una aceptacion (una fila por documento aceptado).
-- ON CONFLICT DO NOTHING lo hace idempotente: el boton "acepto" tocado dos
-- veces, o el reintento del frontend, no duplican la prueba ni rompen el flujo.
-- Devuelve cuantas aceptaciones quedaron registradas de nuevo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_legal_acceptance(
    p_user_id    bigint,
    p_venue_id   bigint,
    p_slug       text,
    p_version    text,
    p_email      text DEFAULT NULL,
    p_phone      text DEFAULT NULL,
    p_ip         text DEFAULT 'unknown',
    p_user_agent text DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
    inserted int := 0;
BEGIN
    INSERT INTO legal_acceptances
        (user_id, venue_id, document_slug, document_version,
         subject_email, subject_phone, ip, user_agent)
    VALUES
        (p_user_id, p_venue_id, p_slug, p_version,
         p_email, p_phone, COALESCE(p_ip, 'unknown'), p_user_agent)
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS inserted = ROW_COUNT;
    RETURN inserted;
END;
$$;
