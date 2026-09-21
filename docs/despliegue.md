# Despliegue en producción — Vercel + Supabase

Estado real del stack (octubre 2026): API + UI en **Vercel**, base de datos
**Supabase (Postgres 17)**. La config alternativa Render + Neon sigue en el
repo (`render.yaml`) pero **no es la activa**.

## Arquitectura

```
[ Navegador / Teléfono bouncer ]
        │  https://ticketflow-brva4026-uxs-projects.vercel.app
        ▼
[ Vercel: proyecto ticketflow ]
        ├─ UI estática (build Vite de frontend/)
        └─ /api/* → función serverless Python (api/index.py, FastAPI)
                    │  DATABASE_URL (pooler :6543, sslmode=require)
                    ▼
        [ Supabase Postgres — ref wjknwlrcacalilfrfqyq ]
```

- La función serverless usa el **pooler de Supabase (puerto 6543)**: compatible
  IPv4 y PgBouncer en modo transaction. Por eso el pool psycopg lleva
  `prepare_threshold=0` (ver `backend/app/core/db.py`).
- `JWT_SECRET` vive en las env vars de Vercel (3 entornos).
- La UI habla con `/api` del mismo dominio (sin CORS en producción).

## Variables de entorno (Vercel)

| Variable | Valor |
|---|---|
| `DATABASE_URL` | `postgresql://postgres.<ref>:<pass>@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require` |
| `JWT_SECRET` | secreto de 64+ caracteres (ya generado) |

---

# Reconstrucción de la base de datos

Toda la base es **reproducible desde el repo** con 3 archivos SQL en orden.
No hay pasos manuales en el dashboard de Supabase: todo se ejecuta por la
API SQL de Supabase con `scripts/run-sql.js`.

## Prerrequisitos

- **Node** (para `scripts/run-sql.js`)
- **Supabase access token**: supabase.com/dashboard/account/tokens → `sbp_...`
- **Project ref**: dashboard de Supabase → Settings → General → Reference ID
  (el de producción: `wjknwlrcacalilfrfqyq`)

## Paso 1 — Esquema base (`db/schema.sql`)

**Desde sep-2026 el `schema.sql` es el ESQUEMA COMPLETO consolidado** (19
tablas, enums, extension pgcrypto y las 24 funciones de negocio con sus
triggers). Lo genera `pg_dump --schema-only` sobre una base a la que se le
aplicaron schema+migraciones; el test `backend/tests/test_schema_drift.py`
falla si alguien agrega una migración sin consolidarla. Aplicarlo es
idempotente y suficiente: las migraciones de `db/migrations/` quedan como
no-ops encima (todas son IF NOT EXISTS / OR REPLACE).

Crea las 19 tablas, el enum `user_role`/`ticket_status`, la extensión
`pgcrypto` y las funciones transaccionales `emit_ticket`/`redeem_ticket`
(entre otras 22).

```bash
export SUPABASE_ACCESS_TOKEN="sbp_..."
export SUPABASE_PROJECT_REF="wjknwlrcacalilfrfqyq"
cd scripts && node run-sql.js ../db/schema.sql
```

## Paso 2 — Migración de ciclo de vida (`db/migrations/002_lifecycle.sql`)

Agrega lo que el MVP no traía (idempotente, safe re-run):

- `void_ticket()` — anula boletas y libera cupo al instante
- `set_event_status()` — transiciones válidas `draft→published→live→ended`,
  `draft/published→cancelled`
- `redeem_ticket()` corregida: audita escaneos `NOT_FOUND` con
  `redemptions.ticket_id` nullable (antes un QR desconocido no dejaba rastro)

```bash
node run-sql.js ../db/migrations/002_lifecycle.sql
```

## Paso 2b — Endurecimiento y recuperación de boletas

Migraciones posteriores, ambas idempotentes:

- `db/migrations/003_ops_hardening.sql` — validaciones de emisión (estado del
  evento, inventario unificado contra aforo).
- `db/migrations/004_ticket_reissue.sql` — **recuperación de boletas**:
  `reissue_ticket()` rota el token de una boleta viva (el QR viejo muere) y la
  tabla `ticket_reissues` deja auditoría de la rotación.

**Sin la 004 el endpoint `POST .../tickets/{id}/reissue` devuelve 500**: la
función no existe. Aplicala antes de desplegar el código que la usa.

```bash
node run-sql.js ../db/migrations/003_ops_hardening.sql
node run-sql.js ../db/migrations/004_ticket_reissue.sql
```

## Paso 3 — Datos demo (`scripts/seed_prod.sql`)

Equivalente a `POST /seed` pero **seguro para producción**: usa hashes bcrypt
reales (no abre el endpoint de seed) y es **idempotente** — se puede re-ejecutar
sin duplicar datos.

Crea:

| Recurso | Detalle |
|---|---|
| Venue | `Bar Esquina` (slug `bar-esquina`) |
| Usuarios | `admin@bar.test`, `promo1@bar.test`, `promo2@bar.test`, `puerta@bar.test` — todos con password `demo1234` |
| Roles | admin / promotor ×2 / bouncer sobre la venue |
| Evento | `Noche Electronica` — capacity 120, estado **published** (visible para promotores, listo para "Abrir puertas") |
| Tipos | `Cortesia` (gratis, qty 50) y `General` ($30.000, qty 60) |
| Cupos | Promo Uno 5, Promo Dos 3 (tipo Cortesia) |

```bash
node run-sql.js seed_prod.sql
```

> ⚠️ Para una venue **real**, no reuses estos usuarios: crea los usuarios con
> contraseñas nuevas y cámbiales los hashes (bcrypt cost 12), o créalos desde
> la UI una vez exista onboarding.

## Verificación post-reconstrucción

```bash
# dentro de scripts/, con las env vars exportadas
echo "SELECT (SELECT count(*) FROM users) usuarios, (SELECT count(*) FROM venues) venues, \
(SELECT count(*) FROM events) eventos, (SELECT count(*) FROM ticket_types) tipos, \
(SELECT count(*) FROM promoter_allocations) cupos;" > check.sql
node run-sql.js check.sql

echo "SELECT name, status FROM events;" > check.sql && node run-sql.js check.sql
#  -> [{"name":"Noche Electronica","status":"published"}]

echo "SELECT proname FROM pg_proc WHERE proname IN \
('void_ticket','set_event_status','redeem_ticket') ORDER BY 1;" > check.sql
node run-sql.js check.sql   #  -> las 3 funciones
```

Valores esperados: `4 usuarios, 1 venue, 1 evento, 2 tipos, 2 cupos`.

## Notas sobre `scripts/run-sql.js`

- Lee un `.sql`, **elimina meta-comandos de psql** (líneas que empiezan con
  `\`) y envía el resto como `{ query }` al endpoint SQL de Supabase
  (`/v1/projects/{ref}/database/query`).
- Requiere `SUPABASE_ACCESS_TOKEN` y `SUPABASE_PROJECT_REF` en el entorno.
- Un lote = una transacción implícita: si algo falla, no queda aplicado a medias.

## Alternativa: psql directo

Si prefieres psql (útil en local con el Postgres portable de `.local/pgsql/`):

```bash
psql "postgresql://postgres:<pass>@db.<ref>.supabase.co:5432/postgres" \
  -v ON_ERROR_STOP=1 -f db/schema.sql
psql "..." -f db/migrations/002_lifecycle.sql
psql "..." -f db/migrations/003_ops_hardening.sql
psql "..." -f db/migrations/004_ticket_reissue.sql
psql "..." -f scripts/seed_prod.sql
```

(Con el pooler `:6543` NO uses psql para migrar: usa la conexión directa
`:5432` o el endpoint SQL, porque PgBouncer en modo transaction no soporta
bien sesiones largas de psql.)

## Reconstruir la base local de desarrollo

La DB local (Postgres portable en `.local/pgsql/`, DB `ticketflow`) usa los
mismos archivos, más el seed original de desarrollo:

```bash
.local/pgsql/bin/psql.exe -h 127.0.0.1 -U postgres -d ticketflow -f db/schema.sql
.local/pgsql/bin/psql.exe -h 127.0.0.1 -U postgres -d ticketflow -f db/migrations/002_lifecycle.sql
cd backend && ./.venv/Scripts/python.exe -m app.routers.seed   # o POST /seed con IS_DEMO=true
```

---

# Deploy de la aplicación (Vercel)

## CLI

```bash
npx vercel --prod --yes --token <VERCEL_TOKEN>
```

El proyecto ya está linkeado (`.vercel/project.json`). El build:

1. Frontend: `npm run build` en `frontend/` → estáticos servidos por Vercel
2. Backend: `api/index.py` envuelve `backend/app/main.py` como serverless
   (`api/requirements.txt` tiene las dependencias; **excluye** Pillow/qrcode
   a propósito — `ticket_image.py` aún no está cableado)

## ⚠️ Requisito: cuenta Vercel verificada

Las cuentas nuevas **sin verificar** rechazan todo deploy con
`seatBlock: TEAM_ACCESS_REQUIRED` y los deploys quedan `BLOCKED` (ni siquiera
sirven el 404 — la URL muere). Se arregla **solo desde el dashboard**:

1. vercel.com/dashboard → banner **"Verify your account"** → email + teléfono/SMS
2. **Firewall → Attack Challenge Mode → Disable** (si no, todos los visitantes
   reciben el checkpoint 403 — incluida la cámara del bouncer)

No existe endpoint de API para desactivar el bloqueo: es un clic del dueño
de la cuenta.

## Checklist post-deploy

```bash
curl -s https://ticketflow-brva4026-uxs-projects.vercel.app/api/health
#  -> {"status":"ok","app":"TicketFlow API"}

curl -s -X POST https://ticketflow-brva4026-uxs-projects.vercel.app/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@bar.test","password":"demo1234"}'
#  -> 200 con access_token

# Ciclo de vida (con el token de admin):
#   POST /api/venues/{vid}/events/{eid}/publish → 200
#   POST .../live → 200 ;  repetir live tras end → 409
#   POST /api/venues/{vid}/events/{eid}/tickets/{tid}/void {"reason":"..."} → 200
```

## Operaciones

- **Redeploy**: `npx vercel --prod` o push a `master` (si hay Git integration)
- **Logs**: vercel.com/dashboard → proyecto → Deployments → Functions
- **Reset de datos demo**: re-ejecutar `scripts/seed_prod.sql` (idempotente);
  para borrar boletas: `UPDATE tickets SET status='voided' WHERE event_id=...`
  o truncate manual desde el SQL Editor de Supabase
- **Backups**: Supabase free no incluye PITR — export semanal recomendado:
  `pg_dump` con la conexión directa `:5432`
