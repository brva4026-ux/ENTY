"""El vigilante de latencia: una request lenta deja rastro, una normal no.

"El usuario siente lento" no se puede arreglar sin saber QUE endpoint lo causa.
El middleware `latency_watchdog` (main.py) loguea y —si hay Sentry— reporta toda
request que pase de `SLOW_REQUEST_MS`. Este test fija el contrato: el umbral es
configurable, /health queda excluido (lo sondean los monitores) y las requests
por debajo del umbral no ensucian el log.
"""
import logging
import os


def _client_with(monkeypatch, slow_ms: float):
    os.environ["DATABASE_URL"] = os.environ.get(
        "TEST_DATABASE_URL",
        "postgres://postgres:devpassword@127.0.0.1:5432/ticketflow",
    )
    os.environ.setdefault("JWT_SECRET", "test-secret")
    monkeypatch.setenv("SLOW_REQUEST_MS", str(slow_ms))

    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    app = create_app()

    # Ruta propia y controlada: no depende de la DB ni de rutas de negocio.
    @app.get("/__probe")
    async def probe():
        return {"ok": True}

    return TestClient(app)


def test_request_lenta_deja_rastro(monkeypatch, caplog):
    # Umbral negativo: TODA request cuenta como lenta (determinista, sin sleeps).
    client = _client_with(monkeypatch, -1)
    with caplog.at_level(logging.WARNING, logger="ticketflow.main"):
        res = client.get("/__probe")
    assert res.status_code == 200
    assert any(
        "request lenta" in r.message and "/__probe" in r.message
        for r in caplog.records
    ), caplog.text


def test_request_rapida_no_ensucia_el_log(monkeypatch, caplog):
    client = _client_with(monkeypatch, 10_000)
    with caplog.at_level(logging.WARNING, logger="ticketflow.main"):
        res = client.get("/__probe")
    assert res.status_code == 200
    assert not any("request lenta" in r.message for r in caplog.records)


def test_health_nunca_cuenta_como_lenta(monkeypatch, caplog):
    # /health lo sondean los monitores cada pocos segundos: reportarlo seria
    # ruido puro. Con umbral negativo, si NO se excluyera, apareceria.
    client = _client_with(monkeypatch, -1)
    with caplog.at_level(logging.WARNING, logger="ticketflow.main"):
        client.get("/health")
    assert not any(
        "request lenta" in r.message and "/health" in r.message
        for r in caplog.records
    )
