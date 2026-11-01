"""La CSP autoriza los <script> inline por hash; si el HTML cambia, hay que recalcularlos.

La cabecera `Content-Security-Policy` vive duplicada en `vercel.json` (produccion)
y en `frontend/server.mjs` (origen estatico), y autoriza los scripts inline de
`frontend/index.html` por hash sha256, sin `'unsafe-inline'`. Si alguien edita el
HTML inline y no actualiza los hashes, la CSP bloquea el script: el sitio sigue
funcionando (React aplica el tema igual), pero se pierde el anti-flash de tema y
el pre-paint de movimiento reducido, y el service worker.

Paso exactamente eso en `bb32a40`: se agrego el bloque de `tf_motion` al script de
tema y nadie recalculo el hash, asi que el script quedo bloqueado en produccion sin
que ningun test lo notara. Este test compara los hashes reales del HTML contra los
declarados en ambas cabeceras, para que la deriva falle aqui y no en produccion.

Recalcular tras tocar el HTML: `node scripts/csp-hashes.mjs`.
"""

import base64
import hashlib
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
INDEX_HTML = ROOT / "frontend" / "index.html"
VERCEL_JSON = ROOT / "vercel.json"
SERVER_MJS = ROOT / "frontend" / "server.mjs"

# <script> sin src: los que la CSP tiene que autorizar por hash. Un
# <script type="application/ld+json"> es un bloque de datos, no ejecutable, y
# script-src no lo bloquea: se excluye a proposito.
INLINE_SCRIPT_RE = re.compile(r"<script(?![^>]*\bsrc=)([^>]*)>(.*?)</script>", re.S)
EXECUTABLE_ATTRS = re.compile(r'type\s*=\s*"(?!application/ld\+json)')


def _inline_hashes() -> set[str]:
    """Hashes sha256 de los <script> inline ejecutables de index.html."""
    html = INDEX_HTML.read_text(encoding="utf-8")
    hashes = set()
    for match in INLINE_SCRIPT_RE.finditer(html):
        attrs, body = match.group(1), match.group(2)
        if attrs.strip() and not EXECUTABLE_ATTRS.search(attrs):
            continue  # data block (ld+json): no lo gobierna script-src
        digest = hashlib.sha256(body.encode("utf-8")).digest()
        hashes.add("sha256-" + base64.b64encode(digest).decode())
    return hashes


def _declared_hashes() -> dict[str, set[str]]:
    """Hashes declarados en cada cabecera CSP, por ubicacion."""
    csp = json.loads(VERCEL_JSON.read_text(encoding="utf-8"))
    vercel_csp = ""
    for block in csp.get("headers", []):
        for header in block.get("headers", []):
            if header.get("key") == "Content-Security-Policy":
                vercel_csp = header.get("value", "")

    server_src = SERVER_MJS.read_text(encoding="utf-8")

    def hashes(text: str) -> set[str]:
        return set(re.findall(r"sha256-[A-Za-z0-9+/=]+", text))

    return {
        "vercel.json": hashes(vercel_csp),
        "frontend/server.mjs": hashes(server_src),
    }


@pytest.mark.parametrize("location", ["vercel.json", "frontend/server.mjs"])
def test_csp_hashes_match_inline_scripts(location: str) -> None:
    real = _inline_hashes()
    declared = _declared_hashes()[location]

    missing = real - declared
    stale = declared - real

    assert not missing, (
        f"{location}: la CSP no autoriza {len(missing)} script(s) inline de "
        f"index.html; la CSP los bloqueara en produccion. Hashes que faltan: "
        f"{sorted(missing)}. Recalcula con `node scripts/csp-hashes.mjs`."
    )
    assert not stale, (
        f"{location}: la CSP declara {len(stale)} hash(es) que ya no corresponden "
        f"a ningun script inline (HTML editado sin recalcular). Hashes obsoletos: "
        f"{sorted(stale)}. Recalcula con `node scripts/csp-hashes.mjs`."
    )
