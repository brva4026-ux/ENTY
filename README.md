# Enty — Sistema de Boletería y Control de Aforo (MVP)

Plataforma SaaS B2B2C para organizadores de eventos y discotecas: crea eventos,
asigna cupos a promotores, emite boletas con código QR único y valida en puerta
con escaneo atómico anti-reuso y anti-sobreventa.

**Estado:** MVP con API FastAPI, frontend React/Vite y PostgreSQL, desplegado
en Vercel con base de datos en Supabase. Ver `docs/despliegue.md`.

## Desarrollo y comprobaciones

1. Copia `.env.example` a `backend/.env` y configura una base PostgreSQL local y un
   `JWT_SECRET` propio; nunca uses la base de producción para pruebas.
2. Backend: `cd backend`, `python -m pip install -e ".[dev]"`, `python run.py`.
3. Frontend: `cd frontend`, `npm ci`, `npm run dev`. Define
   `VITE_BACKEND_URL=http://127.0.0.1:8001` para el proxy local y agrega
   `http://127.0.0.1:12000,http://localhost:12000` a `CORS_ORIGINS` del backend.
4. Backend: `REQUIRE_TEST_DB=true TEST_DATABASE_URL=<base-desechable> python -m pytest tests/ -q`.
   Esta suite recrea tablas: utiliza exclusivamente una base desechable.
5. Frontend: `npm run build`, `npm run lint:css`, `npm run lint:design`,
   `npm run test:design`; para E2E usa una segunda base local con `IS_DEMO=true`.

La sesión web usa cookie HttpOnly y SameSite; las solicitudes autenticadas
que cambian datos verifican Origin. Los clientes API mantienen soporte Bearer.
El checkout reserva inventario y cupones durante 15 minutos. Un pago confirmado
que llega sin cupo queda visible como «Pagado: revisar entrada o reembolso» y
avisa al organizador; no se muestra una boleta inexistente ni se pide pagar otra vez.

## Estructura

```
db/
  schema.sql          Esquema PostgreSQL: tablas + funciones transaccionales
                      (emit_ticket, redeem_ticket) y triggers anti-sobreventa.
  tests/smoke.sql     Smoke test: valida los 5 invariantes críticos.
docs/
  flujos-usuario.md   Flujos por rol (Admin, Promotor, Bouncer) y UX de puerta.
  backlog-mvp.md      Backlog en 3 sprints de 2 semanas con Definition of Done.
```

## La base de datos

- **Anti-sobreventa:** `emit_ticket()` bloquea la fila del cupo del promotor
  (`SELECT ... FOR UPDATE`) y valida tres techos (cupo del promotor, cupo del
  tipo, aforo del evento) dentro de la misma transacción.
- **Anti-reuso:** `redeem_ticket()` redime con compare-and-swap
  (`UPDATE ... WHERE status='issued'`): dos escaneos simultáneos del mismo QR
  → solo uno gana (`GRANTED`, el otro `ALREADY_REDEEMED`).
- **Tokens hasheados:** solo se guarda `SHA-256(token)`. El token crudo viaja
  exclusivamente en la boleta (QR).
- Cada escaneo (incluso fallido) queda auditado en `redemptions`.

## Correr el esquema y el smoke test

```bash
# 1. Levantar Postgres (requiere Docker)
docker run -d --name ticket-pg \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=tickets -p 5433:5432 \
  postgres:16-alpine

# 2. Aplicar el esquema
docker exec -i ticket-pg psql -U postgres -d tickets < db/schema.sql

# 3. Smoke test (debe terminar en "SMOKE TEST OK")
docker exec -i ticket-pg psql -U postgres -d tickets -f db/tests/smoke.sql
```

Sin Docker: cualquiera de las dos ejecuciones anteriores funciona contra un
PostgreSQL 14+ local con `psql`.

## Próximo paso (ver `docs/backlog-mvp.md`)

- **Sprint 1:** API/backend FastAPI (o Node/NestJS) que exponga `emit_ticket` y
  el CRUD de eventos + UI móvil-reactiva del promotor + boleta-imagen
  (flyer + QR + nombre) + envío `wa.me`.
