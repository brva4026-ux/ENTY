"""El runtime serverless de Vercel instala SOLO api/requirements.txt.

Si el backend importa un paquete de terceros que no esta en ese archivo, la
funcion no arranca y TODA la API devuelve 500 "FUNCTION_INVOCATION_FAILED"
(incluido /health), porque el import de app.main ocurre antes de cualquier
ruta. Paso exactamente eso al cablear ticket_image.py: qrcode y Pillow
estaban en pyproject.toml pero no en api/requirements.txt.

Este test compara los imports reales del backend contra las dependencias
declaradas para serverless, para que un import nuevo falle aqui y no en
produccion.
"""
import ast
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
APP_DIR = ROOT / "backend" / "app"
REQUIREMENTS = ROOT / "api" / "requirements.txt"

# nombre de import -> nombre del paquete en requirements (cuando difieren)
IMPORT_TO_PACKAGE = {
    "PIL": "Pillow",
    "jwt": "PyJWT",
    "psycopg_pool": "psycopg-pool",
    "pydantic_settings": "pydantic-settings",
    "sentry_sdk": "sentry-sdk",
}


def _third_party_imports() -> set[str]:
    """Modulos de terceros importados en backend/app (los que importan)."""
    stdlib = set(sys.stdlib_module_names)
    found: set[str] = set()
    for path in APP_DIR.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    found.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                # ImportFrom con nivel > 0 es relativo (app.*): se ignora.
                if node.level == 0 and node.module:
                    found.add(node.module.split(".")[0])
    # Los paquetes propios (app, tests) y la stdlib no se declaran.
    return {m for m in found if m not in stdlib and m != "app"}


def _declared_packages() -> set[str]:
    """Nombres de paquete declarados en api/requirements.txt, normalizados."""
    names: set[str] = set()
    for raw in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        # Quita extras ([pil]) y el pin de version (>=, ==, ~=, <, >, !).
        name = line.split(";", 1)[0]
        name = name.split("[", 1)[0]
        for sep in (">=", "==", "~=", "<=", "!=", "<", ">", "="):
            name = name.split(sep, 1)[0]
        name = name.strip().lower()
        if name:
            names.add(name)
    return names


def test_serverless_requirements_declare_every_backend_import():
    declared = _declared_packages()
    missing = []
    for module in sorted(_third_party_imports()):
        package = IMPORT_TO_PACKAGE.get(module, module).lower()
        if package not in declared:
            missing.append(f"{module} -> {package}")
    assert not missing, (
        "El backend importa paquetes que api/requirements.txt no instala; "
        "en Vercel la funcion no arrancaria y la API entera daria 500 "
        f"(FUNCTION_INVOCATION_FAILED). Faltan: {', '.join(missing)}"
    )


@pytest.mark.parametrize("package", ["qrcode[pil]", "Pillow"])
def test_qr_dependencies_are_available_serverless(package):
    """Regresion directa: el QR necesita qrcode y Pillow en serverless."""
    declared = REQUIREMENTS.read_text(encoding="utf-8").lower()
    name = package.split("[", 1)[0].lower()
    assert name in declared, f"{package} falta en api/requirements.txt"
