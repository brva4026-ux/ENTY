"""Lockout de login en DB (mig 016): 8 fallos en 15 min bloquean 15 min.

A diferencia del lockout viejo (dict en memoria por instancia), estos tests
verifican el contrato compartido: la tabla `login_attempts` y las funciones
SQL. Los tests de API usan la misma DB de prueba que el lockout consulta, así
que el bloqueo cruza requests (como en producción, donde cruza lambdas).

Nota: los tests de API comparten IP de TestClient, así que los cubos por IP
se controlan limpiando la tabla entre escenarios.
"""
import pytest


def _cleanup(db):
    db.execute("DELETE FROM login_attempts")


def test_lockout_by_email_after_8_failures(db):
    _cleanup(db)
    ip = "203.0.113.10"
    email = "hammered@example.com"

    for _ in range(8):
        db.execute("SELECT register_login_failure(%s, %s)", (email, ip))

    locked = db.execute(
        "SELECT login_locked(%s, %s) AS locked", (email, ip)
    ).fetchone()["locked"]
    assert locked is True

    # Otro email desde otra IP sigue entrando (el cubo es del atacante).
    other = db.execute(
        "SELECT login_locked('legitimo@example.com', '198.51.100.2') AS locked"
    ).fetchone()["locked"]
    assert other is False


def test_lockout_by_ip_anti_spray(db):
    _cleanup(db)
    ip = "203.0.113.11"
    for i in range(8):
        db.execute(
            "SELECT register_login_failure(%s, %s)",
            (f"spray-{i}@example.com", ip),
        )

    # Un email nuevo desde la IP quemada también queda bloqueado.
    locked = db.execute(
        "SELECT login_locked('nuevo@example.com', %s) AS locked", (ip,)
    ).fetchone()["locked"]
    assert locked is True


def test_clear_failures_only_removes_exact_pair(db):
    _cleanup(db)
    db.execute("SELECT register_login_failure('a@example.com', '203.0.113.12')")
    db.execute("SELECT register_login_failure('b@example.com', '203.0.113.12')")

    db.execute("SELECT clear_login_failures('a@example.com', '203.0.113.12')")

    left = db.execute(
        "SELECT email_norm FROM login_attempts WHERE ip = '203.0.113.12'"
    ).fetchall()
    assert [r["email_norm"] for r in left] == ["b@example.com"]


def test_api_login_locks_after_repeated_failures(api, db):
    """El login real consulta el mismo cubo: 8 fallos HTTP => 429."""
    _cleanup(db)
    s = api.scenario()
    wrong = {
        "email": api.world["admin"]["email"],
        "password": "contra-equivocada",
    }

    last = None
    for _ in range(8):
        last = api.client.post("/auth/login", json=wrong)
        assert last.status_code == 401

    # El 9no intento (incluso con la contraseña CORRECTA) está bloqueado.
    blocked = api.client.post(
        "/auth/login",
        json={
            "email": api.world["admin"]["email"],
            "password": api.world["password"],
        },
    )
    assert blocked.status_code == 429, blocked.text
    _cleanup(db)


def test_api_success_clears_only_that_pair(api, db):
    """Acertar la contraseña limpia el cubo del par (email, ip)."""
    _cleanup(db)
    s = api.scenario()
    creds = {
        "email": api.world["admin"]["email"],
        "password": api.world["password"],
    }

    # 3 fallos y luego el acierto.
    for _ in range(3):
        api.client.post(
            "/auth/login", json={**creds, "password": "mala"}
        )
    ok = api.client.post("/auth/login", json=creds)
    assert ok.status_code == 200

    remaining = db.execute(
        "SELECT count(*) AS n FROM login_attempts WHERE email_norm = lower(%s)",
        (creds["email"],),
    ).fetchone()["n"]
    assert remaining == 0
    _cleanup(db)
