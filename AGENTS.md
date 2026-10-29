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

### Restaurar el entorno en un contenedor limpio (Linux)

El contenedor puede llegar **sin** Postgres ni el binario de Playwright y sin
nada corriendo. Para dejar UI + API + e2e operativos:

```bash
# 1. Postgres 17 + base + esquema + migraciones
sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql
sudo service postgresql start
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'devpassword';"
sudo -u postgres psql -c "CREATE DATABASE ticketflow OWNER postgres;"
for f in db/schema.sql db/migrations/*.sql; do PGPASSWORD=devpassword psql -h 127.0.0.1 -U postgres -d ticketflow -f "$f"; done

# 2. Backend (env de backend/.env.local) y frontend
cd backend && (set -a; . ./.env.local; set +a; nohup .venv/bin/python run.py >/tmp/backend.log 2>&1 &)
cd frontend && (VITE_BACKEND_URL=http://127.0.0.1:8001 nohup npm run dev >/tmp/vite.log 2>&1 &)

# 3. Seed + navegador de Playwright (por defecto NO viene instalado)
curl -s -X POST http://127.0.0.1:12000/api/seed
cd frontend && npx playwright install chromium
```

Sin el paso 3 los e2e fallan con `Executable doesn't exist ... chrome-headless-shell`.
La home del fan vive en **`/inicio`** (`/` redirige a `/login`).

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

Ese test necesita los binarios `psql` y `pg_dump` en el PATH. El contenedor
puede traer solo el servidor: si el test se salta con "psql/pg_dump no
disponibles", instalá el cliente (`sudo apt-get install -y postgresql-client`)
en vez de darlo por bueno — un skip local no es un verde.

`tests/test_deploy_migrations.py` cierra el otro lado del mismo problema:
`db/schema.sql` es la instalación completa, pero **producción se migra con
`scripts/deploy.sh`**, que lleva la lista de migraciones escrita a mano. Si
agregás una migración y no la sumás al array `MIGRATIONS`, el código nuevo se
despliega (Vercel auto-despliega en cada push) pero el objeto nunca llega a
Supabase: las rutas que lo usan devuelven 503. El test compara la lista contra
`db/migrations/*.sql` y falla si falta una, sobra una o se rompe el orden.

**El cuerpo de una migración que reemplaza una función debe ser BYTE-IDÉNTICO
al de `schema.sql`.** El drift test re-aplica las migraciones sobre una
instalación limpia y compara el `pg_dump`; si el cuerpo difiere aunque sea en
un comentario o en la indentación, el dump cambia y el test falla. No escribas
el cuerpo a mano: extraelo del `schema.sql` (o copiá y pegá sin retocar) y
agregá los comentarios de la migración FUERA del `$$ ... $$`. Los
`CREATE FUNCTION` de una migración van con `CREATE OR REPLACE`, y una tabla
nueva con `CREATE TABLE IF NOT EXISTS` (para que un re-run no rompa).


### Correr la suite E2E dos veces seguidas (importante)

La suite **no es idempotente**: sus tests crean eventos reales (`E2E-*`), los
compran y abren la puerta. Al segundo `npx playwright test` contra la misma DB:

- El catálogo de `/inicio` se llena de eventos `E2E-*`. Los tests que asumían
  que la primera fila era la del seed (`Noche Electrónica`) fallaban por un
  motivo que **no tiene nada que ver con el cambio que estás probando**.
  Síntoma real observado: 10 fallos con el mismo código que antes daba 30/31.
  **Ya no**: `fan.spec.js` y `fan-checkout.spec.js` seleccionan el seed
  explícitamente (por nombre) en vez de "el primero de la lista", así que dan
  30/31 con la base contaminada. Si aparecen fallos de orden en otro test,
  aplicá el mismo patrón: anclá al seed, no a la posición.
- Los logins del admin chocan con el lockout de `login_attempts`
  (`_MAX_FAILURES=8` en 15 min, `backend/app/routers/auth.py`). El 9.º intento
  devuelve **429** y todo test que entre al panel falla.

Antes de culpar a tu diff, limpiá y volvé a correr:

```bash
export PGPASSWORD=devpassword
psql -h 127.0.0.1 -U postgres -d ticketflow -c "DELETE FROM login_attempts;"
# los E2E-* primero sus dependencias (tickets cuelga de ticket_types, etc.)
for t in analytics_events event_waitlist redemptions tickets ticket_types \
         promoter_allocations event_staff event_access_tokens \
         ticket_payments ticket_returns; do
  psql -h 127.0.0.1 -U postgres -d ticketflow -c \
    "DELETE FROM $t WHERE event_id IN (SELECT id FROM events WHERE name LIKE 'E2E-%');"
done
psql -h 127.0.0.1 -U postgres -d ticketflow -c "DELETE FROM events WHERE name LIKE 'E2E-%';"
```

Si un test falla, **reproducí el fallo en la DB limpia antes de tocar el
código**: hoy los dos culpables (contaminación y lockout) se veían idénticos a
una regresión real.

### stylelint: hoy NO está en CI y el presupuesto está mal

`npm run lint:css` es `stylelint "src/**/*.css" --max-warnings 31`, pero hay
**64 warnings y 22 errores**: el repo está en **exit 2** desde antes de la
auditoría y nadie lo corre, así que el guardarraíl del design system no está
vigilando nada. No te fíes del exit code de un `npm run` a través de un pipe
(`cmd | tail` te da el exit de `tail`): redirigí a archivo y mirá `$?`.

Los 22 errores viven todos en `components/DashboardCover.css`, un componente
que **nunca se cableó a ninguna página** (`git log -S DashboardCover` sobre
`pages/`, `main.jsx` y `App.jsx` sale vacío; 0 importadores; ausente del
bundle). Incluye 7 `@keyframe` mal escritos —que no definen ninguna animación—
y un `translateY(1)` inválido. Mientras ese archivo exista, poner stylelint
como gate en CI deja el pipeline rojo.

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

- **CI en rojo que NO es tu culpa (facturación de GitHub)**: si los jobs de
  `ci.yml` terminan en **~3 segundos** (cuando lo normal son ~9 minutos), el
  job nunca arrancó. La anotación lo dice:

  > `The job was not started because recent account payments have failed or
  > your spending limit needs to be increased.`

  Es un problema de facturación de la cuenta, no del diff: `master` ya estaba
  rojo por lo mismo. No pierdas tiempo "arreglando" tu cambio ni buscando el
  log (`--log-failed` responde `log not found` / `BlobNotFound`, porque nunca
  hubo log). Verificá el tiempo del run y la anotación antes que el código:

  ```bash
  gh run list --repo brva4026-ux/ticketflow --workflow=CI --limit 5
  gh run view <RUN_ID> --repo brva4026-ux/ticketflow   # lee ANNOTATIONS
  ```

  Se arregla en GitHub > Settings > Billing. Mientras tanto, el gate real es
  correr las suites localmente (backend, frontend y e2e) y el deploy de Vercel.
- **`prepare_threshold`**: en psycopg3, `None` desactiva los prepared
  statements y `0` los prepara en el **primer** uso. Debe ser `None` detrás de
  un pooler en modo transaction (Supabase `:6543`, pgBouncer), o `redeem`
  falla con `cached plan must not change result type` (HTTP 500).
  Hay dos sitios en `app/core/db.py`: `_CONNECT_KWARGS` e `init_pool`.
- **Seed**: `POST /seed` solo responde si `IS_DEMO=true`. Borra y recrea los
  datos demo; no hay endpoint de borrado.
- **La puerta y el cierre de eventos (mig 034)**: el auto-cierre tiene 6 h de
  **gracia** (`ends_at` es una estimación del organizador, no una orden de
  desalojo). No la quites: sin ella, un bar que cierra más tarde de lo previsto
  pasa el evento a `ended` y `redeem_ticket` —que solo acepta `live`/`published`—
  rechaza TODAS las boletas válidas con `EVENT_NOT_LIVE`. Si un evento cerró de
  más, `POST /venues/{v}/events/{e}/reopen` lo devuelve a `live` (admin,
  auditado); `ended -> live` está en la matriz de transiciones del trigger.
  Ojo con los tests de cierre: un evento vencido hace **1 h** ya NO se cierra.
- **Sync offline idempotente**: cada item de la cola de puerta lleva un
  `scan_id` (uuid del teléfono). `door-sync` lo usa como recibo en
  `door_sync_receipts (event_id, scan_id)` y responde `results[]` por token.
  El cliente borra de IndexedDB solo lo confirmado, y **nunca** un `INVALID`
  (eso es un fallo transitorio del canje, no un rechazo: borrarlo perdería una
  entrada pagada). Los rechazos definitivos sí se borran.
- **`push_outbox` es global y el drenador procesa de a 50**: `_drain_once`
  toma las cartas más antiguas con `LIMIT MAX_ATTEMPTS_PER_TICK` (50). Un test
  que acepte muchas invitaciones (cada una notifica al admin de la venue)
  mete cartas nuevas al outbox compartido y desplaza la que
  `test_push_outbox::test_drain_once_marks_letter_processed` espera ver
  procesada: el test falla por contaminación, no por lógica. Pasa aislado y
  falla en la suite completa. Si tu test genera notificaciones, bórralas al
  terminar (`DELETE FROM push_outbox WHERE notification_id IN (SELECT id FROM
  notifications WHERE venue_id = %s AND kind = ...)`). El síntoma engaña
  porque el test que falla no es el que ensucia.
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

## Capas de diseño (auditoría)

El frontend importa **cinco** hojas en este orden (main.jsx):
`tokens.css` → `index.css` → `aesthetic-refresh.css` → `enty-system.css` →
`enty-fan.css`. `tokens.css` es la fuente única de color/forma/movimiento; las
demás elevan la anterior sin reescribirla y `enty-fan.css` es la última palabra
sobre las superficies del fan.

| Capa | Alcance |
| --- | --- |
| `tokens.css` | **Tokens del design system Enty** (`--e-*`): primitivas, semánticas (voltean con el tema) y escalas cerradas (espacio, radio, tipo, motion, elevación). Ver "Tokens y guardarraíles". |
| `index.css` | Base del design system (clases `.card`, `.field`, `.btn-*`), tema claro/oscuro y la vitrina del fan (`.home`, `.evd`). |
| `aesthetic-refresh.css` | Marca aplicada: `.home` (Inicio/boletas), `.evd` (detalle), `.tkt` (boleta pública) y la capa `.app-shell` del interior. |
| `enty-system.css` | Retoques del sistema ("eleva sin reescribir"). |
| `enty-fan.css` | **Experiencia del fan (vitrina editorial)**: responsive real, motivo de boleto perforado, ticker cinético y estados completos. |

**Clasificación del rediseño (qué se conservó y qué se rehízo):**

- **Conservar**: la marca (matte black `#0B0B0F`, violeta `#7C3AED`/`#BB5CF6`,
  verde `#00E6AB`, rosa `#FF2D98`, tinta `#F5F5F7`, Sora única voz); el
  encuadre nocturno del interior (`.app-shell`); la boleta pública `.tkt` (ya es
  un artefacto troquelado y la credencial de la noche — no tocar).
- **Perfeccionar**: las superficies `.home`/`.evd` — el motivo de boleto estaba
  regado, ahora es el sistema.
- **Reemplazar**: el shell de "tira de teléfono" del fan (`max-width: 26rem`,
  sin breakpoints) por una vitrina editorial responsive; los estados vacíos
  genéricos por estados con identidad; el hero de una columna del detalle por
  un cartel pegajoso + rail de compra.
- **Eliminar**: la carga de decoración sin función; la duplicación de color de
  rol (ya centralizada en `lib/roles.js` → `ROLE_VISUALS`).

**Motivos exclusivos de Enty** (reconocibles sin el logotipo):

1. **Boleto perforado** — `.enty-perf` (troquel de línea discontinua) y
   `.enty-notch` (canto festoneado por máscara radial). Se usan como separador
   editorial y canto del rail de compra. La boleta pública y `.fan-ticket` ya
   traen su propio corte rasgado.
2. **Ticker cinético** — `.home-ticker` en Inicio: banda de palabras de la noche
   que se desplaza (se detiene y se reflow-ea con `prefers-reduced-motion`).
3. **Rejilla editorial** — `.home-list` es 1 col en móvil, 2 en ≥640px y 3 en
   ≥1024px; la fila de evento se vuelve tarjeta con la fecha como sello.
4. **Acento con significado** — verde = disponible/validado, rosa = urgencia.
   El violeta es la única voz interactiva.

**Verificación de la vitrina** (la que falla si se rompe):
- Cero scroll horizontal a 320/420/768/1440px en `/inicio`, `/evento/:id`,
  `/boletas` (un elemento cuenta como desborde solo si NINGÚN ancestro lo
  recorta).
- Detalle: 2 columnas ≥900px (cartel pegajoso + rail de compra), 1 en móvil.
- Contraste de texto ≥ 4.5:1 sobre `#0B0B0F`: `dim` #9a96a8 (6.83), `dim-2`
  #b6b2c4 (9.50), violeta brillo #bb5cf6 (5.59), verde (12.07), rosa (5.69).

## Tokens y guardarraíles (Fase 0–1 del plan estético)

Ver `docs/estetica-plan.md`. Resumen operativo:

- **`src/tokens.css` es la fuente única de color/forma/movimiento.** Prefijo
  `--e-*`, tres niveles: primitivas (`--e-ink-1`, `--e-violet-500`…), semánticas
  (`--e-canvas`, `--e-text-primary`, `--e-brand`…) y escalas cerradas
  (`--e-space-*`, `--e-radius-*`, `--e-text-*`, `--e-dur-*`, `--e-ease-*`,
  `--e-shadow-*`, `--e-elev-*`). Los componentes consumen las **semánticas**,
  no las primitivas ni un hex suelto.
- **Elevación**: la materia de tarjeta sale de `--e-elev-card` (reposo),
  `--e-elev-raised` (hover) y `--e-elev-overlay` (modal/hoja/toast) + el
  relieve `--e-highlight-inset`. Es un **par tema-aware** (oscuro = pizarra con
  sombra, claro = papel): no se escribe un receta de sombra por componente ni
  por tema. Los glow de marca/estado son aparte. El grano de `.home::after` usa
  `--e-grain` y se apaga con `reduced-motion`.
- **El tema claro es un cambio de tokens, no de componentes.** Los valores
  claros viven en el bloque `html[data-theme="light"]` de `tokens.css`; las
  hojas no repiten una regla por superficie. Las superficies que deben voltear
  usan las utilidades `text-ink` / `text-dim` / `text-dim-2` / `bg-canvas` /
  `bg-surface` en lugar de `text-white` o `bg-zinc-950` (que NO voltean: los
  tokens zinc 500–950 son de superficie fija; el corte de inversión está en 500).
- **Superficies insensibles al tema** (p. ej. `.auth-brand`, el panel navy de la
  entrada) fijan sus propios tokens de tinta en `tokens.css`, para que el
  wordmark siga legible sobre el navy también en claro.
- **`npm run lint:css`** (stylelint) es un **trinquete**: `--max-warnings 31`
  es un presupuesto que solo puede **bajar**. `color-no-hex` (todo `src/**/*.css`
  menos `tokens.css`; el bloque `@theme` de `index.css` está exento con
  `stylelint-disable` y rationale: es la fuente de los tokens Tailwind),
  `no-duplicate-selectors` y las reglas de shorthand son `warning` durante la
  migración; `declaration-block-no-duplicate-properties`, `color-no-invalid-hex`
  y `block-no-empty` son `error` y deben quedar en cero. Al cerrar una fase,
  **baja el número del presupuesto** en `package.json`.
- **Estado Fase 1 (HECHA, corte de tokens/color)**: las 4 hojas de componente
  están sin hex; los alias históricos `--tf-* / --home-* / --evd-* / --tkt-* /
  --in-*` solo apuntaban a primitivas `--e-*` (retirados del todo en Fase 6);
  `!important` bajó 11→3 (solo el override de `prefers-reduced-motion`) y el
  JSX ya no fija hex (el punto de estado usa `data-status` en CSS). Quedan 31
  `no-duplicate-selectors` (F4) y 21 `style={{}}` de geometría dinámica (no color).
- **Estado Fase 2 (HECHA, corte de escala)**: la tipografía es **una escala
  cerrada de 9 pasos**, compartida entre CSS (`--e-text-*` en `tokens.css`) y
  Tailwind (`--text-*` en el `@theme`). Los 179 `font-size` de las hojas usan
  `var(--e-text-*)`; **el piso es 11px** (2xs) — no quedan micro-tamaños ni
  `text-[Npx]` en JSX. Display por `--e-text-display` y `tabular-nums` en
  cifras. Queda pendiente el patrón editorial fino (eyebrow→display→lead→meta).
- **Estado Fase 3 (HECHA, color/tema/a11y)**: el foco de teclado sale del token
  `--e-focus-ring` (crema en oscuro, tinta en claro) y el anillo respeta el
  radio del control; los objetivos táctiles suben a 44px en móvil/táctil
  (`btn-mini`, `btn-icon`, `topnav-item` y avatar/tema/notificaciones por área
  pseudo). `a11y.spec.js` cubre 6 rutas públicas + detalle + interior + puerta
  + foco de teclado + **estructura de encabezados**, **12/12 en verde** en
  ambos temas, contraste AA sin fallos.
- **Estructura de documento (auditoría oct-2026)**: cada pantalla tiene **un
  solo `h1`** y la jerarquía no salta niveles, y **cada ruta tiene su propio
  `<title>`** (no el genérico de `index.html`). El test
  `a11y.spec.js › estructura: un h1 por pantalla…` lo exige en las 7 rutas
  públicas + las 3 de rol, y además cero scroll horizontal a 320px. El `h1`
  es el ancla del lector de pantalla: `/inicio`, `/waitlist`, `/promotor` y
  `/perfil` **no lo tenían** (empezaban en `h2`/`h3`). Al tocar una pantalla,
  el título visible va en `h1`; un `sr-only` solo es aceptable si de verdad
  no hay texto titular. La vitrina pone `h1` en el evento destacado
  (`.home-feature-top h1`), no en el wordmark (que reevalúa el logo).
- **`lib/useDocumentTitle.js`**: hook de título por ruta (`"<algo> · Enty"`).
  Toda página nueva lo llama (título fijo o dato dinámico, p. ej.
  `useDocumentTitle(data?.name)` en el detalle; `null` mientras carga deja el
  título anterior, sin parpadear a un texto genérico). Sin esto, una pestaña
  en un evento y un enlace compartido mostraban todos el mismo título.
- **Estado Fase 4 (HECHA, profundidad/material)**: una sola receta de tarjeta
  (`--e-elev-card`/`--e-elev-raised`/`--e-elev-overlay` + `--e-highlight-inset`),
  tema-aware (oscuro pizarra / claro papel); `--tf-shadow-*` retirados. Grano
  sutil `.home::after` (`--e-grain`) que se apaga con `reduced-motion`.
  Verificado en navegador: 1 receta por superficie y oscuro ≠ claro.
- **Estado Fase 6 (HECHA, cierre)**: los **namespaces legacy de tokens se
  retiraron por completo** — `--tf-* / --home-* / --evd-* / --tkt-* / --vh-* /
  --in-*` ya no existen en ninguna hoja; todo consume tokens `--e-*`. El bloque
  `@layer compat` nunca llegó a existir en el árbol (se descartó durante la
  migración). El material nuevo vive en `tokens.css`: `--e-glass-1/2`,
  `--e-glass-line`, `--e-glass-blur`, `--e-ticket-paper/hair/dim/dim-2`; y
  `--e-glow-brand` reemplaza a los halos `--tf-*`/`--home-*`. Nota: los
  **nombres de CLASE** `.home-*`, `.evd-*`, `.tkt-*`, `.vh-*` se conservan —
  son contratos que usan los E2E (renombrarlos rompería la suite). El design
  system vive documentado en `DESIGN.md` (el análisis de Apple que ocupaba ese
  archivo se movió a `docs/referencia-apple.md`).
- **Estado Fase 7 (HECHA, movimiento/tempo)**: las hojas dejan de escribir
  duraciones y curvas sueltas y consumen la escala de movimiento de
  `tokens.css`. Antes: 3 de 88 `transition` y 0 de 86 `animation` usaban
  `--e-dur-*`. Ahora: 158 usos de `--e-dur-*` y 133 de `--e-ease-*`. La regla
  aplicada es **el token más cercano con desvío ≤ 60ms** (`fast` 120 / `base`
  200 / `slow` 320); por encima de ~360ms la duración se deja literal, porque
  ahí no hay tempo de interfaz sino atmósfera (tickers de 38s, shimmer, confeti,
  respiración). Solo se tocó `transition`/`animation`, nunca `@keyframes`.
  - Los **easings con nombre solo se convierten en `transition`**, no en
    `animation`: en un bucle `linear`/`ease-in-out` es la elección correcta, y
    `ease-in` + `reverse` (salidas de diálogo) ya equivale a `ease-out`. Las
    curvas `cubic-bezier` explícitas se conservan tal cual, salvo las tres que
    ya eran idénticas a un token (`--e-ease-expo/-spring/-standard`).
  - `ease` (el default del navegador) sí pasa a `--e-ease-standard`: es un
    **cambio de feel** deliberado (los hover ganan el tempo del producto, no el
    del navegador), no una sustitución neutra. Si un hover se siente distinto,
    el punto a revisar es ese.
  - **`transition-all` bajó 8 → 0** (eran la última deuda de la regla): ahora
    las propiedades se nombran (`transition-[width]`, `transition-colors`,
    `transition-[transform,background-color]`…). Se retiró la entrada
    `transition-all` de `design-gate.baseline.json` (allowed y brand), porque el
    trinquete solo admite bajar.
  - **Pendiente de esta fase** (no incluido): los 7 `transition` sobre `width`/
    `height` (barras y medidores) siguen animando layout; el canon pide
    `transform: scaleX()`. Y los 2 `ease-in` de `dialog-*-out` se conservan
    porque van con `reverse`.
- **`e2e/a11y.spec.js`** es la red de accesibilidad: contraste AA en público
  (oscuro y claro, 6 rutas + detalle), interior (admin/promotor, + alt de
  imágenes), la puerta (+ objetivos táctiles ≥ 44px) y el **foco de teclado
  visible y de un solo color** en ambos temas. Corre con `E2E_BASE_URL=http://127.0.0.1:12000
  npx playwright test e2e/a11y.spec.js`.

### Gate de diseno (skill design-taste-frontend)

`npm run lint:design` corre el lint del skill de diseno con la **allowlist de
marca** del proyecto y falla si aparece cualquier hallazgo nuevo. El gate vive
en `frontend/scripts/design-gate.mjs`; el presupuesto y el motivo de cada
excepcion, en `design-gate.baseline.json`.

No es una allowlist que deje pasar: es un **trinquete**. El lint del skill banea
~560 cosas en este repo, pero casi todas son la identidad deliberada de
TicketFlow (violeta de marca, gradientes del shell nocturno, glass del dock,
sombras de overlay, emoji de la demo). Esos conteos estan aceptados; **crecer en
cualquier regla falla**, y una regla que no figure en el baseline tambien falla.
Asi la cifra solo puede bajar. Para fijar una mejora, `--update`.

```bash
cd frontend
npm run lint:design                      # gate
node scripts/design-gate.mjs --json      # regresiones en JSON
node scripts/design-gate.mjs --update    # fija el presupuesto actual
```

Dos cosas que conviene saber antes de confiar en este gate:

- **En CI no verifica.** El skill vive en `.agents/`, que esta gitignored
  ("skills locales de la sesion"), asi que en CI el script se auto-salta y emite
  una anotacion `::warning` para que el skip se vea en el PR en vez de pasar por
  un verde real. Para que verifique hay que vendorizar el skill en el repo (es
  autocontenido: 119 lineas, solo builtins de Node) o apuntar `TASTE_SKILL_DIR` a
  un checkout. Hoy el gate es **local**.
- **El inspector (`inspect.mjs`) no corre en este contenedor.** Lanza Chrome sin
  `--no-sandbox` y aqui no hay sandbox de usuario, asi que muere con "No usable
  sandbox". El lint estatico si corre. El inspector ademas acepta
  `--allow <regla>`, que es la via que documenta el propio skill para marcas
  existentes; el lint no lo acepta, y por eso el gate lleva su propio baseline.

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
- La tinta casi blanca (`--e-text-primary`, antes `--in-ink`) se aplica **solo
  en oscuro** (`html:not([data-theme="light"]) .app-shell`): en claro hereda el
  color de `body`, o quedaría texto blanco sobre blanco.
- **Jerarquía por rol** (Fase 6): Admin = densidad y jerarquía de datos (lista
  compacta con zebra sutil, cabecera pegajosa `.evx-toolbar`, cifras tabulares,
  violeta solo en la acción primaria); Promotor = tinte de marca en cupos/ranking
  y medidor `e-meter`; Puerta = contraste máximo y targets ≥ 44px.
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
## Seguridad del origen y smoke SQL (Fase 0)

- **CSP por hash, no `unsafe-inline`.** La cabecera `Content-Security-Policy`
  vive duplicada en `vercel.json` (producción) y en `frontend/server.mjs`
  (ruta Docker/Render), junto con HSTS (`max-age=31536000; includeSubDomains`).
  Autoriza los dos `<script>` inline de `index.html` (anti-flash de tema y
  registro del SW) por `sha256`, no con `unsafe-inline`. Si cambia el HTML
  inline hay que **recalcular los hashes**: `node scripts/csp-hashes.mjs`
  (requiere build previo). Un hash que no coincide no rompe la app, pero
  pierde el anti-flash y el SW. `style-src 'unsafe-inline'` es necesario por
  los `style={{}}` de geometría dinámica; `img-src` permite `data:`/`blob:`/
  `https:` (flyers y blobs de QR); `connect-src` incluye Sentry y Nominatim
  (geocodificación del detalle del evento).
- **Probar la CSP en navegador real, no solo `curl`**: un test Playwright
  escuchando `console` por "Content Security Policy"/"Refused to", con login +
  visita pública, debe dar 0 violaciones. Repetir ese patrón al tocar cabeceras.
- **`db/tests/smoke.sql` es idempotente en DB sucia.** Usa el evento centinela
  `SMOKE-TEST: Noche Electrónica` (NO el `Noche Electrónica` del seed): como
  `events.name` no es único, el `ON CONFLICT DO NOTHING` del INSERT no
  insertaba y los `SELECT ... WHERE name=` tomaban el evento ajeno (fallaba con
  `event_not_open_for_sales`). No volver a usar el nombre del seed.
- **413 literal, no `status.HTTP_413_*`**: `HTTP_413_CONTENT_TOO_LARGE` no
  existe en todas las versiones de Starlette que permite FastAPI y
  `HTTP_413_REQUEST_ENTITY_TOO_LARGE` está deprecado. Usar `413`.
- **Techo de listados**: `GET /events` acepta `?limit=` (`le=500`, default
  200). Boletas (`lifecycle.list_tickets`, 50/200) y redenciones ya paginaban.
- **Correr pytest VACÍA la base demo** (comparten DSN): tras la suite hay que
  re-sembrar (`curl -X POST http://127.0.0.1:8001/seed`) antes de correr E2E,
  o el login demo falla.

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
- **Animación de entrada (login)**: la coreografía vive en `aesthetic-refresh.css`
  y la navegación con View Transitions en `frontend/src/lib/viewTransition.js`.
  El `useNavigate` declarativo (con `<BrowserRouter>`) **no** acepta la opción
  `viewTransition` — es exclusiva del data router; por eso el helper envuelve el
  `nav()` con `document.startViewTransition` + `flushSync`. Si tocás `.btn-primary`
  recuerda que `enty-system.css` carga después y lo redefine: cualquier estado
  nuevo necesita especificidad `.auth-shell` (o `.app-shell`) para ganar.
- **Entrada de las pantallas de la casa**: `.home`, `.evd` y `.door-shell`
  entran con `screen-rise` en cascada de 35ms (aesthetic-refresh.css). Dos
  reglas al tocarlas: (1) los hijos `position: fixed` quedan fuera del selector
  (`.home-nav`, `.evd-copied`, `.dialog-backdrop`) porque un `transform` en el
  padre los ancla a él y dejan de flotar sobre el scroll; (2) el tope de la
  cascada (0.245s) es deliberado — el audit de `e2e/a11y.spec.js` ignora lo que
  esté bajo opacidad 0.5, así que una entrada más larga le escondería bloques y
  debilitaría el guardarraíl. Se apaga con `prefers-reduced-motion` Y con
  `html[data-motion="reduce"]` (el reset global solo anula la duración; con
  `both` + delay el bloque igual parpadearía).
- **Grillas con datos del usuario**: todo item de `.evd-grid` lleva
  `min-width: 0` + `overflow-wrap: anywhere`. Sin eso, un valor sin espacios
  (una sede o localidad con un token largo) ensancha su pista y empuja las
  otras celdas fuera de la pantalla a 320px. Lo detectó el chequeo de scroll
  horizontal del spec de estructura.
- **`e2e/onboarding.spec.js` NO usa el seed demo**: el evento del seed ya está
  publicado, así que su guía de primeros pasos está apagada a propósito. El spec
  se registra (`/register`) para obtener un negocio nuevo, que es el único
  estado donde la guía se ofrece por primera vez. El registro acepta términos
  y crea venue + admin. Son 5 tests y cada uno registra una cuenta: el lockout
  de abajo (8/15 min) se agota a la mitad si además se re-corre el archivo, así
  que limpiar el cubo antes de cada corrida.
- **La guía de primeros pasos vive en el servidor, por (usuario, venue)**:
  `user_preferences` (mig 032) y `/auth/me/preferences`. Antes estaba en
  `localStorage`, que es por navegador: la decisión tomada en la laptop
  reaparecía en el celular, y el dominio de preview de Vercel (otro origen) no
  veía la de producción. `frontend/src/lib/onboarding.js` cachea en localStorage
  **solo para pintar sin parpadeo**; la verdad es la fila de la DB. El tutorial
  guiado (`OnboardingTour.jsx`) se ancla con `data-tour="<id>"` en el DOM y sus
  pasos se saltan solos si el ancla no existe (p. ej. el backstage en un negocio
  sin eventos).
- **El registro tiene lockout por IP** (mig 016, cubo `__register__`): 8
  intentos en 15 min desde la misma IP y el endpoint devuelve 429 — incluidos
  los exitosos, porque el registro **no** limpia su contador al acertar (el
  login sí: `_clear_failures`). Corriendo specs que registran varias veces
  seguidas, el 429 aparece a mitad de la suite y parece un fallo del producto.
  Antes de re-correr: `DELETE FROM login_attempts WHERE email_norm='__register__'`.
- **El aviso de cookies tapa los clics** en un navegador recién abierto (se
  pinta fijo arriba). Los specs que hacen clic en el panel deben marcarlo como
  visto: `page.addInitScript(() => localStorage.setItem("tf_cookie_notice", "1.1"))`
  (la versión vive en `CookieNotice.jsx`, `NOTICE_VERSION`).
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
- **Caja con rango de fechas**: `GET /events/{id}/summary` acepta
  `?since`/`?until` (ISO 8601, rango semiabierto [since, until) sobre
  `issued_at`/`scanned_at`) y `GET /events/{id}/summary.csv` baja el mismo
  cierre como archivo (auditado). Un datetime SIN zona se interpreta en la
  zona del EVENTO, no en UTC (misma leccion de `_resolve_month`): asi la UI
  puede mandar fechas sueltas "YYYY-MM-DD" del `<input type="date">` y
  "2026-10-01" significa medianoche en Bogota. Sin rango, la caja es la de
  siempre (todo el evento). El backstage pinta un rango Desde/Hasta con boton
  "Caja (CSV)" en la tarjeta "Cierre de noche". Antes de añadir otro calculo
  de puerta, revisar si `/summary` ya lo tiene.

## Admin: ritmo de puerta (`door_pulse`)

- `GET /events/{id}/report` expone `door_pulse`: ingresos (`granted` +
  `granted_forced`) agrupados en **franjas de 10 min** desde `starts_at`, con
  `label` (hora local del evento, `HH:MM`) ya formateada en el servidor.
- Solo la vista admin lo ve: es dato operativo del negocio; el promotor recibe
  `door_pulse: []` (igual que `door_duplicates`).
- Las franjas vacías **se rellenan con 0**: el hueco ES el dato (la puerta se
  atascó), por eso no se saltan. Se recorta a 24 h desde el inicio para que una
  reconciliación offline tardía no estire el eje.
- Se dibuja en `frontend/src/components/DoorPulse.jsx` (CSS puro, sin librería
  de gráficos: el proyecto dibuja sus charts a mano). La última franja se
  enciende en verde cuando el evento está `live` ("ahora").
- El cálculo vive en `report.py::_door_pulse`; `_event_or_404` ahora también
  devuelve `starts_at` y `event_timezone` para poder etiquetar los husos.
- La franja de eventos (`/events/ticket-counts`) también expone `duplicates`/
  `rejected` por evento. La consulta de `redemptions` va **aparte** (agrupada
  por evento) y se fusiona en Python: meterla en el mismo `FROM` que `tickets`
  multiplica filas (fan-out) y corrompe `active`/`revenue_cents`.
- **Aviso proactivo (mig 026/027):** un trigger sobre `redemptions` (outcome
  `already_redeemed`) avisa a los admins con kind `door_anomaly` cuando el
  MISMO ticket se reescanea 3+ veces en 5 min (rafaga = firma de QR reenviado).
  Es umbral por **tasa**, no acumulado, y avisa al **cruzar** el umbral una
  sola vez por rafaga. Vive en la DB (como el resto de notificaciones), así que
  cubre el scan en línea y la reconciliación offline (door_sync). El `link`
  apunta a `/admin?event=<id>` (mig 027): un toque abre el backstage de ESA
  noche, no el panel a secas.
- **Alerta EN VIVO (no solo la campana):** el aviso `door_anomaly` no espera a
  que el admin abra la campana. `NotificationBell` ya polea el feed (15 s);
  cuando ve un `door_anomaly` **sin leer y nuevo** (el primer poll siembra los
  existentes para no alertar por historial) monta `DoorAlertBanner`, un banner
  rosa fijo bajo el topbar con acción "Ver la noche". Es presentacional y se
  pinta por **portal a `document.body`** (el topbar lleva `backdrop-filter`, que
  lo vuelve containing block de sus `fixed` y lo atraparía en la cabecera).
  Solo aparece en pantallas de admin (`hasRole`). Descartarlo lo marca leído
  (no vuelve a alertar). No hay segunda petición: el feed ya trae el dato.
  E2E: `frontend/e2e/door-alert-live.spec.js` (dispara la rafaga por API).
- **`/admin?event=<id>` sin `tab`** cae en "Resumen" del backstage (whitelist
  de `AdminDashboard`): es donde vive la salud de puerta que el aviso señala.
- **Pestañas de venue: hay DOS whitelists que agregar.** Al sumar una sección
  nueva (ej. `puerta`, `promotores`) hay que tocar el array `section` de
  `AdminDashboard` (línea ~194, si no la URL cae a "resumen" en silencio) **y**
  la grilla de `BusinessDock`. Y en `onOpenEvent` de las secciones de venue el
  `tab` destino tiene que ser uno del backstage (`resumen`/`entradas`/`cupos`/
  `boletas`/`noche`): `flyToEvent(id, "puerta")` genera un enlace muerto porque
  "puerta" no existe dentro del evento.
- **Checkout público del fan (sin cuenta):** `POST /public/events/{id}/checkout`
  y `GET /public/checkout/{reference}` en `public.py`. Reutiliza ENTERO el ciclo
  de la mig 023 (link de Wompi + webhook `approve_ticket_payment`): lo único
  distinto es que no hay sesión, así que `created_by_user_id` queda NULL. La
  `reference` (`TF-<evento>-<32 hex>`, 128 bits, `app/core/refs.py`) es la
  *capability* del fan: no se enumeran cobros (inventada -> 404) y el token del
  QR **nunca** sale de estos endpoints (se reclama por contacto en `/boletas`).
  El monto sale de `ticket_types`, jamás del cliente; teléfono obligatorio
  (NOT NULL en `ticket_payments`), correo opcional. Rate limit propio 20/h/IP
  (cada POST llama a Wompi con dinero). Frontend: `FanCheckoutModal` +
  `?pago=<reference>` para el polling tras volver de Wompi.
- **Dos tokens distintos:** `git` empuja con `GITHUB_TOKEN` (scoped a git: el
  REST API le da 404 al repo), pero para llamar la API de GitHub (crear PR,
  leer actions) hay que usar `GITHUB_PERSONAL_ACCESS_TOKEN`. `gh` usa el token
  scoped-a-git, así que `gh api`/`gh pr` fallan con "Not Found".
- **CTA segun aforo en el detalle publico (E2-2, oct-2026):** `GET
  /public/events/{id}` expone `sold_out`, con EXACTAMENTE el gate de
  `join_waitlist` (`active >= min(SUM(quantity de TODAS las localidades),
  capacity)`). Si el CTA y el join discrepan, el fan ve un boton que la API
  rechaza con 409; por eso el cupo se consulta aparte (sin filtrar
  `is_active`) y no se reusa la lista de localidades activas del detalle.
  Agotado -> "Entrar a la lista de espera" (`/waitlist?event=<id>`); con lugar
  -> "Comprar boleto". La localidad agotada se deshabilita en el checkout y la
  seleccion inicial salta a la primera con cupo.
- **Correr los E2E en local:** el backend de dev (run.py, :8001) usa la DB
  `localhost:5432/ticketflow` y NO se siembra solo. Tras reiniciarlo, sembrar
  con `seed_demo_data` (el endpoint `/seed` exige `IS_DEMO=true`, que el
  proceso de dev no tiene). Los E2E corren contra `vite preview :12000` con
  `VITE_BACKEND_URL=http://127.0.0.1:8001` (proxy `/api` -> backend), igual
  que el job `e2e` de CI.
- **El sandbox se reinicia y borra Postgres, deps de Python y Chromium**
  (sobreviven `node_modules/` y `dist/`). Rearmar todo con
  `bash /workspace/work/setup_env.sh` (idempotente): levanta Postgres, aplica
  `schema.sql` + migraciones, instala el backend, arranca :8001 y el dev
  server :12000 y siembra. `psql` no queda en PATH: usar
  `/usr/lib/postgresql/17/bin/psql` con `PGPASSWORD=devpassword`.
- **El CI solo aplica `db/schema.sql`**, que NO trae las filas de
  `legal_documents` (viven en migraciones). Por eso el gate legal no se activa
  en CI: cualquier spec que asuma aceptaciones pendientes debe saltarse si la
  cuenta no las tiene (`test.skip`), o fallará en verde solo en local.
- **Puntos que toca el gate legal (no romperlos):** `LegalGate` en `Layout.jsx`
  (`onCleared(true)` — pasar `true`, no `undefined`, o el guard queda abierto y
  la app se pinta en negro); `LegalPage` es dueña del `<h1>` y del
  `document.title` (a11y.spec.js exige uno por pantalla; el `# título` del
  markdown se descarta); el banner de alerta de puerta debe quedar por ENCIMA
  del aviso de cookies (z-45 vs z-40) o el botón queda inclickeable.
- **La portada del panel (`.venue-header`) la definen TRES hojas** y gana la
  última en cargar (`main.jsx`: tokens → index.css → aesthetic-refresh.css →
  enty-system.css → enty-fan.css). Editar `index.css` sin comprobar la cascada
  es silenciosamente inútil: una regla posterior lo anula. El material de la
  portada vive scopeado a `.app-shell` en `enty-system.css`, en ambos temas.
  Comprobar con `getComputedStyle` en el navegador, no leyendo el CSS.
- **El panel renderiza en tema CLARO por defecto** (`tf_theme` sin guardar →
  `data-theme="light"`). Cualquier maqueta o medición visual debe partir de
  claro o no representa lo que ve el usuario.
- **El venue demo (`id=2`, Bar Esquina) no tiene `primary_color` ni `logo_url`**,
  así que cae al violeta de Enty y al tile de iniciales. Para ver los efectos
  brand-aware hay que ponerle color en la DB (y restaurarlo después).
- **Los E2E se auto-contaminan: una DB sucia produce "regresiones" falsas.**
  Corriendo la suite entera dos veces seguidas contra la MISMA base aparecen
  fallos que no tienen nada que ver con el cambio (`fan-checkout.spec`,
  `fan.spec`, el `scroll horizontal @320px` de `a11y.spec`). El seed no se
  reaplica y los specs que crean eventos/boletas dejan datos que rompen al
  siguiente. Antes de creer un fallo, reproducir con la DB como la deja CI:
  `DROP DATABASE ticketflow_e2e; CREATE DATABASE ticketflow_e2e;`
  `psql -f db/schema.sql` + `seed_demo_data` (ver el job `e2e` de ci.yml).
  Con la base fresca la suite da 27 passed / 1 skipped.
- **El ciclo de vida de un evento tiene UNA sola fuente en el frontend:**
  `NEXT_ACTIONS` (`AdminDashboard.jsx`), con las transiciones que el backend
  acepta en `VALID_TRANSITIONS` (`backend/app/routers/lifecycle.py`:
  publish draft→published, live published→live, end live→ended,
  cancel *→cancelled). La tarjeta de la franja (`STRIP_ACTION` para el verbo
  corto) y el backstage renderizan de ahí: no reimplementar un subconjunto en
  la tarjeta — ese fue el bug de "un evento en vivo solo ofrecía Duplicar".
  Los dos caminos pasan por `transitionEvent(ev, action, {fromStrip})`; la
  franja NO llama `refreshEventData()` (el POST ya devuelve el evento) y el
  backstage sí (necesita releer cifras). `.evx-actions` tiene `flex-wrap`:
  con el ciclo completo caben cuatro botones y deben poder caer a otra línea.
