-- Seed de producción (Supabase): venue demo + 4 usuarios + evento publicado
-- con tipos y cupos. Idempotente: se puede re-ejecutar sin duplicar datos.

INSERT INTO venues (name, slug)
VALUES ('Bar Esquina', 'bar-esquina')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO users (email, full_name, password_hash) VALUES
('admin@bar.test',  'Admin Bar Esquina', '$2b$12$PckcjhmjBYqcp0rE2ddwQecuTx8A48zHl8obGYo46SF0JjoC9AhDe'),
('promo1@bar.test', 'Promo Uno',         '$2b$12$JiF3Av.M8l9jz16uep9HZuHXsuBvRbw/1AKa4s92gz98plDBclcXy'),
('promo2@bar.test', 'Promo Dos',         '$2b$12$ibbiN98quVB3QrXlVoZuOOBRXVZzOsTEbUdnvE9Q0zKp.l8CMpsZi'),
('puerta@bar.test', 'Bouncer Puerta',    '$2b$12$hR0KVBhAYL1R1fHqjgaRxuaWwLJ3CP58GvB445FWM0mSbLuoFUSoS')
ON CONFLICT (email) DO NOTHING;

INSERT INTO venue_user_roles (venue_id, user_id, role)
SELECT v.id, u.id, x.role::user_role
FROM venues v
CROSS JOIN (VALUES
  ('admin@bar.test',  'admin'),
  ('promo1@bar.test', 'promotor'),
  ('promo2@bar.test', 'promotor'),
  ('puerta@bar.test', 'bouncer')
) AS x(email, role)
JOIN users u ON u.email = x.email
WHERE v.slug = 'bar-esquina'
ON CONFLICT DO NOTHING;

-- Evento demo publicado (visible para promotores y listo para abrir puertas).
-- Se RE-FECHA en cada corrida. Antes solo se insertaba la primera vez: a los
-- pocos dias su starts_at quedaba en el pasado y la vitrina publica
-- (/public/events, que filtra starts_at >= now()) mostraba la cartelera VACIA.
-- Re-ejecutar el seed no lo arreglaba, porque el NOT EXISTS veia el evento
-- existente y salia sin tocar la fecha. El UPDATE lo revive; si el demo quedo
-- en un estado terminal (ended/cancelled, que el trigger no deja republicar),
-- el INSERT de abajo crea uno nuevo en vez de resucitar la historia.
UPDATE events
   SET starts_at = now() + interval '7 days'
 WHERE name = 'Noche Electronica'
   AND status IN ('published', 'live');

INSERT INTO events (venue_id, name, description, starts_at, capacity, status)
SELECT v.id, 'Noche Electronica', 'Evento demo de TicketFlow',
       now() + interval '7 days', 120, 'published'
FROM venues v
WHERE v.slug = 'bar-esquina'
  AND NOT EXISTS (
    SELECT 1 FROM events e
    WHERE e.name = 'Noche Electronica' AND e.status IN ('published', 'live')
  );

-- Tipos de boleta: cortesía (para cupos de promotor) y general de pago.
-- Se acotan al evento demo VISIBLE: si hay historia (un demo viejo 'ended'),
-- no se le cuelgan tipos nuevos.
INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy)
SELECT e.id, x.name, x.price, x.qty, x.cour
FROM events e
CROSS JOIN (VALUES
  ('Cortesia', 0,       50, TRUE),
  ('General',  3000000, 60, FALSE)
) AS x(name, price, qty, cour)
WHERE e.name = 'Noche Electronica'
  AND e.status IN ('published', 'live')
  AND NOT EXISTS (
    SELECT 1 FROM ticket_types tt
    WHERE tt.event_id = e.id AND tt.name = x.name
  );

-- Cupos de promotor sobre el tipo Cortesia
INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity)
SELECT e.id, tt.id, u.id, x.cap
FROM (VALUES
  ('promo1@bar.test', 5),
  ('promo2@bar.test', 3)
) AS x(email, cap)
JOIN users u ON u.email = x.email
CROSS JOIN events e
JOIN ticket_types tt ON tt.event_id = e.id AND tt.name = 'Cortesia'
WHERE e.name = 'Noche Electronica'
  AND e.status IN ('published', 'live')
ON CONFLICT (event_id, ticket_type_id, promoter_id) DO NOTHING;
