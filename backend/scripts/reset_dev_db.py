#!/usr/bin/env python
"""Recrea la base de DESARROLLO y vuelve a sembrar los datos demo.

Por que existe
--------------

La suite E2E no es idempotente: crea eventos reales (`E2E-*`) y los compra. Y
`pytest` usa la MISMA base que los E2E (el DSN sale de `TEST_DATABASE_URL`, con
default a la base de desarrollo), asi que cada corrida siembra eventos de
fixture (`Evento de prueba`, `Puerta grace`, `Embudo *`...). En una sesion la
base llego a **331 eventos de 16 patrones distintos**.

Eso rompe specs que no tienen nada que ver con el cambio en curso:

- `/inicio` pide `/public/events`, que devuelve como maximo 50 eventos por
  fecha. Con la base sucia, el evento del seed queda fuera de esa pagina y
  `fan.spec.js` falla con "element(s) not found" aunque su ancla por nombre sea
  correcta.
- Los logins chocan con el lockout de `login_attempts` (8 fallos en 15 min por
  identificador e IP) y el 9.o intento devuelve 429.

Borrar por nombre no alcanza: cada spec nueva aporta su propio nombre. Este
script hace lo unico que funciona: tirar el esquema y reconstruirlo como lo hace
el job `e2e` de CI (`db/schema.sql` + las migraciones), y sembrar de nuevo.

Uso
---

    .venv/bin/python scripts/reset_dev_db.py

Se corre desde `backend/`. Es DESTRUCTIVO y solo para desarrollo: no lo apuntes
a produccion ni a staging. La base destino sale de `DATABASE_URL` (el mismo
default que `app/core/config.py`).
"""

import asyncio
import os
import pathlib
import sys

import psycopg
from psycopg.rows import dict_row

ROOT = pathlib.Path(__file__).resolve().parents[2]
DSN = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:devpassword@127.0.0.1:5432/ticketflow"
)

# Guardarrail: si alguien exporta una base remota, esto no corre.
if not any(h in DSN for h in ("127.0.0.1", "localhost", "@postgres:")):
    print(f"ABORTADO: {DSN} no parece una base local.", file=sys.stderr)
    sys.exit(1)


def rebuild_schema() -> int:
    """Tira `public` y reaplica schema.sql + migraciones, en orden."""
    files = [ROOT / "db" / "schema.sql"] + sorted(
        (ROOT / "db" / "migrations").glob("*.sql")
    )
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("DROP SCHEMA public CASCADE")
        conn.execute("CREATE SCHEMA public")
        for f in files:
            conn.execute(f.read_text())
    return len(files)


async def reseed() -> dict:
    """Vuelve a sembrar los datos demo y limpia el lockout."""
    # El import va aca: necesita el paquete `app`, y el script se corre desde
    # `backend/`.
    sys.path.insert(0, str(ROOT / "backend"))
    from app.routers.seed import seed_demo_data

    async with await psycopg.AsyncConnection.connect(DSN, row_factory=dict_row) as db:
        result = await seed_demo_data(db)
        # El lockout es la otra mitad del problema: sin esto, el primer login de
        # los E2E puede responder 429 por intentos de una corrida anterior.
        await db.execute("DELETE FROM login_attempts")
        await db.commit()
        return result


def main() -> None:
    n = rebuild_schema()
    print(f"Esquema recreado: {n} archivos aplicados.")
    result = asyncio.run(reseed())
    print(f"Seed demo listo (venue {result['venue_id']}, evento {result['event_id']}).")
    print("Lockout de login limpio.")


if __name__ == "__main__":
    main()
