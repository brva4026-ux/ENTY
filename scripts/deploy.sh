#!/usr/bin/env bash
# Deploy de TicketFlow a produccion (Supabase + Vercel) en un solo comando.
#
# El ORDEN importa: la migracion 004 crea las funciones que usan los endpoints
# de editar/eliminar tipos de boleta y cupos de promotor. Si se despliega sin
# migrar, esos botones del panel devuelven 500 ("function ... does not exist").
#
# Uso:
#   npx vercel login                            # una sola vez
#   export SUPABASE_ACCESS_TOKEN=sbp_...        # https://supabase.com/dashboard/account/tokens
#   bash scripts/deploy.sh
#
# La migracion es idempotente (safe re-run): se puede correr las veces que haga
# falta sin duplicar nada.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_REF="${SUPABASE_PROJECT_REF:-wjknwlrcacalilfrfqyq}"
MIGRATIONS=(
  db/migrations/003_ops_hardening.sql
  db/migrations/004_edit_and_delete.sql
)

echo "==> 1/3 Migraciones en Supabase (ref: $PROJECT_REF)"
if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "    AVISO: falta SUPABASE_ACCESS_TOKEN -> se saltan las migraciones."
  echo "    OJO: sin la 004, editar/eliminar tipos y cupos fallara en produccion."
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
