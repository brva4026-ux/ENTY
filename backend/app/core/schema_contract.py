"""Contrato de esquema: que objetos de la base exige el codigo desplegado.

El problema que resuelve (Ley de Tesler, hallazgo del deploy): `schema.sql` es
la fuente completa de la base y `deploy.sh` aplica las migraciones, pero nada
obliga a que la base de PRODUCCION tenga ya lo que el codigo nuevo usa. El
push a `master` despliega el codigo al instante (Vercel) mientras la migracion
corre aparte, a mano, contra Supabase. Si el codigo llega primero, las rutas
que tocan el objeto nuevo responden 500/503 y nadie se entera.

`test_schema_drift` cubre el drift del REPO (schema.sql vs migraciones). Este
modulo cubre el drift de PRODUCCION (base real vs codigo desplegado): extrae
de `db/schema.sql` la lista de tablas, columnas y funciones que el codigo
espera, y el guard de arranque (`schema_guard`) la verifica contra la base
viva. Un objeto faltante deja de ser un 500 critico en una ruta suelta y pasa
a ser un arranque que se queja con el nombre exacto de la migracion pendiente.

Se parsea el `schema.sql` en vez de mantener una lista a mano: una lista a
mano se desincroniza del esquema (justo el fallo que se quiere evitar). El
parser es deliberadamente conservador —solo reconoce las formas que
`schema.sql` (un `pg_dump --schema-only`) realmente emite— y falla ruidoso si
no encuentra nada, en vez de devolver un contrato vacio que daria todo por
bueno.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

# Ruta del schema consolidado, relativa a este archivo:
#   backend/app/core/schema_contract.py -> <raiz>/db/schema.sql
SCHEMA_PATH = Path(__file__).resolve().parents[3] / "db" / "schema.sql"

_CREATE_TABLE = re.compile(r"^[ \t]*CREATE TABLE public\.(?P<name>\w+)\s*\(", re.M)
_CREATE_FUNCTION = re.compile(
    r"^[ \t]*CREATE FUNCTION public\.(?P<name>\w+)\s*\(", re.M
)

# Palabras que abren una restriccion de tabla en el cuerpo de un CREATE TABLE.
# No son columnas: hay que saltarlas al leer el bloque.
_CONSTRAINT_KEYWORDS = ("CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK")


@dataclass(frozen=True)
class SchemaContract:
    """Objetos que el codigo desplegado espera encontrar en la base."""

    tables: frozenset[str] = field(default_factory=frozenset)
    # tabla -> columnas
    columns: dict[str, frozenset[str]] = field(default_factory=dict)
    functions: frozenset[str] = field(default_factory=frozenset)


def _parse_create_table_columns(body: str) -> frozenset[str]:
    """Nombres de columna del cuerpo de un CREATE TABLE.

    Recorre linea a linea hasta el `);` que cierra la tabla y toma el primer
    token de cada linea que declare una columna. Las lineas de restriccion
    (CONSTRAINT/PRIMARY KEY/...) se saltan. Un token entre comillas dobles
    (una columna con mayusculas o palabra reservada) se conserva sin comillas.
    """
    cols: set[str] = set()
    for raw in body.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith(");") or line == ")":
            break
        if line.upper().startswith(_CONSTRAINT_KEYWORDS):
            continue
        token = line.split(None, 1)[0]
        # Una linea de continuacion (p.ej. un CHECK multilinea) empieza con
        # un caracter que no puede abrir un identificador: se ignora.
        if not token or not (token[0].isalpha() or token[0] == "_"):
            continue
        if token.startswith('"') and token.endswith('"'):
            token = token[1:-1]
        cols.add(token)
    return frozenset(cols)


def parse_schema(text: str) -> SchemaContract:
    """Extrae tablas, columnas y funciones del texto de `schema.sql`."""
    tables: set[str] = set()
    columns: dict[str, frozenset[str]] = {}
    for match in _CREATE_TABLE.finditer(text):
        name = match.group("name")
        tables.add(name)
        # El cuerpo de la tabla va desde el parentesis de apertura hasta el
        # `);` de cierre. Se busca el cierre balanceando parentesis para no
        # cortar en un `)` interno (un DEFAULT con funcion, un CHECK anidado).
        start = match.end()  # justo despues de "("
        depth = 1
        i = start
        while i < len(text) and depth:
            ch = text[i]
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            i += 1
        columns[name] = _parse_create_table_columns(text[start : i - 1])

    functions = {m.group("name") for m in _CREATE_FUNCTION.finditer(text)}

    if not tables:
        raise ValueError(
            "no se parseo ninguna tabla de db/schema.sql: el contrato quedaria "
            "vacio y el guard daria todo por bueno. Revisa el formato del "
            "archivo (se espera `CREATE TABLE public.<nombre> (`)."
        )
    return SchemaContract(
        tables=frozenset(tables),
        columns=columns,
        functions=frozenset(functions),
    )


def load_schema_contract(path: Path | None = None) -> SchemaContract:
    """Contrato leido del `schema.sql` del repo."""
    src = path or SCHEMA_PATH
    return parse_schema(src.read_text(encoding="utf-8"))
