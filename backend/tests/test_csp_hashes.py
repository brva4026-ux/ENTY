"""La CSP autoriza los <script> inline de index.html por hash sha256.

El anti-flash de tema y el registro del service worker viven inline en
frontend/index.html. La CSP (vercel.json y frontend/server.mjs) los autoriza
por hash, no con 'unsafe-inline'. Si alguien edita ese HTML sin recalcular los
hashes con `node scripts/csp-hashes.mjs`, la CSP bloquea el script en
produccion: el sitio arranca, pero se pierde el anti-flash (parpadeo blanco al
cargar en modo claro) y el service worker.

Paso exactamente eso en el rebrand a Enty: el script anti-flash cambio su color
de tema (#f4f4f5 -> #f2f1f0), el hash cambio, y los hashes de vercel.json y
server.mjs quedaron con el valor viejo. Nada lo detecto. Este test lo detecta.
"""
import base64
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX_HTML = ROOT / "frontend" / "index.html"
VERCEL_JSON = ROOT / "vercel.json"
SERVER_MJS = ROOT / "frontend" / "server.mjs"

_INLINE_SCRIPT = re.compile(r"<script>([\s\S]*?)</script>")
_SHA256_IN_CSP = re.compile(r"'sha256-[^']+'")


def _inline_script_hashes() -> set[str]:
    """Hashes sha256 de los <script> inline (mismo criterio que csp-hashes.mjs)."""
    html = INDEX_HTML.read_text(encoding="utf-8")
    return {
        "sha256-" + base64.b64encode(hashlib.sha256(s.encode()).digest()).decode()
        for s in _INLINE_SCRIPT.findall(html)
    }


def _declared_hashes(path: Path) -> set[str]:
    """Hashes sha256 citados en el texto de un archivo (vercel.json / server.mjs)."""
    return {h.strip("'") for h in _SHA256_IN_CSP.findall(path.read_text(encoding="utf-8"))}


def test_csp_hashes_match_inline_scripts():
    expected = _inline_script_hashes()
    assert expected, "frontend/index.html no tiene <script> inline que autorizar"

    for path in (VERCEL_JSON, SERVER_MJS):
        declared = _declared_hashes(path)
        missing = expected - declared
        assert not missing, (
            f"{path.name} no autoriza todos los <script> inline de index.html. "
            f"Faltan: {', '.join(sorted(missing))}. Recalcula con "
            "`node scripts/csp-hashes.mjs` y actualiza el CSP."
        )
        stale = declared - expected
        assert not stale, (
            f"{path.name} cita hashes que ya no corresponden a ningun <script> "
            f"inline: {', '.join(sorted(stale))}. Recalcula con "
            "`node scripts/csp-hashes.mjs`."
        )
