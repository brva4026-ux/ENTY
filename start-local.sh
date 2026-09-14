#!/usr/bin/env bash
# Levanta TicketFlow en local SIN Docker (entorno Windows/Git Bash).
# Uso:  bash start-local.sh
set -e
cd "$(dirname "$0")"

# 1. Postgres portable
PG=".local/pgsql/bin"
if ! "$PG/pg_isready.exe" -h 127.0.0.1 -p 5432 -q; then
  echo "[*] Arrancando PostgreSQL..."
  ("$PG/pg_ctl.exe" -D .local/pgdata -l .local/pg.log -o "-p 5432" start >/dev/null 2>&1 || true)
  sleep 3
fi
"$PG/pg_isready.exe" -h 127.0.0.1 -p 5432

# 2. Backend (uvicorn, puerto 8001 via run.py)
if ! netstat -ano | grep -q '":8001.*LISTENING\|:8001 .*LISTENING'; then
  echo "[*] Arrancando backend en :8001..."
  (cd backend && API_PORT=8001 nohup ./.venv/Scripts/python.exe run.py > uvicorn.log 2>&1 & disown)
  sleep 6
else
  echo "[ok] Backend ya escucha en :8001"
fi

# 3. Frontend (vite dev, puerto 12000, proxy /api -> :8001)
if ! netstat -ano | grep -q ':12000 .*LISTENING'; then
  echo "[*] Arrancando frontend en :12000..."
  (cd frontend && VITE_BACKEND_URL=http://127.0.0.1:8001 nohup npm run dev > vite.log 2>&1 & disown)
  sleep 8
else
  echo "[ok] Frontend ya escucha en :12000"
fi

echo ""
echo "=================================================="
echo " TicketFlow listo:"
echo "   UI       -> http://localhost:12000"
echo "   API docs -> http://127.0.0.1:8001/docs"
echo ""
echo " Usuarios demo (password: demo1234):"
echo "   admin@bar.test    (admin)"
echo "   promo1@bar.test   (promotor, 5 cortesias)"
echo "   puerta@bar.test   (bouncer)"
echo "=================================================="
