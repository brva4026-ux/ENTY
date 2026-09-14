-- Escenario base para la prueba de concurrencia (el runner bash lo usa).
-- Idempotente; conviene ejecutarlo en una DB limpia o con rollback.
BEGIN;
INSERT INTO users (email, password_hash, full_name)
VALUES ('conc@test.co','x','Conc') ON CONFLICT (email) DO NOTHING;
INSERT INTO venues (name, slug) VALUES ('Conc Venue','conc-venue') ON CONFLICT (slug) DO NOTHING;
INSERT INTO events (venue_id, name, starts_at, capacity, status)
SELECT id, 'Concurso', now()+'7d', 100, 'published' FROM venues WHERE slug='conc-venue'
ON CONFLICT DO NOTHING;
INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy)
SELECT e.id, 'Concurso', 0, 100, TRUE FROM events e WHERE e.name='Concurso'
ON CONFLICT (event_id, name) DO NOTHING;
INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity)
SELECT e.id, tt.id, u.id, 3
FROM events e, ticket_types tt, users u
WHERE e.name='Concurso' AND tt.name='Concurso' AND u.email='conc@test.co'
ON CONFLICT (event_id, ticket_type_id, promoter_id) DO UPDATE SET capacity=EXCLUDED.capacity;
COMMIT;

-- Verificación manual de que tras las 10 emisiones concurrentes quedan 3 boletas:
-- SELECT count(*) FROM tickets t
-- JOIN promoter_allocations a ON a.id=t.allocation_id
-- WHERE a.event_id=(SELECT id FROM events WHERE name='Concurso');