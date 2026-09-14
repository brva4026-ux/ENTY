"""Conexion a PostgreSQL usando psycopg3.

Usamos una unica conexion por request vía dependency `get_db()`, que provee la
transaction. Las funciones criticas del esquema (emit_ticket/redeem_ticket) ya
manejan sus propias transacciones internamente.
"""
from collections.abc import Generator

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.core.config import get_settings

# Pool compartido creado en el lifespan de la app.
pool: AsyncConnectionPool | None = None


async def init_pool(database_url: str, *, min_size: int = 2, max_size: int = 10) -> None:
    global pool
    if pool is None:
        pool = AsyncConnectionPool(
            database_url,
            min_size=min_size,
            max_size=max_size,
            open=False,
            kwargs={
                "row_factory": dict_row,
                "autocommit": True,
                # Requerido detras de PgBouncer en modo transaction (Supabase
                # pooler :6543): los prepared statements de psycopg no
                # sobreviven al pool y fallan con "prepared statement does
                # not exist". Desactivarlos es seguro y sin costo practico.
                "prepare_threshold": 0,
            },
        )
        await pool.open()
        try:
            await pool.wait()  # espera primeras conexiones
        except Exception:
            # Serverless: si la DB no responde al arranque, no tumbar la
            # funcion; cada request reintenta (conexiones perezosas).
            pass


async def close_pool() -> None:
    global pool
    if pool is not None:
        await pool.close()
        pool = None


async def get_db() -> Generator[psycopg.AsyncConnection, None, None]:
    if pool is None:
        # Serverless (Vercel): el lifespan puede no correr antes del primer
        # request; inicializamos el pool de forma perezosa (idempotente).
        await init_pool(get_settings().database_url)
    async with pool.connection() as conn:
        yield conn