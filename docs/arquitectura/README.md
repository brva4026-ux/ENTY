# Arquitectura TicketFlow — Índice

Documentación técnica del comité. Cada tema se ancla al código del repo.

| Doc | Contenido |
|---|---|
| [00-resumen.md](00-resumen.md) | Decisiones núcleo (postgres-fuente-de-verdad, anti-sobreventa en DB, REST, HMAC QR, offline solo bouncer, multi-tenant, infra elástica) |
| [01-arquitectura-sistemas.md](01-arquitectura-sistemas.md) | Stack alta concurrencia, REST vs GraphQL, WebSockets para aforo, fragmentos de la transacción crítica |
| [02-modelo-datos.md](02-modelo-datos.md) | ERD, tablas con FKs, estados de boleta (issued→paid→redeemed/voided/refunded) e invariantes |
| [03-seguridad.md](03-seguridad.md) | QR firma HMAC (no JWT), anti-fraude de reenvío, sesiones del bouncer en dispositivos compartidos, auditoría |
| [04-offline-first.md](04-offline-first.md) | Snapshot firmada, validación local, cola idempotente de sincronización, resolución de conflictos |
| [06-infraestructura.md](06-infraestructura.md) | Infra barata de base, autoscaling de fin de semana, costo mensual estimado |
| [07-plan-pruebas.md](07-plan-pruebas.md) | Niveles de pruebas anti-sobreventa + **resultados reales ejecutados en el repo** |

## Resultados de pruebas ejecutadas (con la infra real local)

| Prueba | Resultado |
|---|---|
| `db/tests/smoke.sql` (5 invariantes funcionales) | ✅ PASA |
| `db/tests/concurrent_overbooking.sh` (10 emisiones vs cupo 3) | ✅ 3 emitidas, 7 rechazadas |
| `backend/tests/test_race_redeem.py` (12 escaneos del mismo QR) | ✅ 1 GRANTED, 11 ALREADY_REDEEMED |

## Cómo se relaciona con el código

- **Esquema + funciones**: `db/schema.sql` (emit_ticket y redeem_ticket).
- **API**: `backend/app/routers/` (auth, events, tickets, report).
- **Auth/roles por tenant**: `backend/app/deps.py`.
- **Frontend 3 roles**: `frontend/src/pages/`.
- **Boleta-imagen**: `backend/app/services/ticket_image.py`.