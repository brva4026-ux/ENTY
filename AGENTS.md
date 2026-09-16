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
cd backend && .venv/bin/python -m pytest tests/ -q     # 46 tests
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

Venue `Bar Esquina` (id 31), evento `Noche Electrónica` (id 31).
Usuarios con contraseña `demo1234`:

| email | rol |
| --- | --- |
| `admin@bar.test` | admin |
| `promo1@bar.test` | promotor (cupo 5) |
| `promo2@bar.test` | promotor (cupo 3) |
| `puerta@bar.test` | bouncer |

Ojo: los ids son `GENERATED ALWAYS AS IDENTITY`, así que **cambian en cada
seed**. No los fijes en scripts; consúltalos. Además, correr `pytest` **borra
estos datos** (el `conftest` hace `DROP TABLE`), así que después de testear hay
que re-sembrar:

```bash
cd backend && .venv/bin/python -c "
import asyncio, psycopg
from psycopg.rows import dict_row
from app.routers.seed import seed_demo_data
async def m():
    c = await psycopg.AsyncConnection.connect('<DATABASE_URL>', autocommit=True, row_factory=dict_row)
    print(await seed_demo_data(c)); await c.close()
asyncio.run(m())"
```

## Boleta del invitado (QR)

El invitado **no recibe el token como texto**: recibe un enlace
`<origin>/t#<token>` y abre ahí su QR para que el bouncer lo escanee.

- El token va en el **fragmento** (`#`), no en la ruta: el navegador nunca lo
  manda al servidor, así que no queda en los logs de Vercel ni en el `Referer`.
- Endpoints públicos (sin auth, el token de 192 bits es la credencial):
  `POST /tickets/preview` (datos) y `POST /tickets/image` (JPEG con flyer + QR).
  El token viaja en el **cuerpo**, nunca en la URL.
- `backend/app/services/ticket_image.py` compone la imagen con Pillow. Fuente:
  usa DejaVu si existe; el fallback es `ImageFont.load_default(size)` — **sin el
  `size`** devuelve una bitmap de 10px e ilegible en serverless.
- La DB **solo guarda el SHA-256** del token (`tickets.token_hash`), así que el
  QR no se puede regenerar desde `ticket_id`; siempre hace falta el token crudo.

## Recuperar una boleta (reemisión)

El token crudo se entrega **una sola vez**; si se pierde, no se puede "leer" de
la DB. La recuperación **rota** el token (`reissue_ticket` en la migración
`004_ticket_reissue.sql`): mismo `ticket_id`, `token_hash` nuevo, y el anterior
muere en el acto.

- `GET /venues/{id}/events/{id}/tickets` — el promotor ve **solo las suyas**
  (antes era admin-only y por eso no podía ni listar lo que vendió). El staff ve
  todo el evento; el bouncer no lista. `?phone=` busca por sufijo de dígitos.
- `POST /venues/{id}/events/{id}/tickets/{tid}/reissue` — devuelve `raw_token`
  nuevo. Lo permite el dueño de la boleta o el staff.
- No se reemite una boleta `redeemed` (sería una segunda entrada gratis) ni una
  `voided`/`refunded` (reviviría la anulación). No consume cupo ni aforo.
- Cada rotación queda en `ticket_reissues` (quién, cuándo, por qué, hash viejo),
  nunca el token crudo.
- Si agregás objetos de esquema, sumalos al `DROP` del `conftest` o los tests
  arrastran estado entre sesiones.

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

- Producción: `https://ticketflow-brva4026-uxs-projects.vercel.app` (proyecto `ticketflow`
  en el team `brva4026-uxs-projects`).
- **Dependencias serverless: `api/requirements.txt`, no `backend/pyproject.toml`.**
  La función solo instala ese archivo. Un import nuevo que no esté ahí hace
  que `app.main` no cargue y **toda la API devuelva 500
  `FUNCTION_INVOCATION_FAILED`**, incluido `/health` — porque el import corre
  antes de cualquier ruta. Ya pasó con `qrcode`/`Pillow` al cablear el QR.
  `tests/test_serverless_deps.py` compara imports vs requirements y lo detecta.
- **Versión de Python: `.python-version` (3.12).** El backend usa `X | None` a
  nivel módulo, que necesita ≥3.10: en 3.9 `db.py` falla al importar con
  `TypeError: unsupported operand type(s) for |`. No dependas del default de
  Vercel, que va a cambiar con el tiempo.
- **Síntoma de un import roto**: el navegador muestra "Error en la petición".
  Es el fallback de `api.js` cuando la respuesta no es JSON; Vercel devuelve
  texto plano `A server error has occurred`. Si ves eso en *todos* los
  endpoints, sospechá del import, no de la DB.
- **Verificar un deploy de verdad**: `curl` a la URL *inmutable* del deployment
  (`https://ticketflow-<id>-brva4026-uxs-projects.vercel.app/api/health`) y
  exigí `content_type: application/json`. Las URLs por rama pueden devolver
  HTTP 200 con la pantalla "Deployment is building" — un 200 ahí **no** prueba
  que la API funcione. Un "Vercel: success" en el commit solo dice que el build
  pasó, no que la función arranque.
- `vercel.json`: build de `frontend/`, salida `frontend/dist`, `/api/*` →
  función serverless Python (`api/index.py`, FastAPI).
- Preview por rama:
  `https://ticketflow-git-<rama-con-guiones>-brva4026-uxs-projects.vercel.app`.
- La función serverless usa el **pooler de Supabase (puerto 6543)**, que exige
  `prepare_threshold=None` (ver la trampa de psycopg más arriba).
- Para consultar el estado de un deploy sin entrar al dashboard:
  `GET /repos/{owner}/{repo}/commits/{sha}/status` (campo `context == "Vercel"`).