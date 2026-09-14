# 7. Plan de Pruebas Anti-Sobreventa

> El riesgo #1 del negocio es **vender 101 boletas para un aforo de 100** (o
> dejar entrar dos personas con la misma boleta). Este plan está diseñado para
> **disparar** esos casos bajo estrés real, no solo en teoría.

## 7.1 Invariantes que se verifican

| # | Invariante | Query/verificación |
|---|---|---|
| I1 | Emitidas <= cap. del tipo | `count(tickets WHERE event_id,ticket_type_id AND status NOT IN ('voided','refunded')) <= ticket_types.quantity` |
| I2 | Emitidas <= cap. del cupo del promotor | `count(... allocation_id) <= promoter_allocations.capacity` |
| I3 | Emitidas <= aforo del evento | `count(... event_id) <= events.capacity` |
| I4 | Una boleta se redime a lo sumo una vez | `count(redemptions WHERE outcome='granted') <= 1` por ticket |
| I5 | Bajar capacity del evento nunca < emitidas | trigger `events_check_capacity` |

## 7.2 Niveles de prueba

### 7.2.1 Funcional (un solo hilo) — `db/tests/smoke.sql`
Insertar escenario, emitir hasta el cupo, intentar una más (espera exception),
redimir dos veces (espera 2º `ALREADY_REDEEMED`). Ya implementado y pasando.

### 7.2.2 Concurrencia (muchos procesos simultáneos) — este documento

**Escenario:** cupo de promotor = 3. Lanzar **10 emisiones concurrentes**.
Resultado esperado: **exactamente 3 `OK`, 7 `promoter_quota_exceeded`**.

Script de prueba: `db/tests/concurrent_overbooking.sql` + runner en bash
(se ejecuta abajo en §7.4).

```
10 procesos  ──FOR UPDATE sobre el cupo──►  3 entran, 7 rechazados
```

### 7.2.3 Redención concurrente (compare-and-swap)
Se lanza N bouncers sobre la **misma copia del QR**. Resultado esperado:
1 `GRANTED` y N-1 `ALREADY_REDEEMED`.

### 7.2.4 Anti-sobreventa de aforo global
Emitir hasta aforo-1, lanzar 2 compradores simultáneos para la última boleta:
1 `OK`, 1 `event_at_capacity`.

## 7.3 Cómo lo ejecutamos (y lo que comprobamos)

1. Levantar Postgres (docker compose).
2. `psql ... < db/schema.sql`.
3. `psql ... < db/tests/smoke.sql` → todos los `OK`.
4. Correr el script de concurrencia (bash) → validar conteos finales.

## 7.4 Resultado validado hoy (con el Postgres real del repo)

Ambas pruebas críticas se ejecutaron contra PostgreSQL en contenedor Docker y
**pasaron**:

| Prueba | Comando | Resultado |
|---|---|---|
| Sobreventa por concurrencia | `bash db/tests/concurrent_overbooking.sh` (cupo=3, workers=10) | ✅ **3 emitidas, 7 `promoter_quota_exceeded`**, 3 boletas en DB |
| Anti-reuso por carrera | `python backend/tests/test_race_redeem.py` (12 escaneos mismo QR) | ✅ **1 `GRANTED`, 11 `ALREADY_REDEEMED`** |

Estos resultados se obtuvieron con la lógica **real** de la DB (`SELECT FOR
UPDATE` + compare-and-swap), no con mocks.

Para reproducirlos:

```bash
# 1. Sobreventa (DB con schema aplicado)
PSQL="<comando psql>" WORKERS=10 CAPACITY=3 bash db/tests/concurrent_overbooking.sh

# 2. Carrera de redenciones (Postgres en :5433)
. backend/.venv/bin/activate
python backend/tests/test_race_redeem.py
```

## 7.5 Pruebas que deben correr en CI (hooks pre-merge)

```
test:db-schema    # psql -f schema.sql + smoke.sql
test:concurrency  # 10 procesos vs cupo 3 → verificar conteos
test:redeem-race  # 5 escaneos paralelos → 1 granted
test:iso-tenant   # steamUsuario A no ve datos de B (403/empty)
```

## 7.6 Métricas de rendimiento objetivo (noche de evento)

- **Emisión**: p95 < 150ms cuando hay cola.
- **Escaneo online**: p95 < 300ms incluida la comparación CAS.
- **Escaneo offline**: decisión local < 100ms (sin red).
- **Sincronización de 500 redenciones diferidas**: < 5s tras reconectar.