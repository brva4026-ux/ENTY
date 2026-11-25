"""Suite operativa y comercial (mig 071)."""
import uuid


def _tag():
    return uuid.uuid4().hex[:6]


def _event(api, *, capacity=20, publish=True):
    venue = api.world["venue_a"]
    ev = api.create_event(
        "admin", venue, name=f"Suite {_tag()}", capacity=capacity
    )
    if publish:
        api.publish("admin", venue, ev["id"])
    return venue, ev["id"]


def _type(api, venue, event, *, name="General", quantity=20, price=50000):
    res = api.post(
        f"/venues/{venue}/events/{event}/types",
        "admin",
        {
            "name": name,
            "price_cents": price,
            "quantity": quantity,
            "is_courtesy": False,
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def _sell(api, venue, event, type_id, name="Ana"):
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
    data = res.json()
    return {"id": data["ticket_id"], **data}


def test_transport_map_and_public_extras(api):
    venue, event = _event(api)
    res = api.post(
        f"/venues/{venue}/events/{event}/transport",
        "admin",
        {"kind": "recogida", "name": "Parque de la 93", "schedule": "23:30"},
    )
    assert res.status_code == 201, res.text
    point = res.json()

    res = api.post(
        f"/venues/{venue}/events/{event}/map-points",
        "admin",
        {"kind": "encuentro", "name": "Punto de encuentro", "accessible": True},
    )
    assert res.status_code == 201, res.text

    public = api.client.get(f"/public/events/{event}/extras")
    assert public.status_code == 200, public.text
    assert public.json()["transport"][0]["name"] == "Parque de la 93"
    assert public.json()["map_points"][0]["accessible"] is True

    deleted = api.delete(
        f"/venues/{venue}/events/{event}/transport/{point['id']}", "admin"
    )
    assert deleted.status_code == 200, deleted.text


def test_checkout_recovery_link(api):
    venue, event = _event(api)
    tipo = _type(api, venue, event)
    res = api.client.post(
        f"/public/events/{event}/recover-checkout",
        json={
            "ticket_type_id": tipo["id"],
            "customer_name": "Ana",
            "customer_phone": "3001234567",
        },
    )
    assert res.status_code == 201, res.text
    token = res.json()["token"]
    read = api.client.get(f"/public/checkout-recovery/{token}")
    assert read.status_code == 200, read.text
    assert read.json()["price_cents"] == 50000
    assert read.json()["available"] == 20
    used = api.client.post(f"/public/checkout-recovery/{token}/use")
    assert used.status_code == 200, used.text
    assert api.client.get(f"/public/checkout-recovery/{token}").status_code == 410


def test_shifts_checkin_and_ops(api):
    venue, event = _event(api)
    shifts = api.get(f"/venues/{venue}/events/{event}/shifts", "admin")
    assert shifts.status_code == 200, shifts.text
    assert isinstance(shifts.json(), list)

    res = api.post(
        f"/venues/{venue}/events/{event}/staff-checkin",
        "bouncer",
        {"note": "Llegué"},
    )
    assert res.status_code == 201, res.text
    checkin = res.json()
    assert api.post(
        f"/venues/{venue}/events/{event}/staff-checkin", "bouncer", {}
    ).status_code == 409
    out = api.post(
        f"/venues/{venue}/events/{event}/staff-checkins/{checkin['id']}/checkout",
        "bouncer",
        {},
    )
    assert out.status_code == 200, out.text

    order = api.post(
        f"/venues/{venue}/events/{event}/ops-orders",
        "admin",
        {"message": "Cerrar la puerta lateral", "target": "Puerta 2"},
    )
    assert order.status_code == 201, order.text
    oid = order.json()["id"]
    ack = api.post(
        f"/venues/{venue}/events/{event}/ops-orders/{oid}/ack", "bouncer", {}
    )
    assert ack.status_code == 200, ack.text
    listed = api.get(f"/venues/{venue}/events/{event}/ops-orders", "admin").json()
    assert listed[0]["acks"][0]["user_id"] == api.world["bouncer"]["id"]


def test_equipment_bookings_milestones_documents(api):
    venue, event = _event(api)
    eq = api.post(
        f"/venues/{venue}/events/{event}/equipment",
        "admin",
        {"item_name": "Radio", "serial": "R-1"},
    )
    assert eq.status_code == 201, eq.text
    returned = api.patch(
        f"/venues/{venue}/events/{event}/equipment/{eq.json()['id']}",
        "admin",
        {"status": "devuelto"},
    )
    assert returned.status_code == 200, returned.text
    assert returned.json()["returned_at"] is not None

    booking = api.post(
        f"/venues/{venue}/bookings",
        "admin",
        {
            "title": "Montaje",
            "starts_at": "2027-01-10T10:00:00Z",
            "ends_at": "2027-01-10T18:00:00Z",
        },
    )
    assert booking.status_code == 201, booking.text
    clash = api.post(
        f"/venues/{venue}/bookings",
        "admin",
        {
            "title": "Otro",
            "starts_at": "2027-01-10T12:00:00Z",
            "ends_at": "2027-01-10T20:00:00Z",
        },
    )
    assert clash.status_code == 409, clash.text

    milestone = api.post(
        f"/venues/{venue}/events/{event}/milestones",
        "admin",
        {"title": "Cerrar lineup", "due_date": "2027-01-01"},
    )
    assert milestone.status_code == 201, milestone.text
    done = api.patch(
        f"/venues/{venue}/events/{event}/milestones/{milestone.json()['id']}",
        "admin",
        {"title": "Cerrar lineup", "due_date": "2027-01-01", "status": "hecho"},
    )
    assert done.status_code == 200, done.text
    assert done.json()["completed_at"] is not None

    doc = api.post(
        f"/venues/{venue}/events/{event}/documents",
        "admin",
        {"title": "Rider", "url": "https://example.com/rider.pdf"},
    )
    assert doc.status_code == 201, doc.text
    assert len(api.get(f"/venues/{venue}/events/{event}/documents", "bouncer").json()) == 1


def test_courtesy_approval_checks_capacity(api):
    venue, event = _event(api, capacity=10)
    tipo = _type(api, venue, event, quantity=2)
    req = api.post(
        f"/venues/{venue}/events/{event}/courtesy-requests",
        "promoter",
        {"ticket_type_id": tipo["id"], "quantity": 1, "reason": "Prensa"},
    )
    assert req.status_code == 201, req.text
    approved = api.post(
        f"/venues/{venue}/events/{event}/courtesy-requests/{req.json()['id']}/review",
        "admin",
        {"status": "aprobada"},
    )
    assert approved.status_code == 200, approved.text

    big = api.post(
        f"/venues/{venue}/events/{event}/courtesy-requests",
        "promoter",
        {"ticket_type_id": tipo["id"], "quantity": 5, "reason": "Equipo"},
    )
    blocked = api.post(
        f"/venues/{venue}/events/{event}/courtesy-requests/{big.json()['id']}/review",
        "admin",
        {"status": "aprobada"},
    )
    assert blocked.status_code == 409, blocked.text


def test_change_ticket_and_upgrade(api):
    venue, event = _event(api, capacity=10)
    general = _type(api, venue, event, name="General", quantity=10, price=50000)
    vip = _type(api, venue, event, name="VIP", quantity=5, price=90000)
    ticket = _sell(api, venue, event, general["id"])

    res = api.post(
        f"/venues/{venue}/events/{event}/tickets/{ticket['id']}/change",
        "admin",
        {"new_event_id": event, "new_type_id": vip["id"], "reason": "Upgrade"},
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["kind"] == "upgrade"
    assert data["amount_due_cents"] == 40000
    assert data["raw_token"]
    old = api.run_sql(
        f"SELECT status FROM tickets WHERE id={ticket['id']}"
    )
    assert old == "voided"


def test_resale_voids_old_qr(api):
    venue, event = _event(api)
    tipo = _type(api, venue, event)
    ticket = _sell(api, venue, event, tipo["id"], "Vendedor")
    resale = api.post(
        f"/venues/{venue}/events/{event}/resales",
        "admin",
        {"ticket_id": ticket["id"], "price_cents": 40000, "seller_name": "Vendedor"},
    )
    assert resale.status_code == 201, resale.text
    assert api.client.get(f"/public/events/{event}/resales").json()[0]["price_cents"] == 40000
    sold = api.post(
        f"/venues/{venue}/events/{event}/resales/{resale.json()['id']}/sell",
        "admin",
        {"buyer_name": "Comprador", "buyer_phone": "3009999999"},
    )
    assert sold.status_code == 200, sold.text
    assert sold.json()["raw_token"]
    old = api.run_sql(
        f"SELECT status FROM tickets WHERE id={ticket['id']}"
    )
    assert old == "voided"


def test_forecast_and_bundle(api):
    venue, event = _event(api, capacity=10)
    _type(api, venue, event)
    forecast = api.get(f"/venues/{venue}/events/{event}/forecast", "admin")
    assert forecast.status_code == 200, forecast.text
    assert forecast.json()["capacity"] == 10

    parent = api.create_event("admin", venue, name=f"Bundle {_tag()}", capacity=20)
    child_a = api.create_event("admin", venue, name=f"Noche A {_tag()}", capacity=10)
    child_b = api.create_event("admin", venue, name=f"Noche B {_tag()}", capacity=10)
    api.publish("admin", venue, child_a["id"])
    api.publish("admin", venue, child_b["id"])
    bundle = api.post(
        f"/venues/{venue}/events/{parent['id']}/bundle",
        "admin",
        {
            "name": "Abono dos noches",
            "event_ids": [child_a["id"], child_b["id"]],
            "price_cents": 80000,
            "quantity": 10,
        },
    )
    assert bundle.status_code == 201, bundle.text
    assert len(bundle.json()["events"]) == 2
