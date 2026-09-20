# 08 — Matriz RBAC (rol × acción)

**Fuente de verdad server-side:** `backend/app/deps.py::ensure_roles` — los
roles se re-verifican en la DB en **cada request** (revocar un rol o desactivar
un usuario aplica al instante, sin esperar la expiración del JWT).
**Fuente de verdad de la navegación (UX):** `frontend/src/lib/roles.js`.

Regla de oro: la UI oculta lo que el rol no puede hacer, pero **la cerradura
siempre es el backend**. Ocultar un menú no es seguridad.

## Roles del enum `user_role`

| Rol | Quién es | Superficie |
| --- | --- | --- |
| `super_admin` | Plataforma (dueño del sistema) | Igual que admin, para todas las venues |
| `admin` | Dueño/gerente del negocio (venue) | `/admin` — gestión completa |
| `promotor` | Vendedor externo con cupo | `/promotor` — vender y ver lo suyo |
| `bouncer` | Portero de puerta | `/bouncer` — solo escáner |

## Matriz por endpoint (server-side)

| Acción | super_admin | admin | promotor | bouncer |
| --- | :-: | :-: | :-: | :-: |
| Emitir boleta (`POST /tickets`) | ✓ | ✓ | ✓ (solo contra su cupo) | ✗ |
| Listar boletas (`GET /tickets`) | ✓ | ✓ (todo el evento) | ✓ (solo las suyas) | ✗ |
| CSV del listado | ✓ | ✓ | ✓ (recorte propio) | ✗ |
| Reemitir boleta | ✓ | ✓ | ✓ (solo las suyas) | ✗ |
| Corregir contacto de boleta | ✓ | ✓ | ✓ (solo las suyas) | ✗ |
| Canjear QR (`redeem`) | ✓ | ✓ | ✗ | ✓ |
| Preview de boleta (público) | — | — | — | — (token = credencial) |
| Reporte del evento (`/report`) | ✓ caja completa | ✓ caja completa | ✓ recortado: ocupación + sus números, **sin caja global ni ventas de colegas** | ✗ 403 |
| Caja e integridad (`/summary`) | ✓ | ✓ | ✗ | ✗ |
| Overview del negocio (`/overview*`) | ✓ | ✓ | ✗ | ✗ |
| Crear/duplicar/editar eventos | ✓ | ✓ | ✗ | ✗ |
| Tipos de boleta y precios | ✓ | ✓ | ✗ | ✗ |
| Cupos de promotor (allocations) | ✓ | ✓ | ✗ (solo lectura de los suyos) | ✗ |
| Liquidaciones: crear/revisar | ✓ | ✓ | ✗ | ✗ |
| Liquidaciones: listar las suyas | — | — | ✓ | ✗ |
| Invitar equipo / aceptar invitación | ✓ | ✓ | ✗ | ✗ |
| Usuarios de la venue | ✓ | ✓ | ✗ | ✗ |
| Reset de contraseña por admin | ✓ | ✓ | ✗ | ✗ |
| Subir media (flyer/logo) | ✓ | ✓ | ✗ | ✗ |
| Push: suscribirse | ✓ | ✓ | ✓ | ✓ |
| Exportar CSV (cualquiera) | ✓ | ✓ | ✓ recortado | ✗ — **queda auditado** |

## Ámbito de datos (lo que ve cada rol)

- **Promotor**: sus boletas, sus cupos, sus liquidaciones. Del evento ve
  ocupación y "ingresos del evento"; jamás recaudo global ni desglose de
  otros promotores (`report.py` lo recorta server-side — no basta con que la
  UI no lo pinte).
- **Puerta**: nada de dinero, nada de listas de venta. Solo el escáner del
  evento que tiene seleccionado y el log local de su dispositivo.
- **Admin**: todo lo de su venue. `super_admin` lo mismo en todas.

## Superficies por rol (frontend)

| Ruta | Guard | Layout | Chunk |
| --- | --- | --- | --- |
| `/admin` | `RequireRole admin` | Layout con nav | solo baja si eres admin |
| `/promotor` | `RequireRole promotor` | Layout con nav | solo baja si eres promotor |
| `/bouncer` | `RequireRole bouncer` | **sin nav — kiosco** | solo baja si eres portero |

- El promotor no ve menús de admin y la puerta no ve informes: no es solo que
  la UI los esconda — son **rutas y chunks distintos**.
- `/bouncer` corre en **modo kiosco**: pantalla completa, sin navegación.
  "Salir" y el selector de evento viven tras un desbloqueo de mantener
  presionado 1.5 s (un toque accidental no saca a nadie del escáner en plena
  fila — patrón de los puntos de venta).

## Roles secundarios (futuro)

Siempre acaban apareciendo. Diseñados para caber sin romper el modelo: son
nuevos valores del enum `user_role` + una columna más en esta matriz; la
infraestructura (ensure_roles, auditoría, scope por venue) no cambia.

| Rol | Para qué | Cómo se implementa | Prioridad |
| --- | --- | --- | --- |
| `taquilla` | Venta en puerta física (efectivo) | Emite boletas pero no ve caja ni reports; como promotor sin cupo, o con cupo "abierto" (NULL = sin tope). Requiere decisión: ¿cupo ilimitado auditado? | 🟡 después de validar el flujo actual |
| `rrpp` | Invitaciones/cortesías y lista | Emite solo cortesías (`is_courtesy`) y ve el conteo de la lista; sin dinero | 🟡 media |
| `supervisor` | Mira todo, no toca dinero | Read-only del `/report` y de la puerta (accesos en vivo), sin emitir ni editar | 🟢 baja |
| `scanner_lead` | Jefe de puerta | Lo del bouncer + recontar el evento (cuántos dentro) | 🟢 baja |

Regla para agregarlos: **más roles ≠ más permisos heredados**; cada rol
aparece en la matriz con sus celdas propias, y `ensure_roles` sigue siendo
deny-by-default.
