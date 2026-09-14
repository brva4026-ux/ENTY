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
            kwargs={"row_factory": dict_row, "autocommit": True},
        )
        await pool.open()
        await pool.wait()  # espera primeras conexiones


async def close_pool() -> None:
    global pool
    if pool is not None:
        await pool.close()
        pool = None


async def get_db() -> Generator[psycopg.AsyncConnection, None, None]:
    if pool is None:
        raise RuntimeError("Pool de conexiones no inicializado")
    async with pool.connection() as conn:
        yield conn