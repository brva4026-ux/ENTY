# AGENTS.md — TicketFlow

Boletería, control de puerta y reporte en vivo para bares/venues.
FastAPI + React (Vite) + PostgreSQL, con lógica transaccional en la DB.

## Estructura

- `backend/` — FastAPI. Routers en `app/routers/`, esquema SQL en `app/core/`.
- `frontend/` — React + Vite + Tailwind. Páginas en `src/pages/`.
- `docs/` — arquitectura, flujos, despliegue, backlog.

## Cómo correr en local

```bash
# Backend (usa run.py, NO `uvicorn app.main:app` directo)
cd backend && .venv/bin/python run.py        # http://127.0.0.1:8001

# Frontend
cd frontend && npm run dev                    # puerto 12000 en este entorno
```

`run.py` existe porque psycopg async necesita `SelectorEventLoop` en Windows y
el puerto es configurable con `API_PORT`.

## Tests

```bash
cd backend && .venv/bin/python -m pytest tests/ -q     # 23 tests
cd frontend && npm run build                            # verificacion de build
```

## Convenciones

- **Idioma**: identificadores y comentarios en español, sin tildes en el código.
- **Lógica de negocio en SQL**: `emit_ticket` / `redeem_ticket` son funciones de
  la DB; los routers solo traducen parámetros y errores SQL a HTTP.
- **Errores de negocio**: la DB los señala con `message_primary` (p. ej.
  `promoter_quota_exceeded`); `tickets.py::_handle` los mapea a HTTP.

## Trampas conocidas

- **`prepare_threshold`**: en psycopg3, `None` desactiva los prepared
  statements y `0` los prepara en el **primer** uso. Debe ser `None` detrás de
  un pooler en modo transaction (Supabase `:6543`, pgBouncer), o `redeem`
  falla con `cached plan must not change result type` (HTTP 500).
  Hay dos sitios en `app/core/db.py`: `_CONNECT_KWARGS` e `init_pool`.
- **Seed**: `POST /seed` solo responde si `IS_DEMO=true`. Borra y recrea los
  datos demo; no hay endpoint de borrado.
- **Tokens de QR**: en la DB solo se guarda el SHA-256 del token crudo. El
  token crudo es lo único que sirve para redimir.

## Datos demo

Venue `Bar Esquina` (id 25), evento `Noche Electrónica` (id 25).
Usuarios con contraseña `demo1234`:

| email | rol |
| --- | --- |
| `admin@bar.test` | admin |
| `promo1@bar.test` | promotor (cupo 5) |
| `promo2@bar.test` | promotor (cupo 3) |
| `puerta@bar.test` | bouncer |

## Git / GitHub

- El `GITHUB_TOKEN` del entorno **no** ve este repo privado (la API devuelve
  404). El PAT del remote en `.git/config` sí funciona; para llamar la API:
  `PAT=$(git remote get-url origin | sed -E 's|https://[^:]+:([^@]+)@.*|\1|')`.
- **Autor de los commits = Vercel**: el plan Hobby de Vercel bloquea el deploy
  si el autor del commit no tiene acceso al proyecto. En la práctica Vercel
  compara el **email del autor** contra las cuentas con acceso. Si el email no
  coincide, el check falla con:

  > `Deployment was blocked` / `Git author openhands-agent must have access to the project`

  Emails que **sí** despliegan aquí:

  | Email | Resultado |
  | --- | --- |
  | `brva4026@gmail.com` | ✅ deploya |
  | `vargasblancobrayan@gmail.com` | ✅ deploya |
  | `openhands@all-hands.dev` | ❌ **bloqueado** |

  Por eso el repo tiene `git config user.email brva4026@gmail.com`. **No**
  commitear como `openhands` (el default del entorno), o el deploy se bloquea.
  Si ya hay commits con el autor equivocado, reescribir solo los autores:

  ```bash
  git branch backup/<rama> <rama>          # respaldo antes de reescribir
  FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --env-filter '
  export GIT_AUTHOR_NAME="brva4026-ux"
  export GIT_AUTHOR_EMAIL="brva4026@gmail.com"
  export GIT_COMMITTER_NAME="brva4026-ux"
  export GIT_COMMITTER_EMAIL="brva4026@gmail.com"
  ' <base>..HEAD
  git push --force-with-lease origin <rama>
  ```

  Verificar el resultado: `git diff backup/<rama> <rama>` debe salir vacío
  (solo cambian autores, no contenido).
- **Seguridad**: el remote guarda el PAT en texto plano en `.git/config`.
  Conviene rotarlo y migrar a un credential helper.

## Despliegue (Vercel)

- Producción: `https://ticketflow-brva4026-ux.vercel.app` (proyecto `ticketflow`
  en el team `brva4026-uxs-projects`).
- `vercel.json`: build de `frontend/`, salida `frontend/dist`, `/api/*` →
  función serverless Python (`api/index.py`, FastAPI).
- Preview por rama:
  `https://ticketflow-git-<rama-con-guiones>-brva4026-uxs-projects.vercel.app`.
- La función serverless usa el **pooler de Supabase (puerto 6543)**, que exige
  `prepare_threshold=None` (ver la trampa de psycopg más arriba).
- Para consultar el estado de un deploy sin entrar al dashboard:
  `GET /repos/{owner}/{repo}/commits/{sha}/status` (campo `context == "Vercel"`).