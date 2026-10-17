#!/usr/bin/env bash
# Deploy de TicketFlow a produccion (Supabase + Vercel) en un solo comando.
#
# Orden: primero el schema consolidado, luego TODAS las migraciones.
#   * db/schema.sql es el esquema completo (tablas, enums, extensiones y
#     funciones de negocio). Lo genera pg_dump --schema-only y
#     backend/tests/test_schema_drift.py falla si alguien agrega una migracion
#     sin consolidarla.
#   * Las migraciones de db/migrations/ son no-ops sobre el schema consolidado
#     (todas IF NOT EXISTS / OR REPLACE), pero se aplican igual porque una base
#     vieja puede no tenerlas. Antes este script aplicaba SOLO 003 y 004 con una
#     lista hardcodeada: una base reconstruida desde aqui quedaba sin las 23
#     migraciones restantes y sin nada que lo avisara.
#
# Uso:
#   npx vercel login                            # una sola vez
#   export SUPABASE_ACCESS_TOKEN=sbp_...        # https://supabase.com/dashboard/account/tokens
#   bash scripts/deploy.sh
#
# Todo es idempotente (safe re-run): se puede correr las veces que haga falta.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_REF="${SUPABASE_PROJECT_REF:-wjknwlrcacalilfrfqyq}"
SCHEMA="db/schema.sql"

# Glob ordenado: 003_..., 004_..., ..., 027_.... El orden importa (cada
# migracion asume las anteriores); el prefijo numerico lo garantiza.
MIGRATIONS=("$SCHEMA")
for f in db/migrations/*.sql; do
  MIGRATIONS+=("$f")
done

echo "==> 1/3 Esquema + migraciones en Supabase (ref: $PROJECT_REF)"
if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "    AVISO: falta SUPABASE_ACCESS_TOKEN -> se saltan schema y migraciones."
  echo "    OJO: la app fallara en produccion si la base no tiene las funciones."
else
  for f in "${MIGRATIONS[@]}"; do
    echo "    aplicando $f"
    (cd scripts && SUPABASE_PROJECT_REF="$PROJECT_REF" node run-sql.js "../$f")
  done
fi

echo "==> 2/3 Build del frontend (verificacion previa al deploy)"
(cd frontend && npm run build)
test -f frontend/dist/index.html && echo "    dist ok"

echo "==> 3/3 Deploy a Vercel (produccion)"
npx --yes vercel --prod --yes

echo
echo "==> Listo. Verifica:"
echo "    curl -s https://ticketflow-brva4026-ux.vercel.app/api/health"
echo "    curl -s -X POST https://ticketflow-brva4026-ux.vercel.app/api/auth/login \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"email\":\"admin@bar.test\",\"password\":\"demo1234\"}'"
