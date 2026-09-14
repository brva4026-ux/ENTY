# 2. Modelo de Datos (PostgreSQL)

> El esquema real ya vive en `db/schema.sql`. Aquí está el modelo conceptual, las
> claves, los estados y las invariantes que lo sostienen.

## 2.1 Diagrama entidad-relación (texto)

```
venues ──< events ──< ticket_types
  │            └──< promoter_allocations ── users (promotor)
  │                    └──< tickets
  │                           └──< redemptions (cada escaneo)
  ▼
venue_user_roles (users ↔ venues con rol)
```

```
┌────────────┐ 1   N ┌────────────┐ 1   N ┌──────────────┐
│ with users │ ─────>│  venues    │──────>│  venue_user_roles
└────────────┘       │ id (PK)    │       │ (venue_id,user_id,role) PK
                     └────────────┘       │
                         1               │
                         │ N             │
                     ┌───▼─────────┐
                     │    events        │
                     │ id (PK)          │── capacity (aforo físico)
                     │ venue_id (FK)    │
                     │ status: draft/published/live/ended/cancelled
                     └───────────┬──────┘
                         1 │     │ N
                     ┌─────▼────────────┐  1    N ┌──────────────────┐
                     │   ticket_types    │ ──────>│ promoter_allocations│
                     │ id (PK)           │        │ (event,type,promoter) │
                     │ quantity (cupo)   │        │ id (PK), capacity │
                     │ price_cents       │        └─────────┬────────┘
                     └─────────┬─────────┘                  │
                              1 │                            │ N
                          ┌────▼────────────────────────────▼────────┐
                          │                  tickets                │
                          │ id (PK)                                  │
                          │ event_id (FK)  /  ticket_type_id (FK)   │
                          │ allocation_id (FK, NULL=venta directa)  │
                          │ token_hash (UNIQUE, sha256 del QR)      │
                          │ status: issued|paid|voided|refunded|redeemed │
                          │ price_cents_snapshot                    │
                          │ customer_name/phone/email               │
                          └───────────────────────┬─────────────────┘
                                                 1 │ N
                          ┌────────────────────────▼───────────────┐
                          │  redemptions (auditoría de escaneos)    │
                          │ id PK, ticket_id FK, scanned_by_user_id │
                          │ outcome: granted/already_redeemed/...  │
                          │ scanned_at                              │
                          └──────────────────────────────────────────┘
```

## 2.2 Tablas y claves (formato tabla)

| Tabla | PK | FKs | Notas |
|---|---|---|---|
| `users` | `id` | — | `email UNIQUE`, `password_hash`, `is_active` |
| `venues` | `id` | — | `slug UNIQUE` (multi-tenant), `currency`, datos fiscales |
| `venue_user_roles` | `(venue_id,user_id,role)` | venue→venues; user→users | enum rol: super_admin/admin/promotor/bouncer |
| `events` | `id` | `venue_id→venues` | `capacity`, `starts_at`, `status` |
| `ticket_types` | `id` | `event_id→events` | `quantity` (cupo por tipo), `price_cents`, `is_courtesy` |
| `promoter_allocations` | `id` | `event_id`, `ticket_type_id`, `promoter_id→users` | `capacity` (canasta del promotor) — `UNIQUE(event,type,promoter)` |
| `tickets` | `id` | `event_id`, `ticket_type_id`, `allocation_id` (nullable), `sold_by_user_id` | `token_hash UNIQUE`, `price_cents_snapshot` (inmutable) |
| `redemptions` | `id` | `ticket_id`, `event_id`, `scanned_by_user_id` (nullable) | Auditoría: **todo** intento de escaneo, incluso fallido |

## 2.3 Estados críticos de una boleta y sus transiciones

```
                    (se paga / se emite)
 issued ───────────────► paid ──────────────► redeemed
  ▲                      │   ▲                  │
  │                      │   │                  │
  └────── voided ◄───────┘   └──── refunded ◄───┤
```

| Estado | Significado | Quién lo setea |
|---|---|---|
| `issued` | Creada (cupo reservado), aún no pagada o cortesía | promotor/venta directa |
| `paid` | Pagada confirmada (webhook pasarela) | webhook Wompi/MP (idempotente) |
| `redeemed` | Ya entró a la puerta (uno y solo uno) | `redeem_ticket` (compare-and-swap) |
| `voided` | Cancelada por admin/promotor; **libera cupo** | admin |
| `refunded` | Devolución monetaria | equipo/cashier |

**Invariantes críticos (verificados en smoke test):**

1. `count(tickets WHERE status NOT IN ('voided','refunded')) <= venue/type capacity`
   por evento, por tipo y por cupo de promotor.
2. `status='redeemed'` solo se alcanza desde `issued|paid`, y **una sola vez**
   (constraint via UPDATE con `WHERE status='issued'` = compare-and-swap).
3. `token_hash` es `SHA-256(token_crudo)` y UNIQUE → el mismo QR no puede
   materializarse dos veces.

## 2.4 Multi-tenant por fila

Se fuerza el aislamiento en la capa de aplicación: cada query del backend inyecta
`WHERE venue_id=$X` derivado del JWT (`backend/app/deps.py` → `ensure_roles`).
El índice compuesto recomendado en eventos: `(venue_id, starts_at DESC)`.