# Despliegue en producción — Vercel + Supabase

Estado real del stack (octubre 2026): API + UI en **Vercel**, base de datos
**Supabase (Postgres 17)**. La config alternativa Render + Neon sigue en el
repo (`render.yaml`) pero **no es la activa**.

## Arquitectura

```
[ Navegador / Teléfono bouncer ]
        │  https://ticketflow-brva4026-ux.vercel.app
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

Crea las 8 tablas, el enum `user_role`/`ticket_status`, la extensión
`pgcrypto` y las funciones transaccionales `emit_ticket`/`redeem_ticket`.

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

## Paso 3 — Endurecimiento operativo (`db/migrations/003_ops_hardening.sql`)

- `emit_ticket()` rechaza eventos `ended`/`cancelled` (antes solo `draft`) y
  valida el inventario contra la suma de `quantity` de todos los tipos.
- `set_event_status()` no abre puertas (`published→live`) si el inventario quedó
  por debajo de lo ya emitido.

```bash
node run-sql.js ../db/migrations/003_ops_hardening.sql
```

## Paso 4 — Edición y eliminación (`db/migrations/004_edit_and_delete.sql`)

Habilita que el admin edite y elimine tipos de boleta y cupos de promotor:

- `update_ticket_type()` / `update_promoter_allocation()` — edición con lock
  (`SELECT ... FOR UPDATE` sobre la misma fila que bloquea `emit_ticket`, así
  una emisión concurrente no se cuela entre el conteo y el UPDATE) y rechazo si
  la cantidad/capacidad queda por debajo de lo ya emitido.
- `delete_ticket_type()` / `delete_promoter_allocation()` — borra la fila si no
  tiene boletas; si tiene historial, la archiva.
- Trigger `trg_tickets_check_active_refs` — un tipo/cupo archivado
  (`is_active = FALSE`) no acepta boletas nuevas. Sin él, las columnas
  `is_active` existían desde el esquema inicial pero **ningún** camino las
  miraba, así que archivar no tenía efecto real.

```bash
node run-sql.js ../db/migrations/004_edit_and_delete.sql
```

## Paso 5 — Datos demo (`scripts/seed_prod.sql`)

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
('void_ticket','set_event_status','redeem_ticket','emit_ticket',\
 'update_ticket_type','update_promoter_allocation',\
 'delete_ticket_type','delete_promoter_allocation') ORDER BY 1;" > check.sql
node run-sql.js check.sql   #  -> las 8 funciones
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
.local/pgsql/bin/psql.exe -h 127.0.0.1 -U postgres -d ticketflow -f db/migrations/003_ops_hardening.sql
.local/pgsql/bin/psql.exe -h 127.0.0.1 -U postgres -d ticketflow -f db/migrations/004_edit_and_delete.sql
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
   (`api/requirements.txt` tiene las dependencias, incluidas `qrcode`,
   `Pillow` y `tzdata` que usa la boleta-imagen del endpoint público)

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
curl -s https://ticketflow-brva4026-ux.vercel.app/api/health
#  -> {"status":"ok","app":"TicketFlow API"}

curl -s -X POST https://ticketflow-brva4026-ux.vercel.app/api/auth/login \
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
