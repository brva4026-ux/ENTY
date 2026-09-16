"""Conexion a PostgreSQL usando psycopg3.

Usamos una unica conexion por request vía dependency `get_db()`, que provee la
transaction. Las funciones criticas del esquema (emit_ticket/redeem_ticket) ya
manejan sus propias transacciones internamente.
"""
import os
from collections.abc import Generator

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.core.config import get_settings

# Vercel inyecta VERCEL=1 en las funciones serverless. Ahi NO usamos pool:
# cada invocacion puede correr en un event loop distinto y el proceso se
# congela entre requests; un pool asyncio queda atado al loop que lo creo y
# sus conexiones mueren en el freeze (500 en requests tibios). Una conexion
# efimera por request es barata detras del pooler de Supabase.
_SERVERLESS = os.environ.get("VERCEL") == "1"

_CONNECT_KWARGS = {
    "row_factory": dict_row,
    "autocommit": True,
    # Requerido detras de PgBouncer en modo transaction (Supabase pooler
    # :6543): los prepared statements de psycopg no sobreviven al pool.
    # None los desactiva; 0 los prepara en el primer uso (lo contrario).
    "prepare_threshold": None,
    "connect_timeout": 10,
}

# Pool compartido creado en el lifespan de la app.
pool: AsyncConnectionPool | None = None


async def init_pool(database_url: str, *, min_size: int = 2, max_size: int = 10) -> None:
    global pool
    if pool is not None and not pool.closed:
        return
    if pool is not None:  # pool cerrado/roto: descartar y recrear
        try:
            await pool.close()
        except Exception:
            pass
        pool = None
    pool = AsyncConnectionPool(
        database_url,
        min_size=min_size,
        max_size=max_size,
        # open(wait=False): no bloquea el arranque y NO cierra el pool si la
        # DB no responde todavia; las conexiones se establecen en background y
        # cada request reintenta. Evita el modo "pool cacheado y cerrado".
        open=True,
        kwargs={
            "row_factory": dict_row,
            "autocommit": True,
            # Requerido detras de PgBouncer en modo transaction (Supabase
            # pooler :6543): los prepared statements de psycopg no
            # sobreviven al pool y fallan con "prepared statement does
            # not exist". Desactivarlos es seguro y sin costo practico.
            # None los desactiva; 0 los prepara en el primer uso.
            "prepare_threshold": None,
        },
    )


async def close_pool() -> None:
    global pool
    if pool is not None:
        await pool.close()
        pool = None


async def get_db() -> Generator[psycopg.AsyncConnection, None, None]:
    global pool
    if _SERVERLESS:
        conn = await psycopg.AsyncConnection.connect(
            get_settings().database_url, **_CONNECT_KWARGS
        )
        try:
            yield conn
        finally:
            await conn.close()
        return
    if pool is None or pool.closed:
        # Local: el lifespan puede no correr antes del primer request;
        # inicializamos el pool de forma perezosa (idempotente). Si el pool
        # quedo cerrado (DB caida al arrancar), se recrea.
        await init_pool(get_settings().database_url)
    async with pool.connection() as conn:
        yield conn