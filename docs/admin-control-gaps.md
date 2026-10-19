# Control total del admin — qué falta

Análisis del 2026-10-19. Pregunta de partida: *"que el admin pueda hacer de
todo y tenga control de todo"*. Aquí está la brecha entre lo que el backend ya
sabe hacer y lo que el admin puede tocar hoy, más las capacidades que **no
existen en ningún lado** (ni API ni UI).

Método: cruce de los 99 endpoints del backend contra las llamadas reales del
frontend, revisión de las pestañas de `/admin` y del modelo de datos
(`audit_log`, `ticket_payments`, `waitlist_*`, `venues`).

---

## 1. Huecos de "control": backend sí, UI no

Son las victorias más baratas: la lógica ya existe y está probada, solo falta
el botón. No hay que tocar la DB.

### 1.1 El registro de auditoría es invisible — **el hueco más grande**

Existe `audit_log` (quién hizo qué, cuándo, con `details` en JSONB) y **siete
lugares ya escriben en él**: cambios de tipo de boleta (precio/cupo), anulación
de boletas, exportaciones CSV, etc. Pero **no hay ningún endpoint para leerlo**.
El admin puede ver *el resultado* de una acción, nunca *quién la hizo*.

Para un panel que administra dinero y aforo esto es el corazón del control:
hoy si un empleado baja un precio, cambia un cupo o anula una boleta, queda
grabado en `audit_log`… y nadie lo puede leer desde la app.

Falta: `GET /venues/{id}/audit` (filtros por actor, tipo, entidad, rango de
fechas) + pestaña "Auditoría" en `/admin`. La tabla y los índices
(`audit_log_venue_idx`, `audit_log_actor_idx`) ya están listos para eso.

### 1.2 No hay reembolso de dinero

`void_ticket` anula la boleta y libera el cupo, pero **el pago no se toca**.
`ticket_payments.status` nunca sale de `pending`/`approved`, y `services/wompi.py`
solo tiene `create_payment_link` y `get_transaction`: **no hay reverso**.
Si un cliente pide devolución de una boleta pagada con Wompi, el admin no
puede hacerlo desde la app — ni siquiera marcar el reembolso a mano.

Falta: endpoint de reembolso (Wompi void/refund API) o, como mínimo, marcar
`ticket_payments.status='refunded'` con nota y auditoría. Requiere decisión de
negocio (¿quién asume la comisión?).

### 1.3 No hay pestaña de Lista de espera

`waitlist.py` tiene el ciclo completo (join/status/claim/leave) pero **solo lo
usa el fan** (`WaitlistPage`). El admin no puede ver cuánta gente espera, en
qué orden, ni liberar un lugar a mano cuando alguien cancela por fuera del
sistema. Para un bar con aforo limitado, la lista de espera es demanda
embotellada que hoy es invisible.

### 1.4 No hay gestión de cobros fallidos / pendientes

`PaymentsPanel` **crea** links de pago, pero `list_payments` (que ya existe)
no tiene pantalla. El admin no ve qué cobros quedaron `pending`, cuáles
expirados, ni puede reconciliar un pago que llegó por fuera (transferencia,
efectivo) marcándolo pagado.

### 1.5 No hay vista de "quién está dentro ahora"

Existe `GET /events/{id}/door-snapshot` (lo consume el caché offline del
bouncer) y `scanner-stats`, pero el admin **no tiene una pantalla en vivo de
ocupación** ("312 dentro de 400 aforo"). `DoorPulse` da el ritmo por franja,
que es distinto: mide flujo, no el aforo actual contra el límite.

### 1.6 Exportaciones que existen y no se pueden bajar

- `noshow.csv` — lista de no-shows del evento. **Cero referencias** en el
  frontend.
- `redemptions.csv` — el log escaneo por escaneo. **Cero referencias** en el
  frontend (la única mención de "redemptions" en el front es un comentario).

### 1.7 El logo del negocio no se puede subir

`POST /venues/{id}/media` funciona (lo usa `EventCreateModal` para el flyer),
`PATCH /auth/venues/{id}` acepta `logo_url`, y `VenueHeader` **pinta** el logo.
Pero no hay UI para subirlo: el admin solo puede pegar una URL. `ProfilePage`
edita nombre y comisión, no el logo.

### 1.8 Datos fiscales del negocio sin editar

`venues` tiene `legal_name` y `tax_id` (NIT) pero `PATCH /auth/venues/{id}`
**no los acepta**: no se pueden llenar desde ningún lado. Si la facturación o
los términos legales los necesitan, hoy no hay forma de cargarlos.

---

## 2. Huecos de "hacer de todo": capacidades que no existen

Esto sí es trabajo de backend, no solo un botón.

### 2.1 Roles operativos que el propio diseño anticipa

`08-rbac.md` ya lista los roles que "siempre acaban apareciendo". El de mayor
valor para "control total":

| Rol | Para qué | Falta |
| --- | --- | --- |
| `taquilla` | Venta en puerta con efectivo | Rol + flujo de caja en efectivo (no Wompi) |
| `rrpp` | Cortesías y lista | Rol que emite solo `is_courtesy` |
| `supervisor` | Mira todo, no toca dinero | Read-only de reporte y puerta |
| `scanner_lead` | Jefe de puerta | Bouncer + recontar aforo |

Hoy todo el peso operativo cae en `admin`. No se puede delegar la taquilla sin
dar control total del negocio.

### 2.2 Venta en efectivo

Todo el cobro pasa por Wompi. `EmitTicketPanel` emite con pago, pero **no hay
un camino de "efectivo"** (marcar el pago como recibido en mano). En una barra
en Colombia el efectivo es la norma, no la excepción.

### 2.3 Vista de plataforma para `super_admin`

`super_admin` existe en el enum y en `roles.js`, pero no hay ninguna pantalla
de plataforma: ni listado de venues, ni métricas cross-venue, ni alta de un
negocio nuevo. Hoy un `super_admin` ve el mismo `/admin` de una venue a la vez.
Si el producto es B2B2C multi-venue, falta la consola del dueño del SaaS.

---

## 3. Prioridad sugerida

Ordenado por relación valor/costo. Los tres primeros son UI sobre endpoints
que ya existen y ya están probados.

| # | Qué | Costo | Valor |
| --- | --- | --- | --- |
| 1 | **Auditoría** (`GET /venues/{id}/audit` + pestaña) | Bajo | Alto — es *el* control |
| 2 | Ocupación en vivo ("X dentro de Y aforo") | Bajo | Alto — decisión de puerta |
| 3 | Bajar `noshow.csv` y `redemptions.csv` (botones) | Muy bajo | Medio |
| 4 | Logo del negocio (reusar el upload de `EventCreateModal`) | Bajo | Medio |
| 5 | Pestaña de Lista de espera | Medio | Medio |
| 6 | Cobros pendientes + reconciliación manual | Medio | Alto si hay efectivo |
| 7 | `legal_name` / `tax_id` editables | Muy bajo | Bajo |
| 8 | Reembolso de dinero | Alto | Alto (necesita decisión) |
| 9 | Rol `taquilla` + venta en efectivo | Alto | Alto (desbloquea delegar) |
| 10 | Consola de plataforma `super_admin` | Alto | Alto si hay varias venues |

---

## 4. Notas

- Nada de lo anterior es un bug: son capacidades ausentes. El backend está
  sano (423/423) y el modelo de datos ya soporta casi todo.
- El punto 1 (auditoría) es el que más cambia la sensación de "control":
  convierte acciones ya registradas en algo que el dueño puede leer.
- El punto 9 (taquilla + efectivo) es el que más cambia la operación: hoy no
  se puede delegar la puerta/taquilla sin entregar el negocio entero.
