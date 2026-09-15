"""Fixture global de tests: aplica schema.sql + migraciones sobre la DB de prueba.

La DSN viene de TEST_DATABASE_URL (default: la DB local de desarrollo).
Si la DB no está disponible, los tests de negocio se saltan (no fallan)
para no romper flujos que no dependen de la DB.
"""
import os
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[2]
SQL_FILES = [
    ROOT / "db" / "schema.sql",
    ROOT / "db" / "migrations" / "002_lifecycle.sql",
    ROOT / "db" / "migrations" / "003_ops_hardening.sql",
]


def _dsn() -> str:
    return os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql://postgres:devpassword@127.0.0.1:5432/ticketflow",
    )


@pytest.fixture(scope="session")
def db():
    """Conexión admin a la DB de prueba con el esquema limpio aplicado."""
    dsn = _dsn()
    try:
        conn = psycopg.connect(dsn, autocommit=True, row_factory=dict_row)
    except psycopg.OperationalError:
        pytest.skip("DB de prueba no disponible (configura TEST_DATABASE_URL)")

    # Esquema limpio en cada sesión de tests (orden inverso de dependencias)
    conn.execute(
        """
        DROP TABLE IF EXISTS redemptions, tickets, promoter_allocations,
            ticket_types, events, venue_user_roles, venues, users CASCADE;
        DROP TYPE IF EXISTS ticket_status, user_role CASCADE;
        DROP FUNCTION IF EXISTS emit_ticket, redeem_ticket, void_ticket,
            set_event_status, events_check_capacity CASCADE;
        """
    )
    for f in SQL_FILES:
        if not f.exists():
            raise RuntimeError(f"Falta el archivo SQL: {f}")
        conn.execute(f.read_text(encoding="utf-8"))

    yield conn
    conn.close()


@pytest.fixture()
def dbcur(db):
    """Cursor autocommit reutilizable."""
    with db.cursor() as cur:
        yield cur
