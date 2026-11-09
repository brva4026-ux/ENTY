---
title: Auditoría de la Ley de Tesler — Enty
version: 1
scope: producto completo (fan, promotor, puerta, admin) + backend + automatizaciones
principle: la complejidad es constante; se elige quién la carga
status: implementado (fases A/B/C/D, T1–T12)
---

# Auditoría de la Ley de Tesler — Enty

> **La Ley de Tesler (Ley de Conservación de la Complejidad):** todo proceso
> tiene una complejidad que **no se puede eliminar**, solo **mover**. Cada vez
> que le pedimos a la persona que recuerde, repita, adivine o haga un paso
> mecánico, esa complejidad está **sobre el usuario**. El trabajo de diseño es
> empujarla hacia el sistema: defaults, memoria, anticipación, automatización,
> agregación.
>
> Traducción de casa, en cuatro reglas:
>
> 1. **Recordar es del sistema, no de la persona.** Un dato que ya se escribió
>    una vez no se vuelve a pedir.
> 2. **Anticipar, no esperar la orden.** Si el sistema sabe lo que va a hacer
>    falta (caché de puerta, tipo de boleta por defecto), lo prepara.
> 3. **Agregar lo repetitivo.** N acciones idénticas son una acción.
> 4. **La automatización no puede depender de que alguien pase por la
>    pantalla.** Un cierre "automático" que solo corre si el admin abre el
>    panel es una promesa que el sistema no cumple.

## 0. Alcance y estado

Esta es una auditoría de **lectura de código** (no un arnés en vivo como el de
la Ley de Fitts). Los hallazgos citan `archivo:línea` para que cualquiera los
reproduzca. **No se tocó código de la app**: este documento es el entregable
de la fase de propuesta. Cada hallazgo trae una propuesta, no una
implementación.

## 1. Diagnóstico

Se ordena por **quién carga la complejidad hoy** y por la facilidad de moverla
al sistema. Severidad: **Alta** (fricción diaria o promesa incumplida),
**Media** (inconsistencia que obliga a pensar), **Baja** (estilo/ingeniería).

### Tier 1 — complejidad clara sobre la persona

| # | Hallazgo | Evidencia | Causa raíz | Propuesta (a mover al sistema) |
| --- | --- | --- | --- | --- |
| T1 | **El fan reescribe su contacto cada vez que abre "Mis boletas"** | `MyTicketsPage.jsx:21` define `tf_fan_contact`; `:99` lo **guarda**; `:33` `useState("")` — **nunca lo lee**. El checkout sí lo precarga (`FanCheckoutModal.jsx:82`) | El dato se escribe en localStorage pero la pantalla que lo necesita no lo lee | Precargar `contact` desde `tf_fan_contact` en el `useState` inicial (mismo patrón que el checkout). El sistema ya lo sabe: solo hay que usarlo |
| T2 | **El caché de puerta offline es 100% manual** | `BouncerScanner.jsx:621` `prepareOffline()`; único disparador: el botón en `:1094`/`:1103` | El bouncer debe **acordarse** de descargar antes de perder señal; si se olvida, la puerta no tiene modo sin red | Descargar el snapshot **automáticamente** al seleccionar un evento `live` (o al abrir la pantalla con red), con botón de "actualizar" y aviso de frescura. El dato personal ya se baja a pedido: la propuesta es automatizar el *cuándo*, no el *qué* |
| T3 | **Un evento nuevo no se puede vender: nace sin tipos de boleta** | `events.py:326` `create_event` inserta solo en `events`; los tipos son un paso aparte (`TypeManager.jsx:9` tiene presets pero exige un clic) | El sistema conoce el aforo recién cargado y podría sembrar una "General" | Al crear el evento, **sembrar un tipo "General"** con precio 0 y cantidad = aforo (editable). El preset existe; solo falta que sea el default en vez de una acción |
| T4 | **Asignar cupos es N×M manual** | `AllocationManager.jsx:17` formulario de uno en uno; `events.py:612` `create_allocation` recibe una sola fila | Con P promotores y T tipos, el admin hace P×T asignaciones idénticas | Acción **"distribuir cupos"**: repartir el aforo de un tipo entre los promotores seleccionados (en partes iguales o por peso), en una sola operación. La aritmética es del sistema, la decisión sigue siendo del admin |
| T5 | **El auto-cierre de eventos depende de que alguien abra el panel** | `events.py:253` es el **único** llamador de `auto_close_expired_events()` (mig 020/034) | Sin cron (serverless), el "cierre automático" solo corre si un admin visita `/events` | Dispararlo desde **más rutas de lectura** (`/report`, `/door-snapshot`, `/overview`) y/o evaluar `pg_cron` en Supabase. Un evento vencido no puede seguir "En puerta" solo porque nadie miró |

### Tier 2 — inconsistencias que obligan a pensar

| # | Hallazgo | Evidencia | Causa raíz | Propuesta |
| --- | --- | --- | --- | --- |
| T6 | **Cuatro palabras para el concepto de "cuánto cabe"** | `aforo` (40 usos: `EventCreateModal.jsx:88`), `cupo` (66 usos, y **dos sentidos**: `TypeManager.jsx:355` "Cupo" = cantidad del tipo, `AllocationManager.jsx:143` = cupo del promotor), `localidad` (`FanCheckoutModal.jsx:264`) | Cada pantalla nombró su parte sin un glosario único | Fijar el vocabulario y aplicarlo en las tres capas (etiqueta, `aria-label`, `document.title`), como exige la Ley de Jakob. Propuesta: **Aforo** (local) · **Cantidad** (por tipo) · **Cupo** (promotor) · **Localidad** (el tipo visto por el fan). Sin sinónimos cruzados |
| T7 | **La preferencia vive en dos sitios según cuál sea** | Servidor: `onboarding`/`tutorial` (mig 032). localStorage (por navegador): `tf_theme` (`theme.js:17`), `tf_motion` (`motion.js:16`), `tf_venue` (`venue.js:12`), `tf_fan_favs` (`HomePage.jsx:31`), `tf_fan_contact` | El módulo 032 documenta que la decisión "es de la persona, en cualquier dispositivo", pero solo se aplicó a 2 de 6 preferencias | Decidir **cuál preferencia es de la persona** y cuál puede ser del dispositivo, y ser consistente. Tema/movimiento razonablemente son del dispositivo; venue y favoritos del fan son de la persona → migrar a `user_preferences` (y **abrir el `CHECK`** de la clave, ver T12) |
| T8 | **Duplicar un evento adivina la fecha y el nombre** | `events.py:29` `DUPLICATE_SHIFT_DAYS = 7` (hardcodeado); `:439` nombre `"… (copia)"`; `ends_at` queda `NULL` | El sistema asume patrón semanal; un venue no-semanal corrige a mano cada vez | Al duplicar, preguntar el **destino** (o recordar el intervalo real entre las últimas N noches del venue) en vez de fijar +7. Nombre sin "(copia)": pedir el nombre nuevo |
| T9 | **La cartelera del fan se corta en 100 sin avisar** | `HomePage.jsx:409` `fetchPublicEvents({ limit: 100 })` y todo el filtrado es en cliente | Si el venue supera 100 eventos, la búsqueda y los filtros quedan incompletos **en silencio** | Paginar/filtrar en el servidor, o al menos mostrar "hay más eventos" cuando el límite se alcanza. Un filtro que miente es peor que uno ausente |

### Tier 3 — complejidad de ingeniería que se filtra como inconsistencia

| # | Hallazgo | Evidencia | Causa raíz | Propuesta |
| --- | --- | --- | --- | --- |
| T10 | **Seis traductores de error SQL, uno por router** | `tickets.py:51` `_handle`, `events.py:97` `_edit_error`, `payments.py:62` `_handle`, `public_tickets.py:88` `_handle_return`, `waitlist.py:58` `_handle_waitlist_error`, `lifecycle.py:52` `_error_to_http` | El mismo error de negocio (`event_not_open_for_sales`, `ticket_type_inactive`…) se traduce por separado | Un **único** módulo `core/db_errors.py` con el mapa completo. Hoy el mismo error puede sonar distinto según la puerta por la que entró; el usuario no debería notarlo |
| T11 | **La normalización de teléfono está copiada en 4 lugares** | `lifecycle.py:1006`, `report.py:714` y `:733`, `public.py:575` (`_PHONE_TAIL`) — con dos estilos distintos: `'\D'` vs `'[^0-9]'` | El criterio "últimos 10 dígitos" se reimplementó en cada consulta | Una función SQL (`phone_tail(text)`) o, mínimo, una constante compartida. Cuatro copias es cuatro oportunidades de divergir |
| T12 | **Cada preferencia nueva exige una migración** | `db/migrations/032_user_preferences.sql:35` `CHECK (key IN ('onboarding','tutorial'))` | El `CHECK` cerrado fue una decisión deliberada ("la tabla es del producto, no un cajón") | Revisar: si T7 mueve más preferencias al servidor, el `CHECK` pasa de guardarraíl a fricción. Alternativa: `CHECK` por **forma** de la clave (patrón) en vez de lista cerrada |

## 2. Complejidad que se deja a propósito (honesto)

No todo se mueve. Estos casos cargan complejidad al usuario **por una razón**:

- **El fan no tiene cuenta; el enlace firmado es la credencial.** Que el fan
  pida el enlace y lo abra es complejidad **irreducible**: quitarla (devolver
  boletas con solo el contacto) es la vulnerabilidad que cerró `fan_access.py`.
  Se mueve el *trabajo* (T1: precargar el contacto), no la *seguridad*.
- **La puerta es server-autoritativa.** El árbitro final es la DB, no el
  teléfono; el modo offline existe pero reconcilia. Esa complejidad es el
  precio de no dejar entrar dos veces la misma boleta.
- **Publicar es un acto explícito del admin.** Un evento no se publica solo:
  publicar es un compromiso con el público. (La Ley de Hick ya separa la acción
  principal; aquí no se automatiza.)
- **`user_preferences` por (usuario, venue) y no por venue.** Si mañana entra un
  socio, cada uno decide lo suyo. Complejidad del modelo, no de la persona.
- **El cierre por gracia de 6 h (mig 034).** `ends_at` es una estimación, no una
  orden de desalojo: el sistema tolera el estirón. Complejidad que **protege** al
  usuario de un falso positivo.

## 3. Propuesta por fases (para cuando se autorice implementar)

1. **Fase A — memoria barata (1 sesión).** T1 (precargar contacto), T3 (sembrar
   "General"), T6 (glosario de vocabulario). Cambios locales, sin migración,
   sin riesgo de datos.
2. **Fase B — anticipación (1 sesión).** T2 (auto-descarga de snapshot en
   evento `live`), T5 (auto-cierre desde más rutas de lectura). Toca
   comportamiento en producción: exige pruebas de puerta y de ciclo de vida.
3. **Fase C — agregación (1–2 sesiones).** T4 (distribuir cupos), T8 (duplicar
   preguntando destino), T9 (paginación de cartelera).
4. **Fase D — consistencia de fondo (1–2 sesiones).** T7 (preferencias),
   T10/T11 (un solo mapa de errores, una sola normalización de teléfono),
   T12 (revisar el `CHECK`).

## 4. Cómo se verificaría (cuando se implemente)

- **T1/T3/T6**: pruebas de componente (el contacto aparece precargado; el
  evento nuevo trae un tipo; ninguna etiqueta usa sinónimos cruzados).
- **T2/T5**: pruebas de backend contra la DB real (`test_door_grace_and_sync.py`
  ya ejercita `auto_close_expired_events()`); para T2, una prueba de que el
  snapshot se descarga al seleccionar un evento `live`.
- **T4**: prueba de que N asignaciones se crean en una sola transacción y que
  la suma de cupos no supera el aforo del tipo.
- **T7/T10/T11/T12**: pruebas de contrato (misma entrada → mismo mensaje;
  `phone_tail` idéntico en las cuatro rutas).

## 5. Reglas de casa (para no reintroducir el defecto)

1. **Un dato ya escrito no se vuelve a pedir.** Si está en localStorage, en la
   sesión o en el servidor, la pantalla lo lee. Guardar sin leer es memoria
   muerta (fue T1).
2. **Lo que el sistema puede preparar solo, no se pide con un botón.** Anticipar
   el snapshot de puerta, el tipo de boleta por defecto, el contacto del fan.
3. **N acciones idénticas son una acción.** Antes de diseñar un formulario de
   alta repetida, preguntar si es una operación por lote.
4. **Una automatización que depende de que alguien pase por la pantalla no es
   una automatización.** Si el sistema promete "cierre automático", tiene que
   cerrar sin que nadie mire.
5. **Un concepto, una palabra, en las tres capas.** Si "aforo", "cupo" y
   "localidad" conviven, la persona tiene que construir el mapa mental que el
   sistema no le dio.

## 6. Estado de implementación (fases A/B/C/D)

Todas las fases están implementadas. El detalle, hallazgo por hallazgo:

| # | Qué se hizo | Dónde |
| --- | --- | --- |
| T1 | El contacto recordado (`tf_fan_contact`) se **precarga** al abrir "Mis boletas": el campo nace con lo último escrito en vez de vacío | `MyTicketsPage.jsx` (`savedContact`) |
| T2 | El snapshot de puerta se **descarga solo** al seleccionar un evento `live` sin caché (una vez por evento); el botón manual sigue para forzar/actualizar | `BouncerScanner.jsx` (`autoPrepRef`) |
| T3 | La cantidad del primer tipo arranca en el **aforo** del evento (ya cargado): no se vuelve a pedir a mano | `TypeManager.jsx` (`capacity`) |
| T4 | Reparto de cupos **por lote** entre varios promotores en un solo statement (suma exacta, sin "4.33 boletas") | `events.py` (`/allocations/bulk`), `AllocationManager.jsx` |
| T5 | El **cierre automático** se dispara desde más rutas de lectura (promotor, caja, puerta), no solo el panel del admin: ya no depende de que alguien pase por una pantalla | `core/lifecycle.py`, `events.py`, `report.py`, `tickets.py` |
| T6 | Un solo **glosario**: Aforo / Cantidad (por tipo) / Cupo (promotor) / Localidad (fan) | `TypeManager.jsx`, `AllocationManager.jsx`, etiquetas y `aria-label` |
| T7 | El **negocio activo** es de la persona: vive en `users.active_venue_id` (mig 040) y viaja en `/auth/me`; localStorage queda solo como caché de arranque. Tema y movimiento siguen siendo del dispositivo (se aplican antes del primer paint y siguen al SO); los favoritos del fan siguen locales (no hay identidad verificada hasta reclamar una boleta) | `db/migrations/040_active_venue.sql`, `auth.py` (`PUT /auth/me/active-venue`), `lib/venue.js`, `ProfilePage.jsx` |
| T8 | Duplicar un evento **elige** el destino: `?days=` usa el intervalo real entre las últimas noches y `?name=` da el nombre nuevo, en vez del +7 y "(copia)" adivinados | `events.py` (`duplicate_event`), `AdminDashboard.jsx` |
| T9 | La cartelera avisa cuando el catálogo se cortó: `/public/events` devuelve `has_more` y la vitrina lo dice en vez de mentir en silencio | `public.py`, `HomePage.jsx` (`home-truncated`) |
| T10 | Un **único mapa de errores** de negocio; los seis traductores delegan | `core/db_errors.py` |
| T11 | **Una** normalización de teléfono (últimos 10 dígitos) para todas las consultas | `core/phone.py` |
| T12 | El `CHECK` de `user_preferences.key` pasa de lista cerrada a **forma** (`^[a-z][a-z0-9_]{0,40}$`): una preferencia nueva no exige migración | `db/migrations/039_preference_key_shape.sql` |

Verificación: `pytest` completo en verde; `npm run build` y `npm run lint:css`
sin errores nuevos; `test_schema_drift.py` y `test_deploy_migrations.py` cubren
la migración 040.
