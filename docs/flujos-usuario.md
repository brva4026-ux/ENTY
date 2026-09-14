# Flujos de Usuario — MVP (Etapa 0)

> Material de diseño, no documentación de API. Cada flujo describe el **paso a
> paso operativo** que la interfaz debe permitir, con especial énfasis en el
> escaneo de puerta (el momento donde el sistema se gana o se pierde).
> Modelo de datos de referencia: `db/schema.sql`.

---

## 1. Flujo del Admin (Super Admin / Admin del bar)

### 1.1 Crear un evento

1. `Admin > Eventos > Nuevo evento`.
2. Campos: nombre, fecha/hora de apertura (`starts_at`), aforo físico total
   (`events.capacity`), flyer, estado (`draft`).
3. Al guardar, el sistema crea el `event` y permite agregar **tipos de boleta**
   (General $30k, VIP $80k, Cortesía $0).
4. El aforo del evento es un **techo duro**: el trigger
   `events_check_capacity` impide bajarlo por debajo de las boletas ya
   emitidas. La UI debe advertir esto al intentar reducirlo.

**Regla de negocio para la UI:** `capacity` del evento puede ser mayor que la
suma de las cantidades de sus tipos (ej. aforo 800, tipos 500 General + 200
VIP). El tipo que se agota antes es el techo efectivo de esa venta.

### 1.2 Asignar cupos a promotores

1. `Admin > Evento > Promotores > Asignar cupo`.
2. Selecciona promotor, tipo de boleta y cantidad (`promoter_allocations`).
   Ej. "Mariana → Cortesía × 10".
3. Un mismo cupo es la **canasta** de ese promotor: puede usar hasta esa
   cantidad, **no más**, sin importar cuánto "negocie".

**Decision tomada en el esquema:** las boletas de **pago** (General/VIP) no
pasan por cupos de promotor en el MVP (se emiten como venta directa con
`allocation_id = NULL`). Esto simplifica el control de dinero en Etapa 0; la
comisión por promotor sobre pago es la Etapa 3 (*settlement*).

### 1.3 Reporte en vivo

1. `Admin > Evento > Reporte`.
2. Métricas: emitidas totales, redimidas, pendientes, anuladas; desglose por
   **promotor** (cortesías emitidas vs. cupo), por **tipo**, y % de aforo
   ocupado.
3. Fuente de verdad: las funciones expuestas en `db/schema.sql` (contar por
   `status`, no por inventario en memoria).

---

## 2. Flujo del Promotor

### 2.1 Acceso

1. Ingresa a `/panel` con email + contraseña.
2. Ve **solo** sus cupos activos (los asignados por el admin).
3. Ve su proporción: "Has usado 4 de 10 cortesías".

### 2.2 Registrar a un asistente y generar boleta

1. `Promotor > Nuevo asistente`.
2. Campos mínimo viables: **nombre** (obligatorio), teléfono (obligatorio),
   correo (opcional).
3. El sistema:
   - valida el cupo (`emit_ticket` en transacción; bloquea la fila del cupo),
   - genera un **token crudo** de alta entropía (ej.
     `crypto.randomBytes(24).toString('base64url')`),
   - guarda solo su hash SHA-256 (`tickets.token_hash`),
   - devuelve el token + el ID de la boleta para construir la imagen.
4. La boleta física/imagen queda lista para enviar.

### 2.3 Reimpresión / reenvío

El promotor puede **reimprimir** la boleta de un asistente por teléfono:
`boletas?phone=...`. No puede "generar otra": cada boleta es única
(`token_hash` UNIQUE).

**Anti-reenvío (regla de UI):** la boleta muestra el **nombre** del asistente,
y el bouncer lo compara visualmente. Solo se permite una boleta por teléfono
(validación de UI), porque el token nunca se reutiliza.

---

## 3. Flujo del Bouncer (puerta) — el momento crítico

### 3.1 Antes de abrir puertas

1. `Bouncer > Seleccionar evento`.
2. El bouncer descarga el **estado inicial**: lista de boletas emitidas
   (nombre + estado) para consulta rápida y modo offline simple en Etapa 0
   (las redenciones offline se encolan y sincronizan al recuperar red).

### 3.2 Escaneo — UX "una mirada"

Un solo escaneo debe responder **una decisión en < 1 segundo**, con colores y
texto de alto contraste legibles en oscuridad:

| Código | Estado visual | Texto | Acción |
|--------|---------------|-------|--------|
| `GRANTED` | verde + signo ✓ | **ENTRA** (boleta n° + nombre) | cambia a *redeemed* |
| `ALREADY_REDEEMED` | rojo | **YA USADA** | no entra |
| `NOT_FOUND` | rojo | **NO EXISTE** | no entra |
| `INVALID_EVENT` | gris | **OTRO EVENTO** | no entra |
| `EVENT_NOT_LIVE` | gris | **EVENTO CERRADO** | no entra |
| `NOT_VALID` | rojo | **ANULADA** | no entra |

Implementación en el backend: `redeem_ticket(event_id, token, bouncer_user_id)`
(atómico, compare-and-swap). Cada escaneo deja registro en `redemptions` para
auditoría (quién escaneó, cuándo, resultado) — incluso los fallidos.

### 3.3 Consideraciones de puerta (lección del análisis crítico)

- **Brillo de pantalla y foco**: el scanner debe activar la cámara y la luz de
  asistencia (flash) al abrir; nada de menús intermediarios.
- **Velocidad**: el resultado visual debe reaccionar en < 1s desde el escaneo.
- **Offline**: si no hay red, el bouncer usa la lista descargada; la redención
  se marca localmente y se sincroniza al restaurarse la conexión (Etapa 0
  simple; dedicada en Etapa 4).
- **Nombre visible**: la pantalla muestra el nombre del asistente para la
  comparación humana.

---

## 4. Casos de borde que la UI no debe permitir

| Qué | Por qué | Respuesta del sistema |
|-----|---------|-----------------------|
| Promotor emite de una cortesía sin cupo | fuga | `promoter_quota_exceeded` — la UI bloquea y no genera imagen |
| Promotor reemite el mismo teléfono | duplicación | la UI valida duplicados por teléfono; la DB no reutiliza token |
| Bouncer escanea un código que no es boleta | ruido | `NOT_FOUND` — no registra y no deja ver datos internos |
| Admin baja el aforo por debajo de emitidas | sobreventa accidental | trigger lanza `capacity_cannot_be_below_issued` |
| Evento en `draft` y alguien intenta emitir | venta prematura | `event_not_open_for_sales` |

---

## 5. Diagrama mental (secuencia)

```
Admin crea evento + tipos + cupos de promotor
        │
        ▼
Promotor registra asistente  ──►  emit_ticket()  ──►  token crudo + hash en DB
        │                                                      │
        ▼                                                        ▼
Boleta (imagen: flyer + QR + nombre del asistente)        push por wa.me / email
        │
        ▼
Bouncer escanea QR ──►  redeem_ticket() ──►  GRANTED / ALREADY_REDEEMED / ...
        │
        ▼
redemptions (auditoría) + Admin ve reporte en vivo
```