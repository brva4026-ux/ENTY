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
