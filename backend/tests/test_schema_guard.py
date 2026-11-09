"""El guard de esquema: el contrato se parsea bien y detecta el drift real.

Contexto (Ley de Tesler, hallazgo del deploy): el codigo llega a produccion por
un carril (push a master -> Vercel) y las migraciones por otro (deploy.sh a
mano). Si el codigo va primero, el objeto nuevo falta y las rutas revientan con
un 500 silencioso. Este guard hace ruidoso ese estado.

Estos tests fijan las dos mitades:
  1. el PARSER saca el contrato correcto del schema.sql (una tabla, sus
     columnas, una funcion), y
  2. el CHECK contra una base viva reporta lo que falta y da ok cuando esta
     completo (se simula el drift dropeando una columna en una base desechable).
"""
import os
import uuid

import psycopg
import pytest
from psycopg import conninfo

from app.core.schema_contract import load_schema_contract, parse_schema
from app.core.schema_guard import check_schema


# ---------------------------------------------------------------------------
# Parser del contrato (no necesita DB)
# ---------------------------------------------------------------------------
def test_parse_schema_reads_tables_columns_and_functions():
    contract = parse_schema(
        """
        CREATE TABLE public.widgets (
            id bigint NOT NULL,
            name text,
            owner_id bigint,
            CONSTRAINT widgets_name_check CHECK ((length(name) > 0))
        );

        CREATE FUNCTION public.make_widget(p_name text) RETURNS bigint
            LANGUAGE sql AS $$ SELECT 1 $$;
        """
    )
    assert contract.tables == frozenset({"widgets"})
    assert contract.columns["widgets"] == frozenset({"id", "name", "owner_id"})
    assert contract.functions == frozenset({"make_widget"})


def test_parse_schema_skips_constraint_lines_but_keeps_columns():
    """Una linea CONSTRAINT/PRIMARY/UNIQUE no debe contar como columna."""
    contract = parse_schema(
        """
        CREATE TABLE public.things (
            id bigint NOT NULL,
            a text,
            b text,
            PRIMARY KEY (id),
            UNIQUE (a, b),
            CONSTRAINT things_fk FOREIGN KEY (id) REFERENCES things(id)
        );
        """
    )
    assert contract.columns["things"] == frozenset({"id", "a", "b"})


def test_parse_schema_handles_nested_parens_in_column_defaults():
    """Un `)` dentro de un DEFAULT/CHECK anidado no debe cortar la tabla."""
    contract = parse_schema(
        """
        CREATE TABLE public.events (
            id bigint NOT NULL,
            status text DEFAULT 'draft'::text NOT NULL,
            CONSTRAINT events_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'live'::text])))
        );
        """
    )
    assert contract.columns["events"] == frozenset({"id", "status"})


def test_parse_schema_fails_loud_on_unrecognized_format():
    """Si no reconoce ninguna tabla, debe fallar (no dar un contrato vacio)."""
    with pytest.raises(ValueError):
        parse_schema("-- schema vacio, sin CREATE TABLE\nSELECT 1;\n")


def test_real_schema_contract_is_populated():
    """El schema.sql real produce un contrato con las piezas clave."""
    contract = load_schema_contract()
    assert "users" in contract.tables
    assert "venues" in contract.tables
    # La columna de la mig 040 (el hallazgo que motivo el guard) esta en el
    # contrato: si un dia se saca del schema, el guard dejaria de protegerla.
    assert "active_venue_id" in contract.columns["users"]
    assert "emit_ticket" in contract.functions
    # Un contrato con pocas funciones seria sintoma de un parser roto.
    assert len(contract.functions) > 20


# ---------------------------------------------------------------------------
# Check contra una base viva (drift simulado en una base desechable)
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def scratch():
    """Base desechable con schema.sql aplicado, para simular drift sin tocar
    la base compartida de la suite. Se crea y se borra por modulo."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    schema = root / "db" / "schema.sql"
    dsn = os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql://postgres:devpassword@127.0.0.1:5432/ticketflow",
    )
    parts = conninfo.conninfo_to_dict(dsn)
    parts["dbname"] = "postgres"
    try:
        admin = psycopg.connect(
            conninfo.make_conninfo(**parts), autocommit=True
        )
    except psycopg.OperationalError:
        pytest.skip("servidor Postgres de pruebas no disponible")

    name = f"guard_{uuid.uuid4().hex[:10]}"
    admin.execute(f'DROP DATABASE IF EXISTS "{name}"')
    admin.execute(f'CREATE DATABASE "{name}"')
    admin.close()

    scratch_dsn = conninfo.make_conninfo(**{**parts, "dbname": name})
    with psycopg.connect(scratch_dsn, autocommit=True) as conn:
        conn.execute(schema.read_text(encoding="utf-8"))
    try:
        yield scratch_dsn
    finally:
        with psycopg.connect(
            conninfo.make_conninfo(**parts), autocommit=True
        ) as admin2:
            admin2.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def test_check_schema_ok_on_complete_database(scratch):
    with psycopg.connect(scratch) as conn:
        drift = check_schema(conn)
    assert drift.ok, f"drift inesperado en la base de pruebas: {drift.summary()}"


def test_check_schema_detects_missing_column(scratch):
    """Dropear una columna del contrato debe reportarla como faltante.

    Se dropea una columna que el contrato conoce (avatar_url, mig 038) y el
    guard debe verla ausente. La base es desechable: la columna se restaura
    re-aplicando schema.sql al final, para no ensuciar el siguiente test del
    modulo.
    """
    with psycopg.connect(scratch, autocommit=True) as conn:
        conn.execute("ALTER TABLE users DROP COLUMN IF EXISTS avatar_url")
        try:
            drift = check_schema(conn)
        finally:
            conn.execute("ALTER TABLE users ADD COLUMN avatar_url text")

    assert not drift.ok
    assert "users.avatar_url" in drift.columns
    # Y no debe inflar el reporte con columnas de tablas presentes.
    assert drift.tables == ()
