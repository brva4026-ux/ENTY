"""Guard de esquema en el arranque: avisa si la base esta atras del codigo.

Motivacion real (no teorica): el deploy de este repo es en dos carriles. El
push a `master` despliega el codigo YA (Vercel auto-deploy); las migraciones
corren aparte, a mano, contra Supabase (`scripts/deploy.sh`). Nada los obliga a
ir juntos. Cuando el codigo llega primero, el objeto nuevo falta en la base y
las rutas que lo usan revientan con un 500/503 criptico en una ruta suelta
(paso con `users.active_venue_id`, mig 040: solo `PUT /auth/me/active-venue`
fallaba, y sin Sentry nadie lo veia).

Este guard compara el contrato (`schema_contract`) contra la base viva al
arrancar. Si falta algo:

  * registra un WARNING con el nombre EXACTO de lo que falta (tabla/columna/
    funcion) para que el log del arranque diga "migracion pendiente" y no
    "UndefinedColumn";
  * lo reporta a Sentry como mensaje (una vez por proceso), de modo que el
    problema aparezca en el dashboard aunque nadie lea el log;
  * deja el resultado en `/health` (`schema: "ok" | "behind"`).

Decision deliberada: el guard NO impide el arranque. Un arranque abortado en
serverless convierte "una ruta rota" en "toda la API caida", que es peor. El
objetivo es hacer RUIDO, no tumbar el servicio. La excepcion son los tests:
`assert_schema_current` permite exigirlo donde si conviene fallar (CI).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import psycopg
from psycopg.rows import tuple_row

from app.core.observability import capture_message
from app.core.schema_contract import SchemaContract, load_schema_contract

logger = logging.getLogger("ticketflow.schema")


@dataclass(frozen=True)
class SchemaDrift:
    """Objetos del contrato que NO estan en la base viva."""

    tables: tuple[str, ...] = ()
    columns: tuple[str, ...] = ()  # "tabla.columna"
    functions: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return not (self.tables or self.columns or self.functions)

    def summary(self) -> str:
        parts: list[str] = []
        if self.tables:
            parts.append(f"tablas: {', '.join(self.tables)}")
        if self.columns:
            parts.append(f"columnas: {', '.join(self.columns)}")
        if self.functions:
            parts.append(f"funciones: {', '.join(self.functions)}")
        return "; ".join(parts)


def _live_tables(cur: psycopg.Cursor) -> set[str]:
    cur.execute(_TABLES_SQL)
    return {row[0] for row in cur.fetchall()}


def _live_columns(cur: psycopg.Cursor) -> set[tuple[str, str]]:
    cur.execute(_COLUMNS_SQL)
    return {(row[0], row[1]) for row in cur.fetchall()}


def _live_functions(cur: psycopg.Cursor) -> set[str]:
    # El nombre basta para el diagnostico: si la firma cambio, el codigo que
    # la llama falla igual y el nombre en el aviso ya orienta a la migracion.
    cur.execute(_FUNCTIONS_SQL)
    return {row[0] for row in cur.fetchall()}


# Las tres consultas de catalogo, compartidas por la version sync y la async
# (la misma logica no debe vivir dos veces).
_TABLES_SQL = "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
_COLUMNS_SQL = (
    "SELECT table_name, column_name FROM information_schema.columns "
    "WHERE table_schema = 'public'"
)
_FUNCTIONS_SQL = (
    "SELECT DISTINCT p.proname FROM pg_proc p "
    "JOIN pg_namespace n ON n.oid = p.pronamespace "
    "WHERE n.nspname = 'public'"
)


def _diff(
    contract: SchemaContract,
    live_tables: set[str],
    live_columns: set[tuple[str, str]],
    live_functions: set[str],
) -> SchemaDrift:
    """Compara el contrato contra lo que hay en la base. Pura (sin I/O)."""
    missing_tables = sorted(contract.tables - live_tables)
    missing_columns = sorted(
        f"{table}.{column}"
        for table, cols in contract.columns.items()
        for column in cols
        if (table, column) not in live_columns
        # Si la tabla entera falta, sus columnas ya se reportan con la tabla:
        # no se repiten 20 columnas de la misma tabla ausente.
        and table in live_tables
    )
    missing_functions = sorted(contract.functions - live_functions)
    return SchemaDrift(
        tables=tuple(missing_tables),
        columns=tuple(missing_columns),
        functions=tuple(missing_functions),
    )


def check_schema(
    conn: psycopg.Connection, contract: SchemaContract | None = None
) -> SchemaDrift:
    """Compara el contrato contra la base viva (conexion SINCRONA). Solo LEE.

    Fuerza `tuple_row` en el cursor: el llamador puede pasar una conexion con
    otro row_factory (los tests usan dict_row) y aqui solo interesan las
    posiciones, no las claves.
    """
    contract = contract or load_schema_contract()
    with conn.cursor(row_factory=tuple_row) as cur:
        return _diff(
            contract, _live_tables(cur), _live_columns(cur), _live_functions(cur)
        )


async def check_schema_async(
    conn: psycopg.AsyncConnection, contract: SchemaContract | None = None
) -> SchemaDrift:
    """Version async de `check_schema` (la usa `/health`, conexion async)."""
    contract = contract or load_schema_contract()
    async with conn.cursor(row_factory=tuple_row) as cur:
        await cur.execute(_TABLES_SQL)
        live_tables = {row[0] for row in await cur.fetchall()}
        await cur.execute(_COLUMNS_SQL)
        live_columns = {(row[0], row[1]) for row in await cur.fetchall()}
        await cur.execute(_FUNCTIONS_SQL)
        live_functions = {row[0] for row in await cur.fetchall()}
    return _diff(contract, live_tables, live_columns, live_functions)


def verify_schema_at_boot(dsn: str) -> SchemaDrift | None:
    """Corre el guard una vez al arrancar. Nunca levanta: solo avisa.

    Devuelve el drift (aunque sea `ok`) para que `/health` lo exponga, o None
    si no se pudo verificar (sin conexion): un guard que no pudo mirar NO debe
    reportar "ok" ni "behind" —no sabe—, asi que el llamador lo distingue.
    """
    try:
        with psycopg.connect(dsn, connect_timeout=5) as conn:
            drift = check_schema(conn)
    except Exception:  # noqa: BLE001 — un guard jamas debe romper el arranque
        logger.warning("No se pudo verificar el esquema al arrancar", exc_info=True)
        return None

    if drift.ok:
        logger.info("Esquema al dia con el codigo")
        return drift

    detail = drift.summary()
    logger.warning(
        "ESQUEMA ATRASADO respecto al codigo: %s. Hay migraciones sin aplicar "
        "en la base (revisa scripts/deploy.sh y su lista MIGRATIONS). Las rutas "
        "que usen esos objetos responderan 500/503 hasta migrar.",
        detail,
    )
    # A Sentry tambien: el log del arranque en serverless se pierde; el
    # mensaje en el dashboard no.
    capture_message(f"Esquema de produccion atrasado: {detail}", level="error")
    return drift
