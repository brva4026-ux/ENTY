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

### 2.9 El bug de `not_found` — **YA ESTABA RESUELTO, con deuda pendiente**

`schema.sql:334` inserta el escaneo fallido con un `INSERT ... SELECT FROM
tickets WHERE token_hash = ...`, que **no inserta nada** cuando el token no
existe (justo el caso `not_found`). La migración `002_lifecycle.sql:42` lo
corrige con un `INSERT ... VALUES (NULL, ...)` y hace `ticket_id` nullable.

Es decir: **en la DB migrada el bug no existe** (verificado: un token inventado
registra una fila) pero **`schema.sql`, la fuente para instalaciones nuevas,
todavía tiene la versión rota**. Queda abierto: alinear `schema.sql` con 002.

### 2.10 `not_found` no estaba en el comentario del esquema

`schema.sql:200` documenta `outcome` como
`granted | already_redeemed | not_found | invalid_event`, pero el código también
inserta `event_not_live`. Menor, pero es documentación que miente.

### 2.11 La venta directa del admin no tenía pantalla — **CORREGIDO**

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

## 3. Lo que sigue abierto

| # | Pendiente | Por qué importa |
|---|-----------|-----------------|
| 1 | `schema.sql` con el `INSERT` roto de `not_found` | ~~Instalaciones nuevas heredan un bug ya corregido en migración~~ **CORREGIDO (sep-2026):** el esquema se consolido completo; el `not_found` con `ticket_id` NULL ya vive en `schema.sql` y el test `test_schema_drift.py` impide que vuelva a divergir |
| 2 | ~~No hay UI para emitir boletas de pago desde el admin~~ **CORREGIDO** | La venta directa solo existía por API; ahora hay formulario en `/admin` |
| 3 | ~~No hay endpoint de `redemptions` con detalle~~ **CORREGIDO (sep-2026)** | `GET .../redemptions` (JSON paginado, filtros outcome/q/fechas) y `GET .../redemptions.csv` (export completo, auditado) — el registro escaneo por escaneo ya existe |
| 4 | Sin rango de fechas ni exportación | ~~El reporte es "ahora", no cierre de caja~~ parcial: el cierre de la PUERTA ya exporta con rango de fechas; falta el mismo rango para la caja (`/summary`) |
| 5 | Sin alerta en vivo al detectar duplicados | Hoy se descubre al mirar el panel |

El punto 1 es el de mayor riesgo y el más barato de cerrar.

## 4. Verificación

- `backend`: 52/52 tests en verde (46 previos + 6 nuevos de emisión directa).
- `frontend`: `npm run build` limpio.
- Extremo a extremo con datos reales (43 boletas, 31 accesos, 7 rechazos):
  los números del panel cuadran contra la consulta SQL directa.
- Control de acceso probado contra la API en ejecución para los tres roles.

Criterio de cuadre usado: `issued = redeemed + pending` y
`total = granted + failed`.
