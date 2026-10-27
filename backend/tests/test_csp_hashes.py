"""La CSP autoriza los <script> inline por sha256, no con 'unsafe-inline'.

Si cambia el HTML inline de index.html (anti-flash de tema, registro del SW)
y no se recalculan los hashes, la CSP los bloquea: el sitio sigue en pie,
pero pierde el anti-flash y el service worker, y el sintoma (un flash claro
al abrir una ruta oscura) es dificil de atar a la cabecera.

Paso en produccion: el hash del script anti-flash era `0l/m51p...` mientras
el real era otro, asi que el candado oscuro pre-paint nunca corria.

La CSP vive duplicada: vercel.json (produccion) y frontend/server.mjs (ruta
Docker/Render). Este test recalcula los hashes del build y exige que ambos
archivos declaren exactamente esos, para que la desincronizacion falle aqui
y no en el navegador.
"""
import hashlib
import base64
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DIST_HTML = ROOT / "frontend" / "dist" / "index.html"
VERCEL = ROOT / "vercel.json"
SERVER_MJS = ROOT / "frontend" / "server.mjs"

# Los <script> sin atributos son los que autoriza la CSP (anti-flash + SW).
INLINE_SCRIPT = re.compile(r"<script>([\s\S]*?)</script>")
HASH = re.compile(r"sha256-[A-Za-z0-9+/=]{44}")


def _dist_hashes() -> set[str]:
    html = DIST_HTML.read_text(encoding="utf-8")
    scripts = INLINE_SCRIPT.findall(html)
    return {
        "sha256-" + base64.b64encode(hashlib.sha256(s.encode("utf-8")).digest()).decode()
        for s in scripts
    }


def _declared_hashes(path: Path) -> set[str]:
    return set(HASH.findall(path.read_text(encoding="utf-8")))


@pytest.mark.skipif(
    not DIST_HTML.exists(),
    reason="Sin build del frontend (correr npm run build antes)",
)
def test_csp_hashes_match_inline_scripts():
    expected = _dist_hashes()
    assert expected, "index.html no tiene <script> inline; el test seria vacuo"
    for path in (VERCEL, SERVER_MJS):
        declared = _declared_hashes(path)
        missing = expected - declared
        stale = declared - expected
        assert not missing, (
            f"{path.name} no autoriza scripts inline reales de index.html "
            f"(la CSP los bloquea): faltan {sorted(missing)}"
        )
        assert not stale, (
            f"{path.name} declara hashes obsoletos que ya no existen en "
            f"index.html: sobran {sorted(stale)}"
        )
