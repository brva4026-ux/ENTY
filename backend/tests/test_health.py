"""El latido operacional: /health debe reflejar la DB de verdad.

Antes el endpoint respondia ok sin tocar la base: una app con la DB caida
se monitoreaba verde. Ahora un 503 con db=down es la senal temprana.
"""
import pytest


@pytest.fixture()
def health_client(db):
    """TestClient CON lifespan (el pool de la app real) sobre la DB de prueba."""
    import os

    os.environ["DATABASE_URL"] = os.environ.get(
        "TEST_DATABASE_URL",
        "postgres://postgres:devpassword@127.0.0.1:5432/ticketflow",
    )
    os.environ.setdefault("JWT_SECRET", "test-secret")

    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    app = create_app()
    with TestClient(app) as client:
        yield client
    get_settings.cache_clear()


def test_health_ok_with_db(health_client):
    res = health_client.get("/health")
    assert res.status_code == 200, res.text
    d = res.json()
    assert d["status"] == "ok"
    assert d["db"] == "ok"
    assert isinstance(d["db_latency_ms"], int)
    assert "app" in d and "push_enabled" in d and "email_enabled" in d
    # Telemetria nueva: si el esquema esta al dia y si el error tracking
    # esta encendido. Con el lifespan disparado (esta fixture lo hace), el
    # guard ya corrio contra la base de pruebas, que tiene el esquema completo.
    assert d["schema"] == "ok"
    assert d["error_tracking"] is False  # sin SENTRY_DSN en tests


def test_health_db_cache_within_5s(health_client):
    """Segunda llamada dentro de la ventana: no re-ping (caché anti-storm)."""
    r1 = health_client.get("/health")
    r2 = health_client.get("/health")
    assert r1.status_code == r2.status_code == 200
    assert r1.json()["db_latency_ms"] == r2.json()["db_latency_ms"]


def test_health_503_when_db_down(db):
    """DB inalcanzable: 503 con db=down (la senal que el monitor necesita)."""
    import os

    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    os.environ["DATABASE_URL"] = (
        "postgresql://postgres:devpassword@127.0.0.1:59999/inexistente"
    )
    app = create_app()
    try:
        with TestClient(app) as client:
            res = client.get("/health")
    finally:
        os.environ["DATABASE_URL"] = os.environ.get(
            "TEST_DATABASE_URL",
            "postgres://postgres:devpassword@127.0.0.1:5432/ticketflow",
        )
        get_settings.cache_clear()
    assert res.status_code == 503
    d = res.json()
    assert d["db"] == "down"
    assert d["status"] == "degraded"
