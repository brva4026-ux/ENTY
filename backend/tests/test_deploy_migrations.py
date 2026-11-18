"""deploy.sh migra produccion con una lista escrita a mano.

Ese script aplica a Supabase los archivos de `MIGRATIONS=( ... )`. No usa un
glob: lo que no esta en la lista NO se aplica nunca. Si alguien agrega una
migracion y olvida sumarla, el esquema de produccion queda a medias mientras
el codigo nuevo si se despliega (Vercel auto-despliega el repo en cada push),
y las rutas que usan los objetos nuevos responden 503.

Paso exactamente eso con la 031: `analytics_events` existia en el repo, en
`schema.sql` y en la DB de tests, pero nunca llego a produccion porque
`deploy.sh` no la listaba.

Este test compara la lista contra `db/migrations/*.sql`. Un archivo nuevo
falla aqui (en CI, sin necesidad de Postgres) en vez de en produccion.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "scripts" / "deploy.sh"
MIGRATIONS_DIR = ROOT / "db" / "migrations"


def _listed_migrations() -> list[str]:
    """Nombres de archivo listados en el array MIGRATIONS de deploy.sh."""
    text = DEPLOY.read_text(encoding="utf-8")
    block = re.search(r"^MIGRATIONS=\((.*?)^\)", text, re.M | re.S)
    assert block, "no se encontro el array MIGRATIONS=() en scripts/deploy.sh"
    return re.findall(r"db/migrations/(\S+\.sql)", block.group(1))


def _migration_files() -> list[str]:
    return sorted(p.name for p in MIGRATIONS_DIR.glob("*.sql"))


def test_deploy_lists_every_migration():
    """Ninguna migracion puede quedar fuera de la lista de deploy."""
    listed = set(_listed_migrations())
    on_disk = set(_migration_files())
    missing = sorted(on_disk - listed)
    assert not missing, (
        "estas migraciones existen en db/migrations/ pero deploy.sh no las "
        f"aplica a produccion: {missing}. Sumalas al array MIGRATIONS (todas "
        "son idempotentes: safe re-run)."
    )


def test_deploy_lists_no_ghost_migrations():
    """La lista no puede referenciar archivos que ya no existen."""
    listed = set(_listed_migrations())
    on_disk = set(_migration_files())
    ghosts = sorted(listed - on_disk)
    assert not ghosts, (
        f"deploy.sh lista migraciones que no existen en db/migrations/: {ghosts}"
    )


def test_deploy_applies_migrations_in_order():
    """El orden importa: una migracion no puede correr antes que su base.

    Se comparan por el prefijo numerico, que es el orden de dependencia
    (002 antes que 003, etc.). Un archivo fuera de sitio suele ser un
    conflicto de merge mal resuelto.
    """
    names = _listed_migrations()
    prefixes = [int(m[:3]) for m in names]
    assert prefixes == sorted(prefixes), (
        "las migraciones de deploy.sh no estan en orden ascendente: "
        f"{names}"
    )


# --------------------------------------------------------------------------
# Auto-tests dentro de migraciones: nada de conteos absolutos.
# --------------------------------------------------------------------------
#
# La 046 traia un bloque `DO $$ ... $$` que validaba la poda con un conteo
# ABSOLUTO (`IF v_n <> 1 THEN RAISE`). Correcto en base limpia, pero en
# produccion ya hay filas viejas reales que la poda tambien borra: el conteo
# daba otro numero, el bloque lanzaba TEST_FAIL y abortaba la transaccion. Como
# deploy.sh corre con `set -e`, ese fallo detenia la lista entera (047-051) y
# produccion quedaba con `schema: behind` sin un error de esquema visible.
#
# Un auto-test dentro de una migracion NO puede afirmar cuantos registros se
# borraron en total: eso depende de los datos que ya existan. Debe asertar
# sobre las filas PROPIAS del test (marcadas con un valor unico) o medir el
# delta. Estos tests cierran esa puerta para siempre.

_SELFTEST_RE = re.compile(r"DO\s*\$\$(.*?)\$\$", re.S)

# Variable que recibe el RETORNO de una funcion (`v_n := prune_analytics_events(180)`):
# ese conteo es global por naturaleza (la funcion borra en toda la tabla), asi
# que compararlo contra un literal es el bug de la 046.
_FUNC_ASSIGN_RE = re.compile(r"\b(v_\w+)\s*:=\s*[a-z_]\w*\s*\(", re.I)
# `count(*)` GLOBAL (sin WHERE): cuenta toda la tabla, no las filas del test.
_GLOBAL_COUNT_RE = re.compile(
    r"\bSELECT\s+count\(\*\)\s+INTO\s+(v_\w+)\b(?![^;]*\bWHERE\b)", re.I
)


def _selftest_blocks(sql: str) -> list[str]:
    return _SELFTEST_RE.findall(sql)


def _compares_literal(block: str, var: str) -> bool:
    """¿Se compara `var` contra un literal NUMERICO (no un sanity `>= 0`)?"""
    for m in re.finditer(rf"\bIF\s+{var}\b([^;]*?)([<>]=?)\s*(\d+)", block, re.I):
        op, lit = m.group(2), int(m.group(3))
        # `x < 0` / `x >= 0`: un total nunca es negativo. Valido, no es un
        # conteo absoluto. Todo lo demas (contra 0 o cualquier N) si lo es.
        if op in ("<", "<=", ">=") and lit == 0:
            continue
        if op == ">" and lit == 0:
            continue
        return True
    return False


def test_migrations_selftests_have_no_absolute_count_asserts():
    """Ningun auto-test de migracion puede afirmar un conteo absoluto.

    Ver el comentario de arriba: es exactamente el bug que bloqueo el deploy
    de la 047-051 en produccion. Se detectan dos formas de conteo global:

    * una variable que recibe el retorno de una funcion (`prune_*`), y
    * un `count(*)` sin `WHERE` (toda la tabla).

    Un conteo filtrado por las filas del propio test (p.ej. `WHERE user_id =
    v_user`, o el `ROW_COUNT` de un UPDATE acotado) NO se marca: eso si es
    correcto y es justamente el patron que se pide.
    """
    offenders: list[str] = []
    for path in MIGRATIONS_DIR.glob("*.sql"):
        for block in _selftest_blocks(path.read_text(encoding="utf-8")):
            suspects = set(_FUNC_ASSIGN_RE.findall(block))
            suspects |= set(_GLOBAL_COUNT_RE.findall(block))
            for var in sorted(suspects):
                if _compares_literal(block, var):
                    offenders.append(f"{path.name}: {var}")
    assert not offenders, (
        "estos auto-tests de migracion comparan un conteo GLOBAL contra un "
        "literal; en produccion (con datos reales) el numero no coincide y el "
        "bloque aborta, y con `set -e` detiene las migraciones siguientes. "
        "Aserta sobre las filas propias del test (uuid unico) o mide el delta: "
        + "; ".join(offenders)
    )


