#!/usr/bin/env bash
# =============================================================================
# Prueba de sobventa por concurrencia.
#
# Escenario: un cupo de promotor (promoter_allocation) con capacidad = C.
# Lanza N="workers" procesos PostgreSQL simultáneos que intentan emitir una
# boleta cada uno. La DB (SELECT ... FOR UPDATE) debe dejar entrar EXACTAMENTE
# C y rechazar el resto.
#
# Uso:
#   bash concurrent_overbooking.sh "postgresql://user:pass@host:port/db"
# =============================================================================
set -euo pipefail

PSQL="${PSQL:-psql}"   # permite: PSQL="sudo docker exec -i ticketflow_db psql -U postgres -d ticketflow"
DATABASE_URL="${1:-postgresql://postgres:devpassword@localhost:5433/ticketflow}"
WORKERS="${WORKERS:-10}"
CAPACITY="${CAPACITY:-3}"

psql() { $PSQL -tAc "$1"; }
sql()  { $PSQL -c "$1" >/dev/null 2>&1; }
id()   { $PSQL -tAc "$1" | tail -1; }

echo "==> Preparando escenario (cupo=$CAPACITY, workers=$WORKERS)"
EVENT_ID=$(id "SELECT id FROM events WHERE name='Concurso' LIMIT 1")
if [ -n "$EVENT_ID" ]; then
  sql "DELETE FROM tickets WHERE event_id IN (SELECT id FROM events WHERE name='Concurso');"
  sql "DELETE FROM promoter_allocations WHERE event_id=(SELECT id FROM events WHERE name='Concurso');"
  sql "DELETE FROM ticket_types WHERE event_id=(SELECT id FROM events WHERE name='Concurso');"
  sql "DELETE FROM events WHERE name='Concurso';"
fi
sql "INSERT INTO users (email, password_hash, full_name) VALUES ('conc@test.co','x','Conc') ON CONFLICT (email) DO NOTHING;"
sql "INSERT INTO venues (name, slug) VALUES ('Conc Venue','conc-venue') ON CONFLICT (slug) DO NOTHING;"
sql "INSERT INTO events (venue_id, name, starts_at, capacity, status) SELECT id,'Concurso',now()+'7d',100,'published' FROM venues WHERE slug='conc-venue' ON CONFLICT DO NOTHING;"
EVENT_ID=$(id "SELECT id FROM events WHERE name='Concurso' LIMIT 1")
sql "INSERT INTO ticket_types (event_id, name, price_cents, quantity, is_courtesy) SELECT id,'Concurso',0,100,TRUE FROM events WHERE name='Concurso' ON CONFLICT (event_id,name) DO NOTHING;"
TYPE_ID=$(id "SELECT id FROM ticket_types WHERE event_id=$EVENT_ID AND name='Concurso' LIMIT 1")
PROMO_ID=$(id "SELECT id FROM users WHERE email='conc@test.co' LIMIT 1")
sql "INSERT INTO promoter_allocations (event_id, ticket_type_id, promoter_id, capacity) VALUES ($EVENT_ID,$TYPE_ID,$PROMO_ID,$CAPACITY) ON CONFLICT (event_id,ticket_type_id,promoter_id) DO UPDATE SET capacity=EXCLUDED.capacity;"
ALLOC_ID=$(id "SELECT id FROM promoter_allocations WHERE event_id=$EVENT_ID AND ticket_type_id=$TYPE_ID AND promoter_id=$PROMO_ID LIMIT 1")

echo "   ids -> event=$EVENT_ID type=$TYPE_ID promo=$PROMO_ID alloc=$ALLOC_ID"

echo "==> Lanzando $WORKERS emisiones concurrentes"
rm -f /tmp/conc_results.txt
for i in $(seq 1 "$WORKERS"); do
  ( out=$($PSQL -tAc "SELECT emit_ticket($EVENT_ID,$TYPE_ID,$ALLOC_ID,$PROMO_ID,'Conc C$i','conc-token-$i',NULL,NULL);" 2>&1 || true); echo "$i|$out" ) >> /tmp/conc_results.txt &
done
wait

OK=$(grep -cE '^\S+\|[0-9]+$' /tmp/conc_results.txt || true)
EXC=$(grep -c "promoter_quota_exceeded" /tmp/conc_results.txt || true)

echo "==> RESULTADOS"
echo "  emitidas OK:            $OK"
echo "  rechazadas (exceeded):  $EXC"
echo "  esperado:               OK=$CAPACITY, rechazadas=$((WORKERS-CAPACITY))"
echo "  extraordinario (si OK != CAPACITY) -> FALLO"

# Conteo real en DB
REAL=$(psql "SELECT count(*) FROM tickets t WHERE t.allocation_id=$ALLOC_ID AND t.status NOT IN ('voided','refunded');")
echo "  boletas en DB:          $REAL"

[ "$OK" -eq "$CAPACITY" ] && [ "$REAL" -eq "$CAPACITY" ] && echo "==> ✅ PRUEBA PASÓ" || { echo "==> ❌ PRUEBA FALLÓ"; exit 1; }