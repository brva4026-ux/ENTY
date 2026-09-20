"""Hardening P0 (mig 019): sesiones revocables, auditoria y rate limit.

Lo que ya estaba blindado no se repite aqui (test_api_permissions.py cubre
IDOR entre venues y por rol; redeem es CAS atómico desde la 002). Estos tests
cubren lo NUEVO:

- Cambiar/resetear la contraseña mata TODAS las sesiones vivas (token_version).
- Cambios de dinero (precio de tipo, cupo) dejan rastro con antes/despues.
- Cada export CSV deja rastro (quien, cuando, cuantas filas).
- El escaneo en puerta tiene rate limit (anti spam, no anti fuerza bruta:
  para eso el token de 192 bits ya es suficiente).
"""
import pytest


# ---------------------------------------------------------------------------
# token_version: revocacion de sesiones
# ---------------------------------------------------------------------------


def test_password_change_revokes_old_sessions(api):
    """Sesiones abiertas en otro dispositivo mueren al cambiar la clave."""
    who = "promoter"
    old_token = api.token(who)  # sesion A
    assert api.get("/auth/me", who).status_code == 200

    res = api.client.post(
        "/auth/change-password",
        headers={"Authorization": f"Bearer {old_token}"},
        json={
            "current_password": api.world["password"],
            "new_password": "Nueva-Clave-456",
        },
    )
    assert res.status_code == 200, res.text

    # La sesion A ya no sirve.
    dead = api.client.get(
        "/auth/me", headers={"Authorization": f"Bearer {old_token}"}
    )
    assert dead.status_code == 401

    # La nueva clave entra y emite sesion viva.
    login = api.client.post(
        "/auth/login",
        json={
            "email": api.world[who]["email"],
            "password": "nueva-clave-456",
        },
    )
    assert login.status_code == 200


def test_admin_reset_revokes_target_sessions(api):
    """Reset del admin: el usuario reseteado no conserva sesiones vivas."""
    who = "promoter"
    old_token = api.token(who)
    uid = api.world[who]["id"]
    venue = api.world["venue_a"]

    res = api.post(
        f"/venues/{venue}/users/{uid}/reset-password",
        "admin",
        {"new_password": "Clave-Admin-789"},
    )
    assert res.status_code == 200, res.text

    dead = api.client.get(
        "/auth/me", headers={"Authorization": f"Bearer {old_token}"}
    )
    assert dead.status_code == 401


# ---------------------------------------------------------------------------
# audit_log: dinero y exportaciones
# ---------------------------------------------------------------------------


def test_price_change_is_audited(dbcur, api):
    """Cambiar el precio de un tipo deja antes/despues con quien lo hizo."""
    scen = api.scenario()
    ttype = api.types("admin", scen["venue"], scen["event"])[0]
    before_price = ttype["price_cents"]

    res = api.patch(
        api.type_url(scen["venue"], scen["event"], scen["type"]),
        "admin",
        {"price_cents": before_price + 5000},
    )
    assert res.status_code == 200, res.text

    dbcur.execute(
        """SELECT actor_id, details FROM audit_log
           WHERE kind = 'ticket_type_change' AND entity_id = %s
           ORDER BY id DESC LIMIT 1""",
        (scen["type"],),
    )
    row = dbcur.fetchone()
    assert row is not None
    assert row["actor_id"] == api.world["admin"]["id"]
    ch = row["details"]["cambios"]["price_cents"]
    assert ch["antes"] == before_price
    assert ch["despues"] == before_price + 5000


def test_price_change_without_diff_is_not_audited(dbcur, api):
    """Un PATCH que no cambia nada de dinero no ensucia el log."""
    scen = api.scenario()
    api.patch(
        api.type_url(scen["venue"], scen["event"], scen["type"]),
        "admin",
        {"name": "Solo renombro"},
    )
    dbcur.execute(
        "SELECT count(*)::int AS n FROM audit_log WHERE entity_id = %s",
        (scen["type"],),
    )
    assert dbcur.fetchone()["n"] == 0


def test_allocation_change_is_audited(dbcur, api):
    """Mover el cupo de un promotor deja rastro."""
    scen = api.scenario()
    res = api.patch(
        api.allocation_url(scen["venue"], scen["event"], scen["allocation"]["id"]),
        "admin",
        {"capacity": 99},
    )
    assert res.status_code == 200, res.text

    dbcur.execute(
        """SELECT details FROM audit_log
           WHERE kind = 'allocation_change' AND entity_id = %s
           ORDER BY id DESC LIMIT 1""",
        (scen["allocation"]["id"],),
    )
    row = dbcur.fetchone()
    assert row is not None
    assert row["details"]["capacity"]["despues"] == 99


def test_csv_export_is_audited(dbcur, api):
    """Cada export CSV de boletas queda registrado con su conteo."""
    scen = api.scenario()
    ttype = api.types("admin", scen["venue"], scen["event"])[0]
    api.emit(
        "promoter", scen["venue"], scen["event"],
        ticket_type_id=ttype["id"], allocation_id=scen["allocation"]["id"],
        customer_name="Exportado",
    )

    res = api.get(
        f"/venues/{scen['venue']}/events/{scen['event']}/tickets?format=csv",
        "admin",
    )
    assert res.status_code == 200

    dbcur.execute(
        """SELECT actor_id, details FROM audit_log
           WHERE kind = 'export' AND entity = 'tickets_csv'
             AND entity_id = %s ORDER BY id DESC LIMIT 1""",
        (scen["event"],),
    )
    row = dbcur.fetchone()
    assert row is not None
    assert row["actor_id"] == api.world["admin"]["id"]
    assert row["details"]["filas"] >= 1


def test_csv_export_cut_for_promoter(dbcur, api):
    """IDOR del export: el CSV del promotor solo trae lo SUYO."""
    scen = api.scenario()
    ttype = api.types("admin", scen["venue"], scen["event"])[0]
    api.emit(
        "promoter", scen["venue"], scen["event"],
        ticket_type_id=ttype["id"], allocation_id=scen["allocation"]["id"],
        customer_name="De Promo Uno",
    )

    res = api.get(
        f"/venues/{scen['venue']}/events/{scen['event']}/tickets?format=csv",
        "promoter2",
    )
    assert res.status_code == 200
    assert "De Promo Uno" not in res.text

    dbcur.execute(
        """SELECT details FROM audit_log
           WHERE kind = 'export' AND entity = 'tickets_csv'
             AND entity_id = %s ORDER BY id DESC LIMIT 1""",
        (scen["event"],),
    )
    assert dbcur.fetchone()["details"]["filas"] == 0


# ---------------------------------------------------------------------------
# rate limit de escaneos
# ---------------------------------------------------------------------------


def test_redeem_rate_limited_after_burst(dbcur, api):
    """40 escaneos/10 s por usuario: el 41 llega con 429."""
    scen = api.scenario()
    bouncer_id = api.world["bouncer"]["id"]

    ttype = api.types("admin", scen["venue"], scen["event"])[0]
    t = api.emit(
        "promoter", scen["venue"], scen["event"],
        ticket_type_id=ttype["id"], allocation_id=scen["allocation"]["id"],
    )

    # 40 escaneos sinteticos recientes del mismo bouncer (boleta real: FK).
    dbcur.execute(
        """INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
           SELECT %s, %s, %s, 'not_found' FROM generate_series(1, 40)""",
        (t["id"], scen["event"], bouncer_id),
    )

    res = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/redeem",
        "bouncer",
        {"raw_token": "x" * 32},
    )
    assert res.status_code == 429


def test_redeem_below_limit_passes_rate_check(dbcur, api):
    """Con pocos escaneos recientes el limite no estorba (pasa a la logica)."""
    scen = api.scenario()
    bouncer_id = api.world["bouncer"]["id"]

    ttype = api.types("admin", scen["venue"], scen["event"])[0]
    t = api.emit(
        "promoter", scen["venue"], scen["event"],
        ticket_type_id=ttype["id"], allocation_id=scen["allocation"]["id"],
    )

    dbcur.execute(
        """INSERT INTO redemptions (ticket_id, event_id, scanned_by_user_id, outcome)
           SELECT %s, %s, %s, 'not_found' FROM generate_series(1, 3)""",
        (t["id"], scen["event"], bouncer_id),
    )

    # Token invalido pero el 429 NO aparece: el limite no fue el problema.
    res = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/redeem",
        "bouncer",
        {"raw_token": "x" * 32},
    )
    assert res.status_code != 429
