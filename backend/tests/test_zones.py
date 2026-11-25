"""Aforo por zona: la pista puede tener cupo y el VIP estar lleno."""
import uuid


def _tag() -> str:
    return uuid.uuid4().hex[:8]


def _night(api, *, capacity=10):
    venue = api.world["venue_a"]
    ev = api.create_event(
        "admin", venue, name=f"Zonas {_tag()}", capacity=capacity
    )
    api.publish("admin", venue, ev["id"])
    api.run_sql(
        f"UPDATE events SET starts_at = now() - interval '1 hour' WHERE id = {ev['id']}"
    )
    assert api.post(f"/venues/{venue}/events/{ev['id']}/live", "admin").status_code == 200
    return venue, ev["id"]


def _zone(api, venue, event, *, name, capacity, sort_order=0):
    res = api.post(
        f"/venues/{venue}/events/{event}/zones",
        "admin",
        {"name": name, "capacity": capacity, "sort_order": sort_order},
    )
    assert res.status_code == 201, res.text
    return res.json()


def _type(api, venue, event, *, name, quantity=5, zone_id=None):
    res = api.post(
        f"/venues/{venue}/events/{event}/types",
        "admin",
        {
            "name": name,
            "price_cents": 50000,
            "quantity": quantity,
            "is_courtesy": False,
            "zone_id": zone_id,
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def _sell(api, venue, event, type_id, name):
    res = api.post(
        f"/venues/{venue}/events/{event}/tickets",
        "admin",
        {
            "ticket_type_id": type_id,
            "customer_name": name,
            "customer_phone": "3001234567",
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def _scan(api, venue, event, token):
    return api.post(
        f"/venues/{venue}/events/{event}/redeem",
        "bouncer",
        {"raw_token": token},
    )


def test_zone_capacity_blocks_only_that_zone(api):
    venue, event = _night(api, capacity=10)
    vip = _zone(api, venue, event, name="VIP", capacity=1)
    pista = _zone(api, venue, event, name="Pista", capacity=10)
    vip_type = _type(api, venue, event, name="VIP", quantity=3, zone_id=vip["id"])
    pista_type = _type(api, venue, event, name="General", quantity=5, zone_id=pista["id"])

    vip_a = _sell(api, venue, event, vip_type["id"], "Ana")
    vip_b = _sell(api, venue, event, vip_type["id"], "Beto")
    pista_a = _sell(api, venue, event, pista_type["id"], "Caro")

    first = _scan(api, venue, event, vip_a["raw_token"])
    assert first.status_code == 200, first.text
    assert first.json()["code"] == "GRANTED"

    blocked = _scan(api, venue, event, vip_b["raw_token"])
    assert blocked.status_code == 200, blocked.text
    assert blocked.json()["code"] == "ZONE_CAPACITY_REACHED"
    assert "VIP" in blocked.json()["detail"]

    # La pista sigue abierta: el tope es de la zona, no del recinto.
    allowed = _scan(api, venue, event, pista_a["raw_token"])
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["code"] == "GRANTED"

    zones = api.get(f"/venues/{venue}/events/{event}/zones", "admin").json()
    by_name = {z["name"]: z for z in zones}
    assert by_name["VIP"]["inside"] == 1
    assert by_name["VIP"]["status"] == "full"
    assert by_name["VIP"]["free_seats"] == 0
    assert by_name["VIP"]["ticket_type_names"] == ["VIP"]
    assert by_name["Pista"]["inside"] == 1
    assert by_name["Pista"]["status"] == "open"


def test_zone_capacity_blocks_across_different_localities(api):
    venue, event = _night(api, capacity=10)
    vip = _zone(api, venue, event, name="VIP", capacity=1)
    early = _type(api, venue, event, name="VIP Early", quantity=2, zone_id=vip["id"])
    late = _type(api, venue, event, name="VIP Late", quantity=2, zone_id=vip["id"])

    one = _sell(api, venue, event, early["id"], "Ana")
    two = _sell(api, venue, event, late["id"], "Beto")
    assert _scan(api, venue, event, one["raw_token"]).json()["code"] == "GRANTED"
    blocked = _scan(api, venue, event, two["raw_token"])
    assert blocked.json()["code"] == "ZONE_CAPACITY_REACHED"


def test_door_context_receives_zone_status(api):
    venue, event = _night(api, capacity=10)
    vip = _zone(api, venue, event, name="VIP", capacity=1)
    _type(api, venue, event, name="VIP", quantity=2, zone_id=vip["id"])
    _type(api, venue, event, name="General", quantity=2)

    res = api.get(f"/venues/{venue}/events/{event}/door-context", "admin")
    assert res.status_code == 200, res.text
    data = res.json()
    assert [z["name"] for z in data["zones"]] == ["VIP"]
    assert data["zones"][0]["status"] == "open"
    assert data["zones"][0]["free_seats"] == 1


def test_zone_crud_and_assignment(api):
    venue, event = _night(api)
    zone = _zone(api, venue, event, name="Terraza", capacity=20)
    tipo = _type(api, venue, event, name="Terraza", quantity=10, zone_id=zone["id"])
    assert tipo["zone_id"] == zone["id"]
    assert tipo["zone_name"] == "Terraza"

    updated = api.patch(
        f"/venues/{venue}/events/{event}/zones/{zone['id']}",
        "admin",
        {"name": "Terraza Norte", "capacity": 25},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "Terraza Norte"
    assert updated.json()["capacity"] == 25

    # No se borra una zona con localidades: primero se reasignan.
    blocked = api.delete(
        f"/venues/{venue}/events/{event}/zones/{zone['id']}", "admin"
    )
    assert blocked.status_code == 409, blocked.text

    moved = api.patch(
        f"/venues/{venue}/events/{event}/types/{tipo['id']}",
        "admin",
        {"zone_id": None},
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["zone_id"] is None

    deleted = api.delete(
        f"/venues/{venue}/events/{event}/zones/{zone['id']}", "admin"
    )
    assert deleted.status_code == 200, deleted.text
    assert api.get(f"/venues/{venue}/events/{event}/zones", "admin").json() == []


def test_zones_are_admin_only_for_writes(api):
    venue, event = _night(api)
    assert api.post(
        f"/venues/{venue}/events/{event}/zones",
        "promoter",
        {"name": "VIP", "capacity": 5},
    ).status_code == 403
    assert api.post(
        f"/venues/{venue}/events/{event}/zones",
        "admin",
        {"name": "VIP", "capacity": 5},
    ).status_code == 201
    assert api.get(f"/venues/{venue}/events/{event}/zones", "bouncer").status_code == 200
