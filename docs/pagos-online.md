# Pagos online con Wompi (Etapa 2)

> Diseño aprobado (sep 2026): pasarela **Wompi**, modelo de venta **el bar cobra**
> (MVP). La capa de pagos es provider-agnostic (`payments.provider`), así que
> MercadoPago puede sumarse después sin rehacer nada.

## Por qué Wompi y no MercadoPago

| Criterio | Wompi (elegida) | MercadoPago |
|---|---|---|
| Métodos locales | PSE, **Nequi**, Bancolombia Transfer, tarjetas, Botón Bancolombia | PSE, Nequi, tarjetas, saldo MP |
| Moneda | COP puro | COP sí, plataforma multi-país |
| Crear cobro | `POST /v1/payment_links` con monto fijo + `single_use` + expiración: es literalmente una boleta | Checkout Pro: preference + hosted page, más piezas |
| Webhook | `transaction.updated`, firma SHA256 (checksum + timestamp + secreto), reintentos 30min/3h/24h | Tópico `payment`, firma HMAC `x-signature` (ts, v1) |
| Integración | 1 endpoint de link + 1 webhook, sin SDK | SDK oficial, más tópicos, más superficie |
| Onboarding del bar | Cuenta Wompi Business | App en "Tus integraciones" |

El público de los bares paga con Nequi/PSE/Bancolombia: son nativos en Wompi.

## Principios (mismo espíritu del repo)

1. **El dinero entra primero, el QR después**: la boleta se emite cuando el
   webhook aprueba la transacción, nunca antes.
2. **El webhook no es la única fuente**: cualquier estado se puede verificar
   contra `GET /v1/transactions/{id}` con la llave privada.
3. **Idempotencia por UNIQUE** en la DB: el reintento del webhook (30min/3h/24h)
   no re-emite boletas. La función SQL es idempotente por diseño.
4. **Lógica transaccional en SQL**: los routers traducen parámetros y errores;
   `approve_ticket_payment` decide si se emite.
5. **Auditoría completa**: el payload crudo del webhook queda en `raw_payload`.

## Flujo de venta (el bar cobra)

```
Admin (dashboard)            Wompi                     Invitado
      |                        |                           |
  1. Elige evento+tipo+precio  |                           |
     y datos del comprador     |                           |
  2. POST /payments  ----------+-> POST /v1/payment_links  |
     (guarda pending, guarda   |   (single_use, monto,     |
      payment_link_id)         |    expires_at, redirect)  |
  3. Recibe URL de pago <------+                           |
  4. Se la manda por WhatsApp ------------------------->   |
  5.                        cliente paga (PSE/Nequi/tarjeta)
  6.                    <--- webhook transaction.updated --+
     POST /payments/wompi/webhook                          |
     valida firma SHA256                                   |
     approve_ticket_payment() emite boleta (idempotente)   |
  7. Notifica al admin (mig 012)                           |
  8. El admin reenvía el enlace /t#<token> ----------->    |
```

Nota: en el paso 8, el invitado no recibe el token como texto (convención del
repo): recibe `<origin>/t#<token>`. El admin lo copia desde el dashboard.

## Migración 023 — `ticket_payments`

```sql
CREATE TABLE ticket_payments (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    venue_id          bigint NOT NULL REFERENCES venues(id),
    event_id          bigint NOT NULL REFERENCES events(id),
    ticket_type_id    bigint NOT NULL REFERENCES ticket_types(id),
    -- Referencia NUESTRA, generada por la app: viaja a Wompi y vuelve en el
    -- webhook. Formato: "TF-<evento>-<aleatorio64bits>".
    reference         text NOT NULL UNIQUE,
    provider          text NOT NULL DEFAULT 'wompi' CHECK (provider IN ('wompi')),
    provider_ref      text,              -- payment_link_id de Wompi
    transaction_id    text,              -- id de la transaccion Wompi
    status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','declined','voided','expired')),
    amount_in_cents   bigint NOT NULL CHECK (amount_in_cents > 0),
    customer_name     text NOT NULL,
    customer_phone    text NOT NULL,
    customer_email    text,
    created_by_user_id bigint REFERENCES users(id),
    approved_at       timestamptz,
    ticket_id         bigint UNIQUE REFERENCES tickets(id),
    raw_payload       jsonb,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ticket_payments_event ON ticket_payments(event_id);
CREATE INDEX idx_ticket_payments_tx ON ticket_payments(provider, transaction_id);
```

Cobros de un solo uso: `single_use: true` + `amount_in_cents` fijo +
`expires_at` = fin del evento (o 24h antes). Declinado → cobro muerto: se crea
uno nuevo (no se reutiliza: evita reutilizar referencias).

## Función SQL `approve_ticket_payment(p_reference, p_transaction_id, p_status, p_amount_in_cents, p_payload jsonb)`

- `status = APPROVED`:
  1. `SELECT ... FOR UPDATE` del cobro por `reference`.
  2. **Si ya está `approved` → RETURN sin hacer nada** (idempotencia: reintento
     del webhook).
  3. Si estaba `declined/voided/expired` → excepción `payment_not_approvable`
     (no debería pasar: Wompi no pasa de final a APPROVED, pero si pasa, queda
     auditable y la API lo traduce a 409).
  4. Valida monto: `p_amount_in_cents <> amount_in_cents` → `payment_amount_mismatch`.
  5. `emit_ticket(...)` con el token crudo nuevo (la función lo genera el router
     y entra por parámetro, igual que en emisión normal).
  6. Guarda `transaction_id`, `approved_at`, `ticket_id`, `raw_payload`.
- Otros estados finales (`DECLINED`, `VOIDED`, `ERROR`): guarda estado +
  payload, **no emite**.
- Estados intermedios (ej. `PENDING`): guarda, no emite.

## Endpoints

| Endpoint | Auth | Qué hace |
|---|---|---|
| `POST /venues/{v}/events/{e}/payments` | admin | Crea el cobro: llama a Wompi, guarda `pending` + `provider_ref`, devuelve `payment_url` |
| `GET /venues/{v}/events/{e}/payments` | admin | Lista los cobros del evento (estado, enlace, boleta emitida) |
| `POST /public/events/{e}/checkout` | pública | Checkout del fan (sin cuenta): valida la localidad, crea el cobro con el precio del SERVIDOR y devuelve la URL de Wompi |
| `GET /public/checkout/{reference}` | pública | Estado del checkout propio (para el polling tras volver de Wompi). La `reference` es la capability |
| `POST /payments/wompi/webhook` | pública | Valida firma, llama a `approve_ticket_payment`, responde 200 |

Entrega de la boleta: **sin cambios** — cuando el pago se aprueba, la boleta es una emisión normal: el admin la ve en el listado y reenvía el enlace `/t#<token>`
por el flujo estándar `wa.me`.

### Checkout público del fan (fase siguiente, ya implementado)

El fan compra solo, sin login, desde el detalle del evento (`/evento/:id`). El
flujo **reutiliza entero** el ciclo de la mig 023: crea el link de Wompi y el
webhook emite la boleta al aprobar. Lo único distinto es que no hay sesión:

- `ticket_payments.created_by_user_id` queda **NULL** (no hay usuario).
- La `reference` (`TF-<evento>-<32 hex>`, 128 bits) es la **capability** con la
  que el fan consulta el estado; no se enumeran cobros (una inventada es 404).
- El **contacto** (teléfono obligatorio, correo opcional) es la identidad con
  la que el fan reclama su QR en `/boletas` — el mismo camino auditado de
  siempre. El token del QR **nunca** sale del checkout.
- El monto sale de `ticket_types.price_cents`, **nunca** del cliente; no se
  cobra una cortesía, una localidad inactiva ni un evento en borrador/pasado.
- Rate limit propio y más duro que el del catálogo (20/hora por IP): cada POST
  crea una fila y llama a Wompi con dinero real.
- Tras pagar, Wompi vuelve a `/evento/:id?pago=<reference>`; el modal sondea
  `GET /public/checkout/{reference}` hasta que el webhook resuelva.

## Seguridad

- **Firma del webhook** (según docs de Wompi): checksum = SHA256 de
  `concat(properties values) + timestamp + WOMPI_EVENTS_SECRET`. Las
  `properties` se leen del evento (no se asumen fijas). Rechazo con 403.
- La verificación de montos por referencia en la DB (no confiar en el monto del
  payload para otra cosa que auditar: el monto correcto vive en `ticket_payments`
  y se compara).
- HTTPS obligatorio (Vercel ya lo da), secreto en env vars (nunca en el repo).
- Env vars nuevas: `WOMPI_PRIVATE_KEY` (`prv_test_...` / `prv_prod_...`),
  `WOMPI_EVENTS_SECRET` (`test_events_...` / `prod_events_...`), `WOMPI_ENV`
  (`test`/`prod` → base URL `https://sandbox.wompi.co/v1` vs `https://production.wompi.co/v1`).

## Fuera de alcance: lo que NO hace este MVP

- Sin reembolsos vía API (anulación sigue siendo void + devolución en puerta).
- Sin webhooks de dispersión/payouts a terceros (los payouts del promotor
  siguen por el flujo de mig 010).
- MercadoPago queda para después: `provider` ya está en el modelo.

## Plan de implementación (E3)

1. Mig 023 + consolidación en `schema.sql` + conftest (DROPs).
2. `approve_ticket_payment` en SQL (idempotente) + `test_schema_drift` verde.
3. Router `payments.py`: crear cobro (Wompi API + httpx), listar, webhook con
   firma. Env vars y config en `app/core/config.py`.
4. Frontend: sección "Cobros" en el dashboard del admin (crear + lista con
   estado y enlace copiable).
5. Tests: firma del webhook (válida/inválida), idempotencia (2 webhooks = 1
   boleta), monto incorrecto, declined no emite, ciclo completo con Wompi
   sandbox mockeando la API externa.
