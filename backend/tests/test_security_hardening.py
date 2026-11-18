"""Endurecimiento de seguridad: detección de producción y controles nuevos.

Cubre lo que se agregó en la revisión a fondo:

- **Detección de producción automática en Vercel.** Depender de que alguien
  escriba `ENVIRONMENT=production` a mano en el dashboard es un modo de fallo
  silencioso: si se olvida, la app arranca con la postura de desarrollo
  (cookies sin `Secure`, CORS de localhost, /docs y /openapi.json públicos).
  `VERCEL_ENV=production` (que Vercel inyecta sola) debe activar lo mismo.
- **Cookie `Secure`** en producción.
- **HSTS y CSP** en las respuestas de la API (la función serverless es un
  origen aparte y no hereda los headers de vercel.json).
- **Firma real (magic bytes)** de las imágenes subidas, no solo el mime que
  declara el cliente.
- **Registro de actividad sospechosa**: credenciales fallidas y origen cruzado
  rechazado (posible CSRF) quedan en el log en un formato buscable.
"""

import logging

import pytest

# ---------------------------------------------------------------------------
# Detección de producción: VERCEL_ENV, no solo ENVIRONMENT
# ---------------------------------------------------------------------------


def test_vercel_production_env_activates_production_posture(monkeypatch):
    """VERCEL_ENV=production basta: no hace falta ENVIRONMENT a mano."""
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.setenv("JWT_SECRET", "x" * 40)

    from app.core.config import get_settings

    get_settings.cache_clear()
    try:
        settings = get_settings()
        assert settings.environment == "local"  # el default del código
        assert settings.is_production is True  # pero el entorno real manda
    finally:
        get_settings.cache_clear()


def test_vercel_preview_is_not_production(monkeypatch):
    """Un preview de Vercel NO es producción (no endurece de más)."""
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.setenv("VERCEL_ENV", "preview")

    from app.core.config import get_settings

    get_settings.cache_clear()
    try:
        assert get_settings().is_production is False
    finally:
        get_settings.cache_clear()


def test_environment_production_still_works_without_vercel(monkeypatch):
    """Render/Docker: sin señales de Vercel, ENVIRONMENT decide."""
    monkeypatch.delenv("VERCEL_ENV", raising=False)
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("JWT_SECRET", "x" * 40)

    from app.core.config import get_settings

    get_settings.cache_clear()
    try:
        assert get_settings().is_production is True
    finally:
        get_settings.cache_clear()


def test_vercel_prod_without_jwt_secret_refuses_to_boot(monkeypatch):
    """En el prod de Vercel, un JWT_SECRET ausente no debe pasar en silencio."""
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.setenv("JWT_SECRET", "")

    from app.core.config import get_settings

    get_settings.cache_clear()
    try:
        with pytest.raises(ValueError, match="JWT_SECRET"):
            get_settings()
    finally:
        get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Cookie Secure en producción
# ---------------------------------------------------------------------------


def test_session_cookie_is_secure_in_production(monkeypatch):
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.setenv("JWT_SECRET", "x" * 40)

    from fastapi import Response

    from app.core.config import get_settings
    from app.core.session import set_session_cookie

    get_settings.cache_clear()
    try:
        response = Response()
        set_session_cookie(response, "un-token-de-prueba")
        cookie = response.headers["set-cookie"].lower()
        assert "secure" in cookie
        assert "httponly" in cookie
        assert "samesite=lax" in cookie
    finally:
        get_settings.cache_clear()


def test_session_cookie_is_not_secure_in_local(monkeypatch):
    """En local http:// la cookie Secure nunca se enviaría: debe ir sin ella."""
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("VERCEL_ENV", raising=False)
    monkeypatch.delenv("VERCEL", raising=False)

    from fastapi import Response

    from app.core.config import get_settings
    from app.core.session import set_session_cookie

    get_settings.cache_clear()
    try:
        response = Response()
        set_session_cookie(response, "un-token-de-prueba")
        assert "secure" not in response.headers["set-cookie"].lower()
    finally:
        get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Cabeceras de seguridad de la API (HSTS + CSP)
# ---------------------------------------------------------------------------


def _prod_client_no_vercel(monkeypatch):
    """App en modo producción en un host que NO es Vercel (Docker/Render)."""
    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.main import create_app

    monkeypatch.delenv("VERCEL_ENV", raising=False)
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("JWT_SECRET", "x" * 40)
    get_settings.cache_clear()
    return TestClient(create_app())


def test_api_sends_hsts_and_csp_when_not_on_vercel(monkeypatch):
    """Host propio (Docker/Render): la app debe poner HSTS y CSP ella misma."""
    try:
        client = _prod_client_no_vercel(monkeypatch)
        # Una ruta inexistente igual pasa por el middleware: sirve para ver
        # los headers sin tocar la DB.
        res = client.get("/ruta-que-no-existe")
        assert res.headers["strict-transport-security"] == (
            "max-age=31536000; includeSubDomains"
        )
        csp = res.headers["content-security-policy"]
        # La API no ejecuta JavaScript: la política estricta cierra el XSS.
        assert "default-src 'none'" in csp
        assert "frame-ancestors 'none'" in csp
    finally:
        from app.core.config import get_settings

        get_settings.cache_clear()


def test_app_does_not_duplicate_csp_on_vercel(monkeypatch):
    """En Vercel vercel.json ya pone HSTS/CSP: la función no debe duplicarlas."""
    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.main import create_app

    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.setenv("JWT_SECRET", "x" * 40)
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    get_settings.cache_clear()
    try:
        client = TestClient(create_app())
        res = client.get("/ruta-que-no-existe")
        # El middleware base sigue: nosniff va, pero CSP/HSTS los pone el borde.
        assert res.headers["x-content-type-options"] == "nosniff"
        assert "content-security-policy" not in res.headers
    finally:
        get_settings.cache_clear()


def test_api_csp_present_outside_production_but_no_hsts(monkeypatch):
    """En local la CSP también va; HSTS no (forzaría https en localhost)."""
    monkeypatch.delenv("VERCEL_ENV", raising=False)
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "local")

    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.main import create_app

    get_settings.cache_clear()
    try:
        client = TestClient(create_app())
        res = client.get("/ruta-que-no-existe")
        assert "content-security-policy" in res.headers
        assert "strict-transport-security" not in res.headers
    finally:
        get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Registro de actividad sospechosa
# ---------------------------------------------------------------------------


def test_failed_login_is_logged_as_security_event(api, caplog):
    with caplog.at_level(logging.WARNING, logger="ticketflow.observability"):
        res = api.client.post(
            "/auth/login",
            json={"email": api.world["admin"]["email"], "password": "clave-mala"},
        )
    assert res.status_code == 401
    assert any(
        "security_event kind=login_failed" in r.getMessage()
        and "reason=bad_password" in r.getMessage()
        for r in caplog.records
    ), [r.getMessage() for r in caplog.records]


def test_cross_origin_mutation_is_logged(api, caplog):
    api.token("admin")  # establece la cookie de sesión
    with caplog.at_level(logging.WARNING, logger="ticketflow.observability"):
        res = api.client.patch(
            "/auth/profile",
            json={"full_name": "Intruso"},
            headers={"Origin": "https://attacker.invalid"},
        )
    assert res.status_code == 403
    assert any(
        "security_event kind=cross_origin_rejected" in r.getMessage()
        for r in caplog.records
    ), [r.getMessage() for r in caplog.records]
