"""Endurecimiento de producción: nada que sirva al atacante en el deploy.

Dos superficies que existían "por comodidad de desarrollo" y viajaban al
deploy de producción sin que nadie las mirara:

1. `/docs`, `/redoc` y `/openapi.json` describían las 100+ rutas de la API
   (dinero, administración, escáner) a cualquiera que las pidiera. La UI no
   las usa; en producción se apagan.
2. `CORS_ORIGINS` por defecto traía los hosts del dev server (localhost). Un
   origen local permitido en producción es un agujero invisible: en prod la UI
   es same-origin (`/api`), así que CORS no hace falta y el default de dev se
   descarta solo.

Estos tests fijan ese contrato para que no se pierda en un refactor.
"""


def _production_env(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("JWT_SECRET", "x" * 40)


# ---------------------------------------------------------------------------
# CORS: el default de desarrollo no viaja a producción
# ---------------------------------------------------------------------------


def test_cors_drops_dev_origins_in_production(monkeypatch):
    """En producción, los hosts locales se filtran aunque vengan en la lista."""
    _production_env(monkeypatch)
    from app.core.config import get_settings

    get_settings.cache_clear()
    try:
        s = get_settings()
        s.cors_origins = "http://localhost:5173,http://127.0.0.1:3000,https://app.example.com"
        assert s.cors_origins_list == ["https://app.example.com"]
    finally:
        get_settings.cache_clear()


def test_cors_keeps_dev_origins_outside_production(monkeypatch):
    """Fuera de producción el default sigue sirviendo al dev server."""
    monkeypatch.setenv("ENVIRONMENT", "local")
    from app.core.config import get_settings

    get_settings.cache_clear()
    try:
        s = get_settings()
        s.cors_origins = "http://localhost:5173,http://localhost:3000"
        assert s.cors_origins_list == ["http://localhost:5173", "http://localhost:3000"]
    finally:
        get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Documentación interactiva: apagada en producción
# ---------------------------------------------------------------------------


def _client_for(monkeypatch, environment: str):
    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.main import create_app

    monkeypatch.setenv("ENVIRONMENT", environment)
    monkeypatch.setenv("JWT_SECRET", "x" * 40)
    get_settings.cache_clear()
    # Sin `with`: no se dispara el lifespan, así que no se toca la DB. Solo
    # interesa qué rutas registró la app.
    return TestClient(create_app())


def test_api_docs_are_disabled_in_production(monkeypatch):
    try:
        client = _client_for(monkeypatch, "production")
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(path).status_code == 404, path
    finally:
        from app.core.config import get_settings

        get_settings.cache_clear()


def test_api_docs_are_available_in_development(monkeypatch):
    try:
        client = _client_for(monkeypatch, "local")
        assert client.get("/docs").status_code == 200
        assert client.get("/openapi.json").status_code == 200
    finally:
        from app.core.config import get_settings

        get_settings.cache_clear()
