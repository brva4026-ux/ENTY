-- 030: los plazos que las versiones del día dejaban como [COMPLETAR: X]
-- pasan a valores concretos (mora 15d, preaviso 30d, exportacion 30d,
-- responsabilidad 12m, confidencialidad 5a, aviso de modificacion 15d,
-- reembolso 15d, horario de soporte). Un contrato publicado con corchetes
-- de plantilla no es exigible: esto cierra ese hueco.
--
-- Mismo criterio de siempre: INSERT de fila nueva, nunca UPDATE. La
-- re-aceptacion se pide sola (missing_acceptances solo mira la mas
-- reciente por slug).

INSERT INTO legal_documents (slug, version, title, url, requires_acceptance, effective_date) VALUES
    ('terminos-plataforma', '1.2', 'Términos y Condiciones de la Plataforma', '/terminos',      true,  '2026-10-17'),
    ('terminos-boleta',     '1.1', 'Términos y Condiciones de la Boleta',     '/terminos-boleta', true, '2026-10-17'),
    ('encargo-datos',       '1.2', 'Acuerdo de Encargo de Tratamiento de Datos', '/encargo-datos', true, '2026-10-17')
ON CONFLICT (slug, version) DO NOTHING;
