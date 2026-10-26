# V-Pass — Decisión de Arquitectura (Comité Técnico)

> Alcance: diseño técnico completo de una plataforma SaaS B2B2C de boletería y
> aforo. Documento vivo; cada decisión se ancla al código real del repo
> (`db/schema.sql`, `backend/`, `frontend/`).

## 1. Decisiones núcleo (las que no cambian en 3 años)

| # | Decisión | Justificación corta |
|---|----------|---------------------|
| D1 | **PostgreSQL como única fuente de verdad** | Relaciones estrictas (Tenant→Evento→Boleta), transacciones ACID, y bloqueo de fila nativo para anti-sobreventa. No hay caché "de dinero" desincronizada. |
| D2 | **La anti-sobreventa vive en la base, no en la app** | `emit_ticket()` con `SELECT … FOR UPDATE` sobre la fila del cupo/aforo. Dos procesos concurrentes jamás exceden el cupo. Código real: `db/schema.sql`. |
| D3 | **API REST síncrona para operaciones + WebSocket para el aforo en vivo** | REST es suficiente y depurable para emitir/redimir; el único dato "real time" de verdad es el % de aforo. No usamos GraphQL (poca complejidad de grafo, más coste operativo). |
| D4 | **El QR es un token de un solo uso con HMAC, no un JWT con datos** | El QR solo transporta una referencia firma; el estado vive en la DB. Así la boleta es revocable y no filtra datos. |
| D5 | **Offline-first solo en el Bouncer; escritura en línea en el resto** | El bouncer descarga una snapshot firmada y valida localmente; los eventos de redención se encolan y sincronizan con idempotencia (mismo `event_id` de scanner). |
| D6 | **Multi-tenant por fila (`venue_id`) desde el día uno** | Cero trabajo extra al segundo bar; el aislamiento se fuerza en cada query del backend (ver `backend/app/deps.py`). |
| D7 | **Infra tipo *snowflake* localizable por evento/fin de semana** | Un droplet pequeño el lunes y 6 réplicas el sábado a las 10 PM, sin mover código. |

## 2. Recorrido simplificado del MVP actual

```
[Navegador Admin] ---- REST ----> [FastAPI :8000]
[Navegador Promotor] --- REST ----> [FastAPI :8000]
[App Bouncer] --------- REST/WS ---> [FastAPI :8000]
          FastAPI  <--pool psycopg-->  [PostgreSQL (docker :5432)]
          FastAPI  --genera-->  boleta-imagen (Pillow+QR) / wa.me
```

- Frontend React/Vite (SPA) servido en `:12000` con proxy `/api` al backend.
- Auth JWT con claims de venue/roles; verificación del usuario contra DB en cada request.

## 3. Las cuatro trincheras (lo que la gente subestima)

1. **Concurrencia a las 11 PM** — no es “más máquinas”, es **evitar el
   doble-cobro y el doble-ingreso**. Se gana con *row-locks* y compare-and-swap,
   no con más RAM.
2. **Bouncer offline** — es la diferencia entre “fue bonito” y “lo usan”.
   Diseñado con snapshot firmada + cola idempotente.
3. **Fraude QR** — screenshot/reenvío es el fraude #1. Lo detiene la boleta
   *con nombre* (validación humana en puerta) + token único.
4. **Costo** — un bar piloto no paga un cluster de Kubernetes. La infra
   arranca en ~$40/mes y escala de verdad los fines de semana.

## 4. Estado actual del repo vs. esta arquitectura

| Componente | Estado |
|---|---|
| Postgres relacional (tenants, eventos, boletas, redemptions) | ✅ `db/schema.sql` + smoke test |
| Anti-sobreventa transaccional | ✅ `emit_ticket()` con FOR UPDATE |
| Anti-reuso (one-time QR) | ✅ `redeem_ticket()` compare-and-swap |
| API REST (auth, eventos, tickets, reporte) | ✅ `backend/` (FastAPI) |
| Frontend 3 roles | ✅ `frontend/` |
| Pagos (Wompi/Mercado Pago) | ⬜ Fase 2 |
| WebSocket aforo en vivo | ⬜ Pendiente (diseño en §2) |
| Offline-first bouncer (snapshot + cola) | ⬜ Diseñado (docs/arquitectura/05) |
| Autoscaling cloud | ⬜ Diseñado (docs/arquitectura/06) |