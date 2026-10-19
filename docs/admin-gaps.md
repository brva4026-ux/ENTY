# Estudio del panel de administración — qué faltaba y qué se corrigió

Alcance: el dashboard del admin (`/admin`) contra lo que el Sprint 2 exige.
Cada hallazgo trae la evidencia que lo sustenta. Se marca lo que **ya se
corrigió** en esta iteración y lo que queda **abierto**.

Referencia de historias: `docs/backlog-mvp.md`.

---

## 1. Resumen ejecutivo

El Sprint 2 pedía dos cosas que el admin no podía hacer:

1. **S2-3** — "el reporte muestra validaciones incorrectas = screenshots /
   boletas duplicadas".
2. **DoD del Sprint 2** — "el reporte del admin mostró cuántos cupos de promotor
   se usaron y cuántas boletas no cuadraron en el conteo".

Los datos **sí se estaban guardando** en `redemptions` desde el Sprint 2, pero
**ningún endpoint los exponía**: la tabla se escribía y nunca se leía. El admin
no podía ver los intentos de colarse, que es justamente la señal de fraude que
el sprint quería monitorear.

Además, el panel no mostraba **dinero en ninguna parte**, aunque el precio de
cada boleta se congela en `price_cents_snapshot` y por tanto la caja es
calculable sin supuestos.

## 2. Hallazgos

### 2.1 `redemptions` se escribía pero no se leía — **CORREGIDO**

Evidencia: `grep -rn "redemptions" backend/app/` no devolvía ningún consumidor
en la capa HTTP. La tabla se poblaba desde `redeem_ticket` y quedaba ahí.

Impacto: la métrica anti-fraude del sprint era invisible. Un evento con 7
escaneos rechazados se veía idéntico a uno con 0.

Corrección: `/summary` agrega `door` con `granted`, `already_redeemed`,
`not_found`, `failed`, `total`, marcas de tiempo del último escaneo y el
desglose por portero. La UI lo muestra como "Integridad de la puerta".

### 2.2 No había ingresos — **CORREGIDO**

Evidencia: `EventReport` exponía `issued/redeemed/pending/voided` y nada más.
El precio congelado existía (`tickets.price_cents_snapshot`) pero no se sumaba.

Corrección: `revenue_cents`, `paid_tickets`, `avg_ticket_cents`,
`courtesy_tickets`. El criterio de "boleta viva" (issued + redeemed) es el mismo
que ya usaba el medidor de cupo, para que las dos pantallas no se contradigan.

### 2.3 Fuga de ingresos por el endpoint de menor privilegio — **CORREGIDO (bug real)**

Al agregar el desglose de dinero por tipo, el campo `revenue_cents` empezó a
viajar también en `/report`, que lo leen **promotor y bouncer**. `/summary`
bloquea a ambos con 403, pero el mismo SQL alimentaba los dos endpoints.

Esto no era teórico: al compartir la consulta, el dinero se filtraba por la
puerta de atrás. Se separó en dos consultas (`_BY_TYPE_SQL` para admin,
`_BY_TYPE_NO_MONEY_SQL` para el resto) y se dejó un test que lo fija:
`test_report_does_not_leak_revenue_to_low_privilege_roles`.

Verificado contra la API real:

```
/report  como promotor -> 200, sin claves de dinero
/summary como promotor -> 403
/summary como bouncer  -> 403
```

### 2.4 `by_type` se calculaba y se descartaba — **CORREGIDO**

Evidencia: el campo ya venía en la respuesta del API y el frontend no lo
renderizaba en ninguna vista.

Corrección: se muestra como barras de ocupación por tipo, con precio y total.

### 2.5 Sin auto-refresh — **CORREGIDO**

Evidencia: el único `useEffect` de carga dependía de `[selectedEvent, venueId]`,
así que los números quedaban congelados hasta recargar la página.

Impacto: en puerta el admin tomaba decisiones con cifras viejas.

Corrección: refresco cada 20 s de reporte, boletas y cupos.

### 2.6 Dos eventos con el mismo nombre eran indistinguibles — **CORREGIDO**

Evidencia: el selector pintaba solo `ev.name`. La entidad tiene `starts_at` y no
se usaba.

Corrección: cada botón muestra `vie 20 sep · 9:00 p.m.` en fuente monoespaciada.

### 2.7 No se podía buscar una boleta — **CORREGIDO**

Evidencia: `TicketList` renderizaba la lista completa sin filtro ni búsqueda.
Con 44 boletas ya es incómodo; en un evento real son cientos.

Corrección: búsqueda por número, nombre o teléfono, y filtro "Solo anuladas".
El filtro es en cliente porque el endpoint devuelve las 200 más recientes
(`LIMIT 200` en `lifecycle.py`), así que buscar es instantáneo. Si el evento
pasa de 200 boletas, las demás no aparecen en la lista.

### 2.8 Las fuentes de la app nunca se cargaban — **CORREGIDO (bug real)**

Evidencia: el `@import url(fonts.googleapis...)` estaba **después** de las
reglas de Tailwind. El navegador descarta un `@import` que no esté al principio.
El build de Vite tampoco lo emitía. Comprobable:

```
grep -o "fonts.googleapis" dist/assets/*.css   -> sin resultados
```

O sea que la app se venía renderizando con la fuente por defecto del sistema,
pese a que `index.css` declaraba Inter. Se movió a un `<link>` en `index.html`
con `preconnect`, y ahora el HTML construido sí lo incluye.

### 2.9 El bug de `not_found` — **RESUELTO** (deuda saldada)

`schema.sql` insertaba el escaneo fallido con un `INSERT ... SELECT FROM
tickets WHERE token_hash = ...`, que **no inserta nada** cuando el token no
existe (justo el caso `not_found`). La migración `002_lifecycle.sql:42` lo
corrige con un `INSERT ... VALUES (NULL, ...)` y hace `ticket_id` nullable.

Hoy `schema.sql` ya trae la versión correcta (`redeem_ticket` inserta
`VALUES (NULL, p_event_id, ..., 'not_found')` y la columna es nullable), así
que una instalación nueva no arrastra el bug. Verificado: un token inventado
registra una fila en `redemptions`.

### 2.10 El comentario de `outcome` en el esquema — **RESUELTO** (comentario eliminado)

El comentario de `schema.sql` enumeraba
`granted | already_redeemed | not_found | invalid_event` y omitía
`event_not_live` (además de `not_active`, `wrong_type` y `not_valid`, que
llegaron después). El comentario se eliminó en vez de ampliarlo: la lista de
estados válidos la define el propio código, y cualquier enumeración a mano
vuelve a quedar corta con la próxima migración. Los estados reales hoy son
ocho, y `redemptions.py` los valida en `_filters`.

### 2.11 La venta directa del admin no tenía pantalla — **CORREGIDO (y luego perdido en un merge)**

Evidencia: el backend aceptaba `POST /venues/{id}/events/{id}/tickets` con rol
`admin` desde el Sprint 1 (verificado: `201` con token crudo), pero ningún
componente del frontend lo llamaba. El admin solo podía emitir con `curl`, así
que en la práctica la taquilla del bar no existía.

Corrección: `EmitTicketPanel` en `/admin`, junto a los tipos de boleta. Emite
sin `allocation_id` (venta del bar, no cupo de promotor), avisa antes cuando el
evento no está abierto —`draft`/`ended` responden `409`— y reusa el mismo
`IssuedTicket` que el promotor para el QR, el enlace del invitado y el envío
por WhatsApp.

Detalle que quedó unificado: el armado del enlace `/t#<token>` y del mensaje de
WhatsApp vivía dentro del panel del promotor. Se extrajo a
`components/IssuedTicket.jsx`, que ahora usan las dos pantallas.

**Regresión (sep-2026).** El commit `e838fad` agregó el panel; el merge
`ff7c471` ("Merge branch 'master'") tenía dos padres —uno con el panel
(`f8d104f`) y otro sin él (`fc5237d`)— y resolvió a favor del que no lo tenía:
borró `EmitTicketPanel`, su import y `<IssuedTicket>` sin que nadie lo notara.
`tests/test_admin_emit.py` siguió verde todo ese tiempo porque prueba el
**endpoint**, no la pantalla; el admin volvió a quedarse sin taquilla y la
documentación siguió diciendo "CORREGIDO". Se restauró el panel (esta vez como
componente propio, `components/EmitTicketPanel.jsx`) y se agregó
`frontend/e2e/admin-venta-directa.spec.js`, que falla si la pestaña "Entradas"
deja de montar el formulario. Esa es la clase de hueco que un test de API no
puede cazar.

### 2.12 Una instalación nueva se quedaba sin gate legal — **CORREGIDO**

El gate legal (obligatorio por Ley 1581 de Colombia) depende de las filas de
`legal_documents`. Esas filas vivían **solo** en las migraciones
`028/029/030`, pero el README manda instalar con `db/schema.sql` a secas
(`psql ... < db/schema.sql`), sin correr las migraciones. Resultado en una
instalación limpia: `legal_documents` vacía → `legal_missing_acceptances()`
devuelve cero filas → ningún usuario acepta términos ni autoriza el
tratamiento de datos, y la app no lo delata.

Verificado sobre una base nueva creada solo con `schema.sql`:
`legal_documents rows: 0`. Las 12 filas (versiones 1.0, 1.1 y 1.2 de los cinco
documentos) se consolidaron en `schema.sql` con `created_at` explícito, porque
`legal_missing_acceptances` elige la versión vigente por `created_at = max(...)`.
`test_schema_drift.py` no lo cazaba porque compara con `pg_dump --schema-only`:
compara estructura, no filas.

### 2.13 El guard del gate legal nunca corría — **CORREGIDO**

`legal-gate.spec.js` existe para atrapar la regresión de la pantalla en negro
(`onCleared(true)` vs `onCleared()`). Pero se saltaba solo con
`test.skip(!gate.isVisible())`, y la cuenta demo no tenía documentos
pendientes: en CI el schema no traía las filas, y en local el primer spec que
tocaba `admin@bar.test` (`admin-venta-directa.spec.js`) consumía las
aceptaciones y dejaba el gate cerrado para el resto. O sea: el guard que
existe para que el bug no vuelva era, en la práctica, un test que nunca corría.

Corrección: el seed siembra ya aceptados a los usuarios demo compartidos y
reserva `gate@bar.test` (única cuenta con pendientes) para el spec, que además
borra esas aceptaciones en cada corrida para poder re-ejercitarse. Se
comprobó revirtiendo el fix: con `onCleared()` el spec falla; con
`onCleared(true)` pasa.

### 2.14 `not_active` fuera del filtro y de la exportación — **CORREGIDO**

`redemptions.py` valida `?outcome=` contra una lista blanca que omitía
`not_active` (un estado que `redeem_ticket` inserta de verdad: QR escaneado
antes de que abra la ventana). El filtro devolvía `422` para un estado real, y
el CSV tampoco tenía etiqueta en español para él. Se agregaron ambos.

## 3. Lo que sigue abierto

| # | Pendiente | Por qué importa |
|---|-----------|-----------------|
| 1 | `schema.sql` con el `INSERT` roto de `not_found` | ~~Instalaciones nuevas heredan un bug ya corregido en migración~~ **CORREGIDO (sep-2026):** el esquema se consolido completo; el `not_found` con `ticket_id` NULL ya vive en `schema.sql` y el test `test_schema_drift.py` impide que vuelva a divergir |
| 2 | ~~No hay UI para emitir boletas de pago desde el admin~~ **CORREGIDO** | La venta directa solo existía por API; ahora hay formulario en `/admin` |
| 3 | ~~No hay endpoint de `redemptions` con detalle~~ **CORREGIDO (sep-2026)** | `GET .../redemptions` (JSON paginado, filtros outcome/q/fechas) y `GET .../redemptions.csv` (export completo, auditado) — el registro escaneo por escaneo ya existe |
| 4 | ~~Sin rango de fechas ni exportación~~ **CORREGIDO (oct-2026)** | El cierre de la PUERTA ya exportaba con rango (`/redemptions.csv?since&until`); ahora la CAJA tambien: `GET .../summary` acepta `?since`/`?until` (semiabierto, anclado a la zona del evento) y `GET .../summary.csv` baja el cierre del periodo (caja + puerta + por tipo + por promotor, auditado). El backstage expone un rango Desde/Hasta con boton "Caja (CSV)" junto al cierre de noche |
| 5 | ~~Sin alerta en vivo al detectar duplicados~~ **CORREGIDO (oct-2026)** | La rafaga (mismo ticket reescaneado 3+ veces en 5 min) ya dispara aviso in-app + push (mig 026) y ahora ademas un **banner en vivo** que se planta encima del panel y enlaza a la noche exacta (mig 027), sin esperar a que el admin abra la campana |

El punto 1 quedó cerrado: el esquema consolidado ya trae el `INSERT` correcto y
`test_schema_drift.py` lo vigila.

## 4. Verificación

- `backend`: 423/423 tests en verde (`pytest tests/ -q`, incluye los 6 de
  emisión directa y el nuevo de desglose por portero con ingreso forzado).
- `frontend`: `npm run build` limpio y `npm run lint:css` sin errores.
- E2E: 22/22 en verde (incluye `legal-gate.spec.js`, que ahora corre de verdad
  en vez de saltarse). El gate se comprobó revirtiendo `onCleared(true)` a
  `onCleared()`: el spec falla, así que atrapa la regresión de la pantalla
  negra.
- Instalación limpia: `psql ... < db/schema.sql` deja `legal_documents` con las
  12 filas y la versión vigente correcta por slug (antes: 0 filas).
- Extremo a extremo con datos reales (43 boletas, 31 accesos, 7 rechazos):
  los números del panel cuadran contra la consulta SQL directa.
- Control de acceso probado contra la API en ejecución para los tres roles.

Criterio de cuadre usado: `issued = redeemed + pending` y
`total = granted + failed`. El desglose por portero suma exactamente esos
mismos totales (un ingreso forzado cuenta como `granted`, no como `failed`).
