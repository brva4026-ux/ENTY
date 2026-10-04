"""El schema.sql es la fuente completa de la base — y este test lo exige.

Contrato: instalar SOLO con db/schema.sql y luego re-ejecutar TODAS las
migraciones debe producir exactamente la misma base (pg_dump identico).
Si alguien agrega db/migrations/021_algo.sql con cambios reales, este test
falla hasta que el cambio se consolide tambien en schema.sql. Asi ninguna
instalacion nueva hereda una base a medias (19 tablas viven hoy en
migraciones; el schema viejo tenia 11 y nadie lo notaba hasta reconstruir).

Es el mismo criterio que conftest usa para armar la DB de pruebas, pero
comparando el ANTES y el DESPUES de las migraciones.

Necesita cliente psql/pg_dump apuntando a un servidor Postgres real (TEST_DATABASE_URL
o el default local). Si no hay cliente o servidor, se salta: no falla en
maquinas sin Postgres (en CI el service container lo garantiza).
"""

import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest
import psycopg
from psycopg import conninfo

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "db" / "schema.sql"
MIGRATIONS_DIR = ROOT / "db" / "migrations"


def _dsn() -> str:
    return os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql://postgres:devpassword@127.0.0.1:5432/ticketflow",
    )


def _client(tool: str) -> str | None:
    """Ruta del binario psql/pg_dump: PATH, o el Postgres portable del repo."""
    found = shutil.which(tool)
    if found:
        return found
    for ext in (".exe", ""):
        candidate = ROOT / ".local" / "pgsql" / "bin" / f"{tool}{ext}"
        if candidate.exists():
            return str(candidate)
    return None


def _run(client: str, dsn: str, *args: str) -> None:
    subprocess.run(
        [client, "--dbname", dsn, "--set", "ON_ERROR_STOP=1", *args],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PGCLIENTENCODING": "UTF8"},
    )


def _dump(client: str, dsn: str) -> str:
    res = subprocess.run(
        [
            client, "--dbname", dsn,
            "--schema-only", "--no-owner", "--no-privileges",
            "--no-comments", "-x",
        ],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PGCLIENTENCODING": "UTF8"},
    )
    # Normalizo finales de linea: psql emite CRLF en Windows y LF en Linux;
    # para Postgres son identicos y no deben enmascarar el drift real. Se
    # ELIMINAN los \r (no se convierten a \n): un CR residual dentro del
    # cuerpo de una funcion no es una linea nueva.
    return res.stdout.replace("\r", "")


@pytest.fixture(scope="module")
def scratch_db():
    """Base desechable en el mismo servidor de pruebas, con el esquema aplicado."""
    psql, pg_dump = _client("psql"), _client("pg_dump")
    if not psql or not pg_dump:
        pytest.skip("psql/pg_dump no disponibles")
    if not SCHEMA.exists():
        pytest.skip("falta db/schema.sql")

    dsn = _dsn()
    parts = conninfo.conninfo_to_dict(dsn)
    parts["dbname"] = "postgres"
    try:
        admin = psycopg.connect(conninfo.make_conninfo(**parts), autocommit=True)
    except psycopg.OperationalError:
        pytest.skip("servidor Postgres de pruebas no disponible")

    name = f"drift_{uuid.uuid4().hex[:10]}"
    admin.execute(f'DROP DATABASE IF EXISTS "{name}"')
    admin.execute(f'CREATE DATABASE "{name}"')
    admin.close()

    scratch = conninfo.make_conninfo(**{**parts, "dbname": name})
    try:
        _run(psql, scratch, "--file", str(SCHEMA))
        yield scratch, psql, pg_dump
    finally:
        with psycopg.connect(
            conninfo.make_conninfo(**parts), autocommit=True
        ) as admin2:
            admin2.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def _canon(dump: str) -> str:
    """Forma canonica del dump: sin \r ni espacios al final, y con las runs
    de lineas vacias colapsadas. Los cuerpos de funciones se guardan con los
    saltos de linea del ARCHIVO que los creo (CRLF en Windows, LF en Linux):
    esa diferencia es cosmica. Los objetos (tablas, columnas, firmas) NO lo
    son, y esos siguen comparandose byte a byte en la misma cadena."""
    lines = [ln.rstrip() for ln in dump.replace("\r", "").split("\n")]
    out: list[str] = []
    for ln in lines:
        # \restrict / \unrestrict: meta-comandos de psql que pg_dump nuevo
        # (17.x) estampa al inicio/fin del dump con un token ALEATORIO por
        # corrida. No son SQL y dos dumps legitimos del mismo esquema nunca
        # coinciden en el token: se excluyen de la comparacion.
        if ln.startswith("\\restrict ") or ln.startswith("\\unrestrict "):
            continue
        if ln or (out and out[-1]):
            out.append(ln)
    return "\n".join(out).strip()


def test_migrations_are_noops_on_fresh_schema(scratch_db):
    """schema.sql + migraciones re-aplicadas == schema.sql solo."""
    scratch, psql, pg_dump = scratch_db
    before = _canon(_dump(pg_dump, scratch))

    migrations = sorted(MIGRATIONS_DIR.glob("*.sql"))
    assert migrations, "no hay migraciones que re-aplicar"
    for mig in migrations:
        _run(psql, scratch, "--file", str(mig))

    after = _canon(_dump(pg_dump, scratch))
    if before != after:
        diff = [
            (a, b)
            for a, b in zip(before.splitlines(), after.splitlines())
            if a != b
        ][:10]
        pytest.fail(
            "LAS MIGRACIONES NO SON NO-OP sobre el schema.sql actual: "
            f"{len(diff)} lineas distintas (primeras: {diff}). "
            f"Si {migrations[-1].name} agrega objetos, consolidalos en "
            "db/schema.sql (aplica schema+migraciones en una base limpia, "
            "pg_dump --schema-only y reemplaza el archivo)."
        )


def test_schema_has_all_live_tables(scratch_db):
    """Las tablas que el backend usa existen tras instalar SOLO schema.sql."""
    scratch, psql, pg_dump = scratch_db
    esperadas = {
        "users", "venue_user_roles", "venues", "staff_invitations", "events",
        "ticket_types", "promoter_allocations", "tickets", "redemptions",
        "push_subscriptions", "promoter_payouts", "ticket_reissues",
        "notifications", "push_outbox", "ticket_contact_edits",
        "login_attempts", "password_reset_tokens", "media", "audit_log",
        "event_staff", "event_access_tokens",
    }
    with psycopg.connect(scratch, autocommit=True) as conn:
        rows = conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname='public'"
        ).fetchall()
    presentes = {r[0] for r in rows}
    faltan = esperadas - presentes
    assert not faltan, f"schema.sql no crea las tablas: {sorted(faltan)}"
