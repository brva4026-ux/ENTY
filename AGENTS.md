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
cd backend && .venv/bin/python -m pytest tests/ -q     # ~283 tests
cd frontend && npm run build                            # verificacion de build
```

Los tests que tocan la DB necesitan `TEST_DATABASE_URL` (o Postgres local en
el default `postgres:devpassword@127.0.0.1:5432/ticketflow`); sin DB se
saltan silenciosamente (un "verde" local puede ser solo la parte sin DB —
en CI el service container de Postgres los corre todos).

`tests/test_schema_drift.py` es el guardián del esquema: si agregás una
migración con objetos nuevos, consolidala también en `db/schema.sql`
(aplicá schema+migraciones sobre una base limpia, `pg_dump --schema-only`
y reemplazá el archivo) o el test falla.

## Convenciones

- **Idioma**: identificadores y comentarios en español, sin tildes en el código.
- **Lógica de negocio en SQL**: `emit_ticket` / `redeem_ticket` son funciones de
  la DB; los routers solo traducen parámetros y errores SQL a HTTP.
- **Errores de negocio**: la DB los señala con `message_primary` (p. ej.
  `promoter_quota_exceeded`); `tickets.py::_handle` los mapea a HTTP.
- **Comisión vs. recaudo**: `emit_ticket` **rechaza** atar una boleta de pago a
  un cupo de promotor, así que en el MVP el promotor solo mueve cortesías
  (`price_cents_snapshot = 0`). Por eso `commissions_cents` del overview es
  `null` (no `0`) cuando no hay liquidaciones: "no hay comisión calculable" ≠
  "la comisión fue 0". La UI decide con ese `null` si muestra el neto o el
  recaudado; no inventes una resta sobre `0`.
- **Mes del panel en la URL**: la portada (`VenueHeader`) y Reportes
  (`BusinessOverview`) leen y escriben el mes en `/admin?mes=YYYY-MM`. Es un
  único dueño (el switcher de la portada); `BusinessOverview` es controlado y
  no tiene estado de mes propio. Ausencia del param = mes en curso.

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

**Fan de prueba** (sin cuenta): `fan@bar.test` / `3100000001`. El seed le emite
dos cortesías: una al evento `Noche Electrónica` (en +7 días → QR **inactivo**,
para ver el aviso de espera) y otra al evento `Prueba de QR` (en +20 min → QR
**activo** y escaneable). En `/boletas` basta con escribir ese correo o
teléfono. El seed es idempotente: `events` no tiene UNIQUE(venue_id, name), así
que busca antes de insertar (no confíes en `ON CONFLICT` ahí).

Ojo: los ids son `GENERATED ALWAYS AS IDENTITY`, así que **cambian en cada
seed**. No los fijes en scripts; consúltalos. Además, correr `pytest` **borra
estos datos** (el `conftest` hace `DROP TABLE`), así que después de testear hay
que re-sembrar. La DB local de desarrollo se levanta con el Postgres portable
(`.local/pgsql/`, ver `docs/despliegue.md`) y los tests pueden apuntar a una
base desechable del mismo servidor con `TEST_DATABASE_URL`.

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

## App del fan (Enty)

El fan **no tiene cuenta**: su correo o teléfono ES la identidad. Las pantallas
públicas viven bajo `.home` (shell nocturno: negro + violeta, Sora 300) y se
fuerzan oscuras con `forceDarkOnce()` — son de marca, no siguen el tema del SO.

- `/inicio` — vitrina pública (`HomePage`): catálogo de `/public/events`.
- `/boletas` — la entrada del fan (`MyTicketsPage`): escribe su contacto y ve
  sus boletas. "Ver mi QR" regenera el enlace de esa boleta.
- `GET /public/events` — catálogo (sin auth; eventos publicados y futuros).
- `POST /public/my-tickets` — boletas por contacto. **Nunca** devuelve tokens:
  el listado solo trae datos de la boleta + `has_link`.
- `POST /public/my-tickets/{id}/token` — "magic link": comprueba que el
  contacto es dueño de la boleta y **rota** el token con `reissue_ticket`
  (auditado en `ticket_reissues`). Devuelve el `raw_token` una sola vez.
- Normalización del contacto (`_contact_params` en `routers/public.py`): el
  correo solo se recorta y baja a minúsculas (sus puntos son significativos);
  el teléfono se reduce a dígitos (`+57 300 123 4567` == `573001234567`). La
  comparación usa un flag `is_email` en SQL — **no** mandes un centinela NUL
  como parámetro: psycopg/Postgres lo rechaza (`text fields cannot contain NUL`).
- El token nuevo vive en `localStorage` (`tf_fan_contact` guarda el contacto,
  no el token): el QR se dibuja local con `qrcode`, igual que en `/t`.
- La barra inferior (Inicio · Explorar · Boletos · Perfil) es
  `components/FanNav.jsx`; la comparten Inicio y Mis boletas.
- Tests: `tests/test_public_my_tickets.py`. Usá teléfonos/correos **únicos por
  test** (`uuid`): la suite siembra números fijos como `573001234567` y
  `3001234567` que colisionarían con una búsqueda por dígitos.

## App interna (Enty): Admin · Promotor · Puerta

El interior NO comparte el shell del fan: esas pantallas viven bajo
`.app-shell` (Layout, BouncerScanner, DoorLinkPage). La capa de marca está al
final de `frontend/src/aesthetic-refresh.css`, scopeada a `.app-shell`, así que
la vitrina del fan (`.home`) y la boleta pública no se tocan.

- **Regla al agregar una pantalla interna**: ponele `app-shell` al root o no
  recibe el encuadre nocturno, las superficies de cristal ni la tinta de marca.
- La paleta interna es violeta `#7C3AED` (marca) / `#BB5CF6` (brillo), verde
  `#00E6AB` y rosa `#FF2D98`. **No** reintroducir naranja/ámbar de la marca
  anterior (`rgba(251,146,60,…)`, `#9a3412`) ni lima (`#7cff00`, `#f0f542`).
- La tinta casi blanca (`--in-ink`) se aplica **solo en oscuro**
  (`html:not([data-theme="light"]) .app-shell`): en claro hereda el color de
  `body`, o quedaría texto blanco sobre blanco.
- Verificación: contraste de texto ≥ 4.5:1 y `scrollWidth == clientWidth` en
  ambos temas, en `/admin`, `/admin?event=1`, `/promotor`, `/bouncer`.

## Revisar un preview (Vercel)

El login del preview no se puede automatizar: la herramienta de navegador no
dispara el `onChange` de React en inputs controlados, así que el formulario
nunca queda válido y el submit no pasa. Para llegar a una pantalla autenticada
del preview, pedir el token por API y sembrarlo en `localStorage`:

```bash
PRE=https://ticketflow-git-<rama>-brva4026-uxs-projects.vercel.app
curl -s -X POST "$PRE/api/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"admin@bar.test","password":"demo1234"}'   # access_token (1 h)
```

Luego `localStorage.setItem("tf_token", <access_token>)` en el origen del
preview y recargar. El preview comparte la **DB de producción**, así que las
boletas que emitas ahí quedan de verdad: no lo uses para probar en serio sin
avisar.

## Git / GitHub

- El `GITHUB_TOKEN` del entorno **no** ve este repo privado (la API devuelve
  404). El PAT del remote en `.git/config` sí funciona; para llamar la API:

  ```bash
  # el remote guarda el PAT como unico userinfo, sin "usuario:pass":
  #   https://<PAT>@github.com/...
  PAT=$(git remote get-url origin | sed -E 's|https://([^@]+)@.*|\1|')
  ```

  Ojo: el `sed` con `[^:]+:` (que asumia la forma `usuario:pass@`) devuelve la
  URL entera y la API responde **401**, no 404. Si un `curl` falla con 401,
  revisá primero que el PAT se haya extraido bien antes que el token.
  `default_create_pr` no sirve acá: usa el `GITHUB_TOKEN` del entorno y da 404.
  Crear el PR con la API y el PAT del remote.
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

- **Regla del proyecto: lo que se trabaja se entrega en producción.** El valor
  está en lo desplegado, no en una rama. Un PR abierto **no** cambia la app: la
  URL de producción sirve `master`, así que mientras el PR no se mergee, el
  cambio es invisible para quien entra a `ticketflow-brva4026-uxs-projects.vercel.app`.
  Terminar el trabajo = mergear a `master` y verificar la URL de producción.
  No dar por entregado algo mostrando solo la URL del preview.
- **Revisar en el preview, entregar en producción.** El preview
  (URL por rama) es para que el usuario vea el cambio antes de mergear; si el
  usuario dice "no veo nada", confirmar **qué URL está mirando** antes de tocar
  el código. `curl` la de producción y buscá un string del cambio en el bundle:
  si no está, es que falta el merge, no que el código esté mal.

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
- **¿Llegó mi cambio al deploy?** El build es determinista: si el bundle
  desplegado pesa lo mismo y `cmp` contra `frontend/dist/assets/index-*.js` sale
  limpio, es exactamente tu build. Para un string puntual, `grep -i` — el bundle
  en minúscula puede no coincidir en mayúsculas con el fuente y dar un falso
  negativo que parece "mi cambio no está".
- `vercel.json`: build de `frontend/`, salida `frontend/dist`, `/api/*` →
  función serverless Python (`api/index.py`, FastAPI).
- Preview por rama:
  `https://ticketflow-git-<rama-con-guiones>-brva4026-uxs-projects.vercel.app`.
- La función serverless usa el **pooler de Supabase (puerto 6543)**, que exige
  `prepare_threshold=None` (ver la trampa de psycopg más arriba).
- Para consultar el estado de un deploy sin entrar al dashboard:
  `GET /repos/{owner}/{repo}/commits/{sha}/status` (campo `context == "Vercel"`).
## UI / verificación visual (app del fan)

- **Medir un `mask` con Playwright es engañoso.** El screenshot de un elemento
  (`locator.screenshot`) **compone sobre el fondo del padre**: si el padre es
  opaco, los recortes del mask no aparecen y parece que "el mask no funciona".
  Para probarlo de verdad: forzá `background:transparent` en
  `html/body/#root/.home` + `omitBackground:true` y **capturá página completa**,
  o poné un fondo de alto contraste (ej. blanco) detrás del elemento. Confirmado
  en `.fan-ticket` (bordes rasgados): el mask siempre recortó; solo era invisible
  por falta de contraste y porque el cristal al 5% no se lee sobre negro.
- **Chromium del sistema** (los browsers de Playwright no están instalados):
  `chromium.launch({ executablePath: '/usr/bin/chromium' })`. Corré el script
  desde `frontend/` (donde está `node_modules`), no desde `/tmp`.
- El sistema visual vive en `frontend/src/aesthetic-refresh.css` (tokens del fan
  en `.home`, estilos de la app del fan al final). Tokens globales en `@theme`
  de `index.css` (`--color-enty-*`, fuente `Sora`).
- El dev server sirve `frontend/dist`: **corré `npm run build`** antes de mirar
  cambios en `http://127.0.0.1:12000`.
- **E2E: correr contra el dev server, no contra el backend.** `playwright.config.js`
  toma `E2E_BASE_URL` (default `http://127.0.0.1:8001`), pero el 8001 sirve SOLO la
  API (un `GET /inicio` da 404). En CI el target es `http://127.0.0.1:12000` (dev
  server con proxy `/api`). Local:
  `E2E_BASE_URL=http://127.0.0.1:12000 npx playwright test`. Si apuntás al 8001,
  los specs de UI pasan el `test.skip` por "App no disponible" y parece que no corren.
- **Los E2E de admin/puerta necesitan el seed demo**, no los datos que deja la
  suite de pytest. `POST /seed` exige `IS_DEMO=true` en el entorno del backend;
  credenciales `admin@bar.test` / `demo1234`. Sin seed, `puerta.spec`/`portada.spec`
  fallan en el login (la DB queda con usuarios tipo `admin-<hex>@example.test`).
- **App del fan (publica, sin login):** `/inicio` (vitrina, `HomePage.jsx`),
  `/evento/:id` (detalle de compra, `EventDetailPage.jsx`), `/t` (boleto),
  `/boletas` (mis boletas por contacto). Backend: `GET /public/events` (catalogo)
  y `GET /public/events/{id}` (detalle; 404 si borrador/pasado/inexistente).
- **Categorias:** el backend deriva solo 3 (`Música/Deportes/Teatro`) por texto;
  no hay columna `category`. Las 5 del mockup (Conciertos/Festivales/Deportes/
  Teatro/Comedia) se refinan en cliente sobre `e.category` + `e.name` (ver
  `CATEGORY_CHIPS` en `HomePage.jsx`). Una columna real es follow-up.
- **Sin checkout publico todavia:** el CTA "Comprar boleto" del detalle apunta a
  `/boletas` (el fan recupera lo ya emitido por contacto).

## Admin: salud de puerta (duplicados / rechazos)

- `GET /events/{id}/report` (vista admin) expone `door_duplicates` (outcome
  `already_redeemed`: síntoma de QR reenviado/clonado) y `door_rejected` (todo
  lo demás que la puerta negó). El promotor NO los ve (la rama no-admin del
  reporte no los calcula): es dato operativo del negocio.
- `EventWorkbench` los pinta en el backstage, **solo si > 0** (un 0 permanente
  sería ruido). El `/report` se refresca en vivo con `useLiveRefresh` cuando el
  evento está en puerta, así que la alerta aparece mientras pasa la noche.
- **Dato muerto que dejamos ahí a propósito**: `GET /events/{id}/summary` ya
  calculaba integridad de puerta (`DoorScanStats`) pero el frontend **nunca lo
  consume** (buscar `/summary` en `frontend/src`). Antes de añadir otro cálculo
  de puerta, revisar si `/summary` ya lo tiene.
- La franja de eventos (`/events/ticket-counts`) también expone `duplicates`/
  `rejected` por evento. La consulta de `redemptions` va **aparte** (agrupada
  por evento) y se fusiona en Python: meterla en el mismo `FROM` que `tickets`
  multiplica filas (fan-out) y corrompe `active`/`revenue_cents`.
- **Aviso proactivo (mig 026):** un trigger sobre `redemptions` (outcome
  `already_redeemed`) avisa a los admins con kind `door_anomaly` cuando el
  MISMO ticket se reescanea 3+ veces en 5 min (rafaga = firma de QR reenviado).
  Es umbral por **tasa**, no acumulado, y avisa al **cruzar** el umbral una
  sola vez por rafaga. Vive en la DB (como el resto de notificaciones), así que
  cubre el scan en línea y la reconciliación offline (door_sync).
