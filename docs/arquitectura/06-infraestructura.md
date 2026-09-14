# 6. Infraestructura y Escalabilidad (DevOps)

## 6.1 Principio de costo: "barato los lunes, robusto los sábados"

El presupuesto de un bar piloto no paga un cluster siempre-encendido. Diseñamos
una **forma de arranque base mínima** y escala de verdad el fin de semana.

## 6.2 Arquitectura objetivo (más barata posible y elástica)

```
                    ┌───────────────────────────────────────────────┐
                    │               Cloud (Render / Aws / Railway) │
                    │                                               │
    Usuarios ──HTTPS──>  [CDN: estáticos React/Vite]               │
                           │                                        │
                           ▼                                        │
                    [API FastAPI]  ──pool──>  [PostgreSQL]          │
                    │   │      \               (idem: Managed PG)    │
                    │   │       └─banco de datos persistente         │
                    │   ▼                                           │
              (escala fuera de pico)                                 │
                    [Workers/mensajería: WhatsApp/Email]             │
                    [Cola: Redis/SQS cuando hay pagos]               │
                    └───────────────────────────────────────────────┘
```

### Capa por capa

| Componente | Opción barata (lunes) | Escala (sábado) |
|---|---|---|
| Estáticos SPA | CDN (Render/Netlify) o bucket S3+R2 | idem (CDN aguanta todo) |
| API | 1 instancia small (0.5–1 vCPU) | Autoscaling 1→6 réplicas (Render: autoscaler) |
| Cola/Jobs | in-process (sin cola) | Worker dedicado (Redis/SQS) |
| PostgreSQL | **Managed** (Render/Railway: ~$7–20/mes), p.ej. RAM 1GB | replicación read + PITR; o Neon/Supabase con brancheo |
| Almacenamiento flyers/boletas | S3/Cloudflare R2 | idem |
| Datadog/alerting | in-app / simple | opcional |

> **Por qué Render/Managed PG en vez de montar tu propio Postgres en EC2**:
> ajuste fino de backups/PITR, failover y monitoreo se compran barato y evitan
> un drama operativo a las 11:50 PM del sábado.

## 6.3 Sesiones de pico (estrategia)

1. **El pico no golpea la API igual**: las boletas se venden con horarios /
   lotes (general sale + ventas de promotor), y el escaneo es por turnos.
2. **Read replicas** solo para el reporte (dashboard admin); la escritura
   (`emit/redeem`) siempre a primario → garantiza anti-sobreventa.
3. **Cache en el frontend**: el reporte del admin puede refrescarse cada 2–5s
   (polling) y el WebSocket solo transmite deltas.
4. **Rate limits** en `redeem` y login evitan abusos → protegen la DB bajo pico.

## 6.4 Despliegue (el que ya está en el repo)

- Docker + `docker-compose.yml` local: postgres+backend+frontend. Un comando:
  `docker compose up -d`.
- El `frontend/` ya construye con Node y sirve con `server.mjs` (estático +
  proxy `/api`). Para production se puede reutilizar directo en Render como
  servicio Node con build `npm run build`.
- **CI/CD sugerido**: GitHub Actions para test + build, y despliegue automático
  a Render/Railway en `main`.

## 6.5 Costo mensual estimado (realista, mínimo)

| Ítem | Costo aprox/mes |
|---|---|
| API (1 instancia small en Render) | ~$0–7 |
| PostgreSQL managed (1GB) | ~$7–15 |
| CDN/estáticos (Render free tier o S3) | ~$0 |
| Bucket R2 (flyers) | ~$0 (free tier) |
| WhatsApp API (vía Meta Cloud Al núm verificado) | tarifa por conversación |
| **Total base** | **~$15–25/mes** |
| Fin de semana de evento con autoscaling | incremental pequeño |

## 6.6 Checklist de operación para el gran sábado

- [ ] Pre-escalado: subir réplicas API a 3–6 y revisar `max_connections` de PG.
- [ ] Probar el endpoint de `sync-now` con 100 escaneos diferidos.
- [ ] Backup automático habilitado (PITR).
- [ ] Monitoreo simple: `/health`, latencia p95, errores 5xx alerting.
- [ ] Alertas de aforo 80/90% (WebSocket + webhook Telegram).