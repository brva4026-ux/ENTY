# Backlog MVP — 3 sprints de 2 semanas (6 semanas)

> Recorte deliberado para validar el flujo crítico sin construir infraestructura
> que aún no page. Cada sprint termina con algo **usable** (que el bar piloto
> pueda tocar). El sprint 1 ya arranca con la base de datos lista
> (`db/schema.sql`, validada con smoke test).

---

## Sprint 1 — "Boleta de todo para uno" (semanas 1–2)

**Meta:** un bar puede crear el evento, asignar cupos a un promotor, y el
promotor puede emitir cortesías **y** boletas de pago (venta directa), con la
boleta lista para enviar por `wa.me`.

### Historias

- [ ] **S1-1 Base de datos** — Aplicar `db/schema.sql` en render/railway (o local).
      DoD: el smoke test `db/tests/smoke.sql` pasa sobre el env real.
- [ ] **S1-2 Auth de usuarios** — Login con email/contraseña + roles
      (super_admin/admin/promotor/bouncer) vía `venue_user_roles`.
      DoD: un usuario no puede ver datos de otra venue.
- [ ] **S1-3 CRUD eventos** — Crear evento con aforo, tipos de boleta, estado.
      DoD: el admin ve su lista y crea 1 evento de prueba.
- [ ] **S1-4 Asignar cupos** — Admin asigna cupo a promotor por tipo.
      DoD: el promotor ve "has usado X de Y".
- [ ] **S1-5 Emitir boleta** — `emit_ticket` expuesto en API + UI del promotor
      (nombre/teléfono/correo). DoD: 2 cortesías + 1 pago emitidos; si el cupo
      se agota, la UI bloquea.
- [ ] **S1-6 Boleta-img** — Componente que pinta flyer + QR (con el token crudo)
      + nombre del asistente. DoD: la imagen se ve bien en un teléfono de gama baja.
- [ ] **S1-7 Envío wa.me** — Botón "enviar por WhatsApp" con link
      `https://wa.me/57...?text=Tu boleta: <URL de la imagen>`. DoD: el link abre
      el chat con el mensaje prellenado.

### Definition of Done del Sprint 1

- [ ] Flujo completo **end-to-end** sin tocar hosting por puntos:
      crear evento → asignar promo → emitir → ver boleta → abrir wa.me.
- [ ] Un **bar piloto** (persona real, no demo) usó el flujo y dejó feedback
      escrito de al menos 3 fricciones.

---

## Sprint 2 — "La puerta no se cae" (semanas 3–4)

**Meta:** escaneo de puerta con UX de una mirada, auditoría de redenciones, y
que el admin vea el reporte en vivo (este es el demo killer).

### Historias

- [ ] **S2-1 API de escaneo** — `redeem_ticket` expuesto; devuelve los códigos
      de la tabla de la sección 3.2 de `docs/flujos-usuario.md`.
      DoD: script de concurrencia (10 threads) arroja apenas 3 `GRANTED` para
      cupo 3 (el smoke test lo verifica).
- [ ] **S2-2 Scanner mobile** — PWA móvil que abre cámara + flash automático,
      escanea y pinta el resultado **en < 1s**. Sin menús extra.
      DoD: en un celular Android se escanean 5 boletas reales en < 10s totales.
- [ ] **S2-3 Registro de redenciones** — `redemptions` poblada en cada escaneo
      (éxito y fallo). DoD: el reporte muestra "validaciones incorrectas =
      screenshots / boletas duplicadas".
- [ ] **S2-4 Reporte en vivo** — Admin ve: emitidas/re dimidas/ pendientes/
      anuladas, desglose por promotor y por tipo, % aforo.
      DoD: los números cuadran contra una consulta SQL manual.
- [ ] **S2-5 Anular boleta** — Admin/promotor puede anular (liberar cupo).
      DoD: anular y re-emitir el mismo cupo funciona; bouncer la ve como ANULADA.

### Definition of Done del Sprint 2

- [ ] En el **evento piloto real** (no demo), el bouncer usó el sistema en puerta
      y registró el tiempo por persona (meta: < 5s).
- [ ] El reporte del admin mostró **cuántos cupos de promotor se usaron y
      cuántas boletas no cuadraron** en el conteo.

---

## Sprint 3 — "Multi-bar sin fracturas" (semanas 5–6)

**Meta:** segundo bar piloto con aislamiento total de datos y la plataforma lista
para cobrar (sin pasarela todavía: la comisión se factura por invoic a mano).

### Historias

- [ ] **S3-1 Onboarding de un bar nuevo** — Alta de venue + administrador del
      segundo bar. DoD: el admin del bar A **no** ve datos del bar B.
- [ ] **S3-2 Tenant check automático** — Middleware que inyecta `venue_id`
      desde el `slug`/`subdominio` en cada query y función.
      DoD: el smoke test de aislamiento (acceder a datos ajenos → 403).
- [ ] **S3-3 Branding mínimo** — Logo + color primario del bar en su equipo
      (dashboard + boleta). DoD: los dos bares se distinguen visualmente.
- [ ] **S3-4 Deploy continuo** — CI/CD a render/railway + bucket de imágenes.
      DoD: `git push main → deploy` sin pasos manuales y sin downtime.
- [ ] **S3-5 Backoffice para cobrar** — Alta de tarifa por bar (mensual + por
      boleto) y generación de invoice quincenal.
      DoD: el admin super puede ver la factura por venue y marcarla pagada.

### Definition of Done del Sprint 3

- [ ] **Dos bares** operando en paralelo con datos aislados.
- [ ] El flujo completo del sprint 1 **repetido** en el bar B (regresión: debe
      tardar minutos, no días).
- [ ] Plataforma lista para vender: tarifas definidas e invoice del mes generada.

---

## Fuera de alcance del MVP (explícitamente)

- Pasarela de pagos (Wompi/MP) y landing pública → **Etapa 2**.
- Liquidación de comisiones a promotores → **Etapa 3** (según el análisis:
  el blueprint saltaba de Etapa 2 a 4; aquí la insertamos).
- App nativa iOS/Android y alertas de aforo (80%/90%) → **Etapa 4** (las
  alertas se pueden hacer con un cron al final del Sprint 3 si sobra tiempo).
- Offline robusto del bouncer → Etapa 4 (en el MVP: lista descargada + cola).

## Criterios de éxito del MVP (para el piloto)

1. **Fuga recuperada:** el conteo de puerta (escaneado) cuadra con el reporte
   del admin dentro de ±2% (comparar con conteo manual).
2. **Velocidad de fila:** tiempo medio por persona < 5s en el evento piloto.
3. **Adopción:** los 3 roles (admin, promotor, bouncer) usan la herramienta en
   el evento real sin recepción por parte del equipo.
4. **Segundo pago:** el bar B (o el mismo bar, segundo evento) **vuelve** a
   usar la plataforma y lo confirma por escrito.

---

## Backlog post-MVP — el ciclo de la boleta personal (estándar DICE)

> Investigación sep-2026 de DICE / Ticketmaster SafeTix / Eventbrite tras
> implementar la activación del QR con ventana (mig 013). Lo que falta para
> completar el modelo DICE: la boleta personal **vuelve** a la plataforma si
> quien la tenía no va, y se la ofrece a quien la espera. Nunca hay reventa
> libre: el anti-scalping es el producto.

### E1 — Devolución de boletas (return de DICE)

**Problema hoy:** la boleta que ya no se usará muere en el teléfono de
alguien. El bar pierde aforo real y el promotor pierde la cara; reenviar el
QR por WhatsApp pone a un desconocido en la lista (la ventana de activación
lo frena, pero no da trazabilidad de quién terminó usando la boleta).

**Modelo DICE:** el fan devuelve la boleta a la plataforma (a precio
original, sin mercado libre); el lugar vuelve al pool y se lo lleva un fan
de la lista de espera (E2).

- [ ] **E1-1 Estado `returned`** — la boleta devuelta muere su token (mismo
      mecanismo que reissue: hash nuevo o anulación del QR), deja de contar
      como activa y LIBERA el cupo del promotor si lo usó. DoD: devolver
      libera el cupo, la boleta no redime ni re-emite, y el historial queda
      auditado (quién devolvió, cuándo).
- [ ] **E1-2 Ventana límite** — configurable por evento: nunca después del
      unlock del QR (una vez activado el QR, la devolución ya es problema de
      puerta: cobija lista). DoD: devolver fuera de ventana rechaza con
      motivo claro en la página del invitado.
- [ ] **E1-3 UI en la boleta pública** — botón "No puedo ir" en
      `/t#<token>` con confirmación (es irreversible) y aviso de que el QR
      muere. Notificación al promotor/admin con el sistema de mig 012.
      DoD: el invitado completa la devolución desde su teléfono sin pasar
      por el promotor.
- [ ] **E1-4 Imagen y QR tras devolver** — el link de WhatsApp sigue
      circulando: la imagen pública pasa a estado "devuelta" (patrón del
      410 de anuladas) en vez de seguir mostrando QR. DoD: el QR de una
      boleta devuelta no se puede volver a generar por ningún canal.

### E2 — Waiting list (lista de espera de DICE)

**Problema hoy:** el evento agotado no captura demanda: la gente pregunta por
WhatsApp y la respuesta es manual ("avísame si se libera algo").

**Modelo DICE:** lista por evento en orden de llegada; al liberarse un
lugar (devolución E1 o liberación manual de aforo), la plataforma lo ofrece
al primero con una ventana corta para reclamarlo (~10 min en DICE); si no
reclama, pasa al siguiente.

- [ ] **E2-1 Modelo de datos** — `event_waitlist (event_id, phone, name,
      position, status, created_at)` con UNIQUE (event_id, phone): el
      teléfono es la identidad, igual que en la boleta — sin cuentas para el
      público. DoD: migración + join idempotente.
- [ ] **E2-2 Unirse desde el link público del evento** — visible solo cuando
      el evento está agotado (o el admin lo abre). DoD: sin login, la
      persona ve su posición ("eres el #3").
- [ ] **E2-3 Oferta con ventana corta** — al liberarse cupo: ofrecer al
      primero (push ya existe, mig 007; WhatsApp es etapa posterior),
      ventana de X minutos, expirar y pasar al siguiente. DoD: simulación
      con 3 en lista — si el #1 no reclama en la ventana, el #2 recibe la
      oferta.
- [ ] **E2-4 Reclamo = emisión nueva** — reclamar emite una boleta NUEVA
      contra el cupo liberado (nunca se re-activa el token devuelto) y
      entrega el enlace por el flujo estándar wa.me. DoD: el invitado nuevo
      entra con su propio QR activado por la ventana de mig 013.

**Dependencias:** E2 depende de E1 (la lista se alimenta de devoluciones).
La pasarela de pagos (Etapa 2) NO es bloqueante: el reclamo se comporta
como cortesía/cupo liberado y el cobro sigue siendo puerta o transferencia,
como hoy.
