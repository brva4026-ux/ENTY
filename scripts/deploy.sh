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

# NOTA: la lista DEBE acompanar las migraciones nuevas (todas idempotentes,
# safe re-run); si se deja desfasada, un cambio de esquema despliega codigo
# que usa objetos que la base todavia no tiene (500 en rutas nuevas).
# backend/tests/test_deploy_migrations.py falla si esta lista no coincide con
# db/migrations/*.sql, asi que el desfase se ve en CI y no en produccion.
PROJECT_REF="${SUPABASE_PROJECT_REF:-wjknwlrcacalilfrfqyq}"
MIGRATIONS=(
  db/migrations/002_lifecycle.sql
  db/migrations/003_ops_hardening.sql
  db/migrations/004_edit_and_delete.sql
  db/migrations/004_ticket_reissue.sql
  db/migrations/005_event_edit_and_cancel.sql
  db/migrations/006_redeem_event_guard.sql
  db/migrations/007_push_subscriptions.sql
  db/migrations/008_redeem_type_filter.sql
  db/migrations/009_team_stats.sql
  db/migrations/010_promoter_payouts.sql
  db/migrations/011_staff_invitations.sql
  db/migrations/012_in_app_notifications.sql
  db/migrations/013_qr_activation.sql
  db/migrations/014_push_outbox_and_location.sql
  db/migrations/015_ticket_contact_audit.sql
  db/migrations/016_login_lockout.sql
  db/migrations/017_password_reset.sql
  db/migrations/018_media.sql
  db/migrations/019_security_p0.sql
  db/migrations/020_auto_close_events.sql
  db/migrations/021_ticket_return.sql
  db/migrations/022_event_waitlist.sql
  db/migrations/023_ticket_payments.sql
  db/migrations/024_notify_autoclose_kind.sql
  db/migrations/025_event_staff.sql
  db/migrations/026_door_anomaly_alert.sql
  db/migrations/027_door_anomaly_event_link.sql
  db/migrations/028_legal_acceptances.sql
  db/migrations/029_legal_documents_v11.sql
  db/migrations/030_legal_plazos.sql
  db/migrations/031_analytics_events.sql
  db/migrations/032_user_preferences.sql
  db/migrations/033_inventory_per_type.sql
  db/migrations/034_door_grace_and_sync_truth.sql
    db/migrations/035_username.sql
    db/migrations/036_venue_contact.sql
    db/migrations/037_password_changed_at.sql
    db/migrations/038_avatar.sql
    db/migrations/039_preference_key_shape.sql
    db/migrations/040_active_venue.sql
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
