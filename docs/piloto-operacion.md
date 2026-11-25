# Piloto con público: qué está listo y qué falta

Este documento responde a la lista de 28 exigencias para operar Enty con
público. Distingue tres cosas que no se deben mezclar:

- **Cubierto por código y prueba automatizada:** existe la ruta y CI la
  ejecuta.
- **Cubierto, falta ensayo manual:** el mecanismo existe, pero hay que
  probarlo con teléfonos, red real y las personas que van a operar.
- **Pendiente operativo:** no se resuelve con código; requiere una decisión,
  un respaldo o una prueba de infraestructura.

El criterio de apertura es el que planteó el negocio: resolver un pago
aprobado sin boleta, un QR rechazado en la fila, dos lecturas sin señal del
mismo QR y cerrar con cobros e ingresos que cuadren.

## Veredicto corto

Los cuatro bloqueantes tienen ruta en el producto:

1. **Pago aprobado sin boleta:** Administración lo ve, explica el motivo y
   emite la boleta reutilizando el pago original. El comprador ve el estado y
   tiene un canal de contacto con la organización.
2. **QR rechazado en la fila:** la Puerta recibe el motivo y, si es otra
   localidad, el nombre de la boleta y el acceso correcto. No se consume.
3. **Dos lecturas sin señal del mismo QR:** el mismo teléfono deduplica; dos
   teléfonos distintos quedan reconciliados por la DB al sincronizar: una
   sola entrada.
4. **Cierre de caja:** el resumen del evento muestra cobros aprobados con y
   sin boleta, pendientes, reembolsos y recaudo vigente, y el CSV los repite.

Lo que todavía impide abrir sin reservas no es una pantalla: es el ensayo con
personas, la restauración de un respaldo y el plan de caída. Este documento
incluye el guion para hacerlo.

## Matriz de los 28 puntos

| # | Requisito | Estado | Evidencia / acción |
|---|---|---|---|
| 1 | Ficha pública completa | Cubierto; validar en móvil | `EventDetailPage` muestra fecha, hora, lugar, precio, edad mínima, condiciones y contacto autorizado. |
| 2 | Compra sin cuenta | Cubierto | `FanCheckoutModal` + checkout público; el fan reclama en Mis boletas con su contacto. |
| 3 | Cupo consistente | Cubierto por prueba | `test_concurrent_reservations_cannot_take_same_slot`, `test_ten_concurrent_buyers_one_last_seat`, `test_expired_reservation_releases_inventory`. |
| 4 | Estados de pago claros | Parcial | Pendiente, aprobado, rechazado, expirado y pagado-sin-boleta se muestran. El reembolso se ve en el resumen y en el historial de la boleta, no como estado propio del cobro. |
| 5 | Confirmaciones sin duplicados | Cubierto por prueba | Webhook idempotente y reintento sin segunda boleta en `test_public_checkout.py`. |
| 6 | «Pagué y no recibí mi boleta» | Cubierto; ensayar | Estado visible al comprador, contacto con la organización, cola de resolución en Ventas y `test_admin_resolves_paid_unfulfilled_payment`. |
| 7 | Recuperación del QR | Cubierto | Mis boletas + reemisión con aviso explícito de que el QR anterior deja de funcionar (`TicketQrModal`, `TicketList`). |
| 8 | Anulaciones y devoluciones trazables | Cubierto | Historial por boleta con actor, motivo y estado; auditoría y reembolso en `test_history_shows_void_and_refund_with_actor_and_reason`. |
| 9 | Cierre de caja conciliable | Cubierto; ensayar | Bloque «Cuadre de cierre» en el resumen + CSV. `test_summary_reconciles_payments_and_refunds`. |
| 10 | Historial operativo por boleta | Cubierto | `TicketHistoryModal` y `test_ticket_operational_history.py`. |
| 11 | Fechas y estados fiables | Parcial | Zona horaria del evento, auto-cierre y reapertura tienen prueba. Falta el ensayo panel/ficha/escáner con el mismo evento. |
| 12 | Publicación, apertura y cierre explícitos | Parcial | La UI confirma la acción y espera al servidor. Falta revisar el texto con el equipo en el ensayo. |
| 13 | Cupos por promotor y tipo | Cubierto por prueba | `test_api_allocations`, `test_promoter_workspace`, emisión concurrente. |
| 14 | Comisiones explicables | Cubierto | Liquidaciones con items congelados y detalle por venta (`PayoutsManager`, `promoter_payout_items`). |
| 15 | Validación por acceso | Cubierto por prueba | `WRONG_TYPE` no consume y devuelve tipo real; el código manual usa el mismo endpoint. `test_redeem_with_filter_rejects_other_type_without_consuming`. |
| 16 | Ocupación correcta | Cubierto por prueba | Entrada suma, salida resta, lectura repetida no suma. `test_redemptions_api`, `test_door_grace_and_sync`. |
| 17 | Operación sin señal | Cubierto por prueba; ensayar en teléfonos | Cola IndexedDB, dedupe local, recibo idempotente y reconciliación DB. `test_two_offline_phones_same_qr_only_one_entry`. |
| 18 | Revocación y relevo en Puerta | Cubierto | Dispositivo autorizado por evento, revocación y límites offline documentados en la UI. |
| 19 | Incidencias compartidas | Cubierto | `DoorIncidentsPanel` y router de puerta; la incidencia queda ligada a boleta/evento. |
| 20 | Avisos que llegan | Cubierto por prueba; ensayar dispositivo | Campana y push separados; el interruptor solo queda activo con registro confirmado. |
| 21 | Permisos por organización y evento | Cubierto por prueba | Suite de permisos y aislamiento multi-tenant. |
| 22 | Seguridad de cuenta | Cubierto por prueba | Recuperación, cambio de correo y revocación de sesiones en tests de cuenta. |
| 23 | Privacidad y datos de contacto | Parcial | La ficha pública solo muestra canales publicados. Falta revisar qué exporta cada rol en el ensayo. |
| 24 | Respaldo con restauración probada | Pendiente operativo | Requiere restaurar un backup en un entorno de ensayo y verificar ventas y puerta. No se puede declarar cubierto solo con código. |
| 25 | Monitoreo durante el evento | Parcial | Hay alertas de puerta y aforo. Falta alerta explícita de pagos pendientes acumulados y de puesto que dejó de sincronizar. |
| 26 | Plan para una falla en plena fila | Cubierto por este documento | Ver «Plan de caída». |
| 27 | Prueba de carga y dispositivos reales | Pendiente operativo | Requiere ensayo con volumen, red lenta y los celulares del equipo. |
| 28 | Ensayo completo con tres roles | Pendiente operativo | Guion incluido abajo; debe ejecutarse y firmarse. |

## Los cuatro bloqueantes: cómo se comprueban

Ejecutar desde `backend/`:

```bash
uv run pytest -q \
  tests/test_ticket_operational_history.py::test_admin_resolves_paid_unfulfilled_payment \
  tests/test_ticket_operational_history.py::test_summary_reconciles_payments_and_refunds \
  tests/test_api_noshow_and_type_filter.py::test_redeem_with_filter_rejects_other_type_without_consuming \
  tests/test_door_offline.py::test_two_offline_phones_same_qr_only_one_entry
```

Resultado esperado: cuatro pruebas verdes.

### 1. Pago aprobado sin boleta

- El webhook deja el cobro en `paid_unfulfilled` con `fulfillment_error`.
- El comprador ve «Recibimos tu pago y requiere revisión», la referencia y un
  botón para hablar con la organización.
- Administración lo encuentra en Ventas, ve el motivo y pulsa «Emitir
  boleta». Se reutiliza el mismo cobro; no se cobra dos veces.
- Si se reintenta, devuelve la boleta existente o el mismo error, sin duplicar.

### 2. QR rechazado en la fila

- Una boleta General presentada en VIP devuelve `WRONG_TYPE`.
- La Puerta ve «Indicá el acceso correcto», el tipo real y el acceso de esa
  puerta. La boleta no se consume.
- El código manual entra por el mismo endpoint, así que aplica las mismas
  reglas.
- La incidencia se puede reportar desde el resultado y queda ligada a la
  boleta.

### 3. Dos lecturas sin señal del mismo QR

- El mismo teléfono: la segunda lectura devuelve «Ya está en la cola de
  sincronización» y no encola otra entrada.
- Dos teléfonos distintos: ambos pueden dar verde offline porque cada uno
  tiene una foto distinta. Al reconectar, el primer sync registra la entrada y
  el segundo recibe `ALREADY_REDEEMED`; el conteo suma una sola.
- Un reintento con el mismo `scan_id` no vuelve a canjear.

Limitación que hay que decir en voz alta al equipo: **offline no puede impedir
que dos teléfonos dejen pasar el mismo QR**. Lo que garantiza el sistema es que
la DB lo corrige al sincronizar y que el conteo final no se infla.

### 4. Cierre de caja

El resumen del evento debe mostrar, con la misma ventana de fechas:

- Recaudo vigente y boletas emitidas/ingresadas.
- Cobros aprobados con boleta (cantidad y monto).
- Cobros aprobados sin boleta (cantidad y monto). Si hay alguno, el cierre es
  **provisional** y no se debe conciliar.
- Cobros pendientes.
- Reembolsos (cantidad y monto).

El CSV de cierre repite esos totales. La suma de los movimientos de Ventas
debe explicar cada cifra.

## Plan de caída en plena fila

### Roles y decisión

- **Administración** decide si se sigue admitiendo, se abre una fila manual o
  se detiene la entrada. Es la única voz que autoriza excepciones.
- **Puerta** ejecuta y registra. No inventa estados ni deja pasar «porque
  parece que sí».
- **Promotor** atiende a sus compradores y confirma ventas, pero no autoriza
  excepciones de acceso.

### Si se cae internet

1. Puerta cambia a modo offline solo si descargó el snapshot al inicio del
   turno.
2. Cada escaneo válido se encola y se muestra como «Pendiente de confirmar».
3. Al volver la red, sincronizar y leer el resultado: `granted`,
   `already_redeemed` o rechazado.
4. Si el teléfono no tiene snapshot, no se admite por ese teléfono. Se usa
   otro teléfono preparado o se avisa a Administración.

### Si se daña un teléfono

1. Administración revoca el puesto desde Accesos y genera un link nuevo.
2. El teléfono viejo no puede seguir registrando aunque tenga la cola local.
3. Las entradas que alcanzó a encolar se sincronizan desde el teléfono nuevo
   solo si se pueden exportar; si no, se registran como incidencia y
   Administración decide.

### Si el cobro no se puede comprobar

1. El comprador muestra el comprobante y la referencia.
2. Puerta busca la boleta por número, nombre o teléfono en el historial.
3. Si el pago está aprobado sin boleta, Administración lo resuelve en Ventas.
4. Si no hay pago ni boleta, no se deja entrar; se registra incidencia y se le
   dice al asistente qué debe llevar a la organización.

### Qué se le dice al asistente

- «Su pago está registrado y la organización lo está revisando. No vuelva a
  pagar.»
- «Esta boleta es para otro acceso; indíqueme el acceso correcto.»
- «El sistema no puede confirmar su entrada en este momento. Espere un
  momento o pase a la fila de revisión.»

## Guion de ensayo con tres roles (90 minutos)

Preparar: un evento de prueba publicado, dos localidades (General y VIP), un
teléfono de Administración, dos teléfonos de Puerta y un comprador sin cuenta.

1. **Publicar (10 min).** Administración publica el evento. Verificar en la
   ficha pública fecha, hora, lugar, precio, condiciones y contacto.
2. **Vender (10 min).** El comprador compra sin cuenta desde el link. Verificar
   que llega a la boleta y que puede recuperarla en Mis boletas.
3. **Cupo (5 min).** Abrir dos compras para la última boleta. Solo una debe
   completarse.
4. **Pago sin boleta (15 min).** Forzar un pago aprobado sin emisión (aforo
   lleno o evento cerrado). Verificar el estado del comprador, el aviso a
   Administración y la emisión desde Ventas.
5. **QR rechazado (10 min).** Presentar la boleta General en VIP. Verificar
   instrucción, tipo real y que la boleta no se consumió.
6. **Dos lecturas sin señal (20 min).** Descargar snapshot en dos teléfonos.
   Poner ambos en modo avión. Escanear el mismo QR en los dos. Reconectar y
   sincronizar. Verificar una sola entrada y un `already_redeemed`.
7. **Cerrar y conciliar (15 min).** Finalizar el evento. Verificar que el
   cuadre muestra cobros, pendientes, reembolsos e ingresos; descargar el CSV
   y contrastarlo con Ventas.
8. **Firma (5 min).** Administración, Puerta y Promotor anotan qué falló y qué
   se corrige antes del piloto.

Criterio de aprobación: los cuatro bloqueantes pasan y no queda ningún cobro
aprobado sin boleta al cerrar. Si falla un punto, no se abre al público.

## Pendientes que no se resuelven con código

- Restaurar un respaldo en un entorno de ensayo y verificar ventas y registros
  de puerta.
- Probar con los celulares reales, redes lentas y el volumen esperado.
- Configurar la alerta de pagos pendientes acumulados y de puesto que dejó de
  sincronizar.
- Ejecutar el ensayo completo y firmar el resultado.
