# Despliegue en producción (gratis) — Render + Neon

Estado: configuración lista en el repo. Solo necesitas crear 2 cuentas y pegar 1 URL.

## Arquitectura

```
[ Navegador / Teléfono bouncer ]
        │  https://ticketflow-ui.onrender.com
        ▼
[ Render: ticketflow-ui ]   (node server.mjs: sirve dist + proxy /api)
        │  /api/* → https://ticketflow-api.onrender.com
        ▼
[ Render: ticketflow-api ]  (Docker FastAPI, healthcheck /health)
        │  DATABASE_URL (sslmode=require)
        ▼
[ Neon Postgres ]           (esquema db/schema.sql ya aplicado)
```

## Paso 1 — Crear la base de datos (Neon, gratis)

1. Entra a https://neon.com y crea cuenta (con GitHub o Google).
2. Crea un proyecto: nombre `ticketflow`, región cercana a tus usuarios
   (p.ej. `aws us-east-1` o `aws eu-west-1`).
3. Copia el **connection string** (botón *Connect*, formato:
   `postgresql://usuario:password@ep-xxxx.aws.neon.tech/neondb?sslmode=require`).
4. **Pega esa URL a tu agente** — aplicará `db/schema.sql` por ti,
   o hazlo tú: `psql "<connection_string>" -f db/schema.sql`.

> El plan free de Neon no caduca y el proyecto se pausa solo tras 5 min de
> inactividad; el primer query tras la pausa tarda ~500 ms extra. OK para el piloto.

## Paso 2 — Desplegar en Render (gratis)

1. Haz push de este repo a GitHub (si no lo está ya).
2. Entra a https://render.com con GitHub y acepta los permisos del repo.
3. Dashboard → **New +** → **Blueprint** → selecciona el repo `ticketflow`.
   Render detecta `render.yaml` y creará 2 servicios:
   - `ticketflow-api` (Docker backend)
   - `ticketflow-ui` (Docker frontend con proxy /api)
4. Antes de aplicar, te pedirá el valor de `DATABASE_URL` (sync:false):
   **pega la URL de Neon del Paso 1**.
   `JWT_SECRET` se genera automáticamente.
5. Crea los servicios y espera el primer deploy (~5-10 min).

## Paso 3 — Verificación

1. API: abre `https://ticketflow-api.onrender.com/health` → `{"status":"ok"}`
2. UI: abre `https://ticketflow-ui.onrender.com` → pantalla de login
3. Crea datos demo (una sola vez):
   ```bash
   curl -X POST https://ticketflow-api.onrender.com/seed
   ```
4. Login con `admin@bar.test` / `demo1234`.

> ⚠️ El `/seed` es idempotente y solo crea datos demo. Para datos reales
> créalos desde la UI de admin.

## Paso 4 — Dominio propio (opcional pero recomendado)

La cámara del bouncer **exige HTTPS**; `*.onrender.com` ya lo trae, así que
funciona desde el día 1. Con dominio propio: Render → ticketflow-ui → Settings
→ Custom Domains, y añade el CNAME que te indique.

## Limitaciones del plan free (asumidas para el piloto)

| Tema | Comportamiento | Mitigación |
|---|---|---|
| Render free duerme tras 15 min sin tráfico | Primer arranque ~50 s | Abrir la UI 2 min antes de la puerta; o Upgrade $7/mes |
| Neon pausa tras 5 min | +500 ms en el primer query | Imperceptible tras calentar |
| 750 h/mes Render free | Suficiente para 1 API + 1 UI | — |

## Costes al pasar a producción seria

- Render Starter: $7/servicio/mes × 2 = $14/mes (sin sleep)
- Neon Launch: $19/mes (ramas, más cómputo) o seguir free
- Dominio: ~$12/año

## Rollback / operaciones

- Redeploy: Render → servicio → **Manual Deploy** → *Deploy latest commit*
- Logs: Render → servicio → **Logs** (en vivo)
- Borrar demo y reiniciar: psql a Neon con los DELETE de `db/tests/` o recrear el branch
