"""Permisos por rol y aislamiento multi-tenant, a nivel de endpoints.

La matriz de roles es la del backend (`ensure_roles`):
  * admin    -> gestiona evento, tipos, cupos, equipo y anulación
  * promotor -> emite boletas dentro de su cupo
  * bouncer  -> valida boletas en puerta

Además: un usuario con rol en la venue B no puede leer ni operar la venue A,
aunque sea admin en la suya.
"""
import pytest


def test_endpoints_require_a_token(api_client, world):
    res = api_client.get(f"/venues/{world['venue_a']}/events")
    assert res.status_code == 401


def test_admin_can_read_own_venue(api):
    scen = api.scenario()
    res = api.get(f"/venues/{scen['venue']}/events", "admin")
    assert res.status_code == 200
    assert any(ev["id"] == scen["event"] for ev in res.json())


@pytest.mark.parametrize("who", ["promoter", "promoter2", "bouncer"])
def test_venue_members_can_list_events(api, who):
    """Ver el calendario es para cualquier miembro de la venue."""
    scen = api.scenario()
    assert api.get(f"/venues/{scen['venue']}/events", who).status_code == 200


def test_outsider_admin_cannot_touch_other_venue(api, world):
    """Aislamiento entre venues: admin de B no ve ni opera A."""
    other = world["venue_a"]
    assert api.get(f"/venues/{other}/events", "outsider").status_code == 403
    assert api.get(f"/venues/{other}/users", "outsider").status_code == 403

    res = api.post(
        f"/venues/{other}/events",
        "outsider",
        {"name": "Intruso", "starts_at": "2026-10-02T20:00:00+00:00", "capacity": 10},
    )
    assert res.status_code == 403


@pytest.mark.parametrize("who", ["promoter", "bouncer", "outsider"])
def test_event_management_is_admin_only(api, who):
    """Tipos, cupos y listado de boletas quedan fuera del alcance de los demás roles."""
    scen = api.scenario()

    assert (
        api.post(
            f"/venues/{scen['venue']}/events",
            who,
            {"name": "Otro evento", "starts_at": "2026-10-02T20:00:00+00:00", "capacity": 10},
        ).status_code
        == 403
    )
    assert (
        api.post(
            f"/venues/{scen['venue']}/events/{scen['event']}/types",
            who,
            {"name": "VIP", "price_cents": 0, "quantity": 5, "is_courtesy": True},
        ).status_code
        == 403
    )
    assert (
        api.post(
            f"/venues/{scen['venue']}/events/{scen['event']}/allocations",
            who,
            {"ticket_type_id": scen["type"], "promoter_id": 1, "capacity": 1},
        ).status_code
        == 403
    )
    assert api.get(f"/venues/{scen['venue']}/events/{scen['event']}/tickets", who).status_code == 403


def test_ticket_roles_are_scoped(api):
    """El bouncer no emite boletas y el promotor no redime en puerta."""
    scen = api.scenario()

    emit_res = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/tickets",
        "bouncer",
        {"ticket_type_id": scen["type"], "customer_name": "X", "customer_phone": "3001234567"},
    )
    assert emit_res.status_code == 403

    redeem_res = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/redeem",
        "promoter",
        {"raw_token": "abcdefghijklmnop"},
    )
    assert redeem_res.status_code == 403


def test_bouncer_has_its_own_permissions(api):
    """Contra-prueba: el bouncer sí puede ver el reporte y validar en puerta."""
    scen = api.scenario()

    report = api.get(f"/venues/{scen['venue']}/events/{scen['event']}/report", "bouncer")
    assert report.status_code == 200
    assert report.json()["event_id"] == scen["event"]

    redeem = api.post(
        f"/venues/{scen['venue']}/events/{scen['event']}/redeem",
        "bouncer",
        {"raw_token": "token-que-no-existe-123"},
    )
    assert redeem.status_code == 200
    assert redeem.json()["code"] == "NOT_FOUND"
