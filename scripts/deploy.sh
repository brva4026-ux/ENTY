#!/usr/bin/env bash
# Deploy de TicketFlow a produccion (Supabase + Vercel) en un solo comando.
#
# Que aplica: TODAS las migraciones de db/migrations/ en orden numerico.
#   * Las migraciones son idempotentes (IF NOT EXISTS / OR REPLACE): re-correr
#     este script no rompe nada, asi que cada deploy las re-aplica y ninguna
#     base queda atras.
#   * db/schema.sql NO se aplica aqui: crea tablas y enums SIN guardas, asi que
#     una segunda corrida aborta con `type "ticket_status" already exists` y
#     tumba el deploy. Se aplica UNA sola vez al crear una instalacion nueva
#     (docs/despliegue.md, Paso 1). En una base existente el esquema ya esta.
#   * La lista es un glob ordenado a proposito: agregar una migracion nueva no
#     obliga a tocar este script. Una lista a mano se desfasa y despliega
#     codigo que usa objetos que la base todavia no tiene (500 en rutas nuevas).
#
# Uso:
#   npx vercel login                            # una sola vez
#   export SUPABASE_ACCESS_TOKEN=sbp_...        # https://supabase.com/dashboard/account/tokens
#   bash scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_REF="${SUPABASE_PROJECT_REF:-wjknwlrcacalilfrfqyq}"

# Glob ordenado: 002_..., 003_..., ..., 030_.... El orden importa (cada
# migracion asume las anteriores); el prefijo numerico lo garantiza.
MIGRATIONS=()
for f in db/migrations/*.sql; do
  MIGRATIONS+=("$f")
done

echo "==> 1/3 Migraciones en Supabase (ref: $PROJECT_REF)"
if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "    AVISO: falta SUPABASE_ACCESS_TOKEN -> se saltan las migraciones."
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
